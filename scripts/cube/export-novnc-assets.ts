import { config as dotenvConfig } from 'dotenv';
import { spawnSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { access, mkdir, readFile, readdir, realpath, stat, writeFile } from 'node:fs/promises';
import { resolve, sep } from 'node:path';

const envPath = process.env.CSA_SUPER_AGENT_ENV_PATH;
if (envPath) dotenvConfig({ path: envPath, override: false });

const tenantSlug = process.env.CSA_DIAGNOSTIC_TENANT_SLUG || 'beta';
const targetDir = resolve(process.cwd(), 'public/novnc');
const remoteArchive = `/tmp/csa-novnc-assets-${randomUUID()}.tar.gz`;
const { pool } = await import('../../src/server/db.ts');
const { Sandbox } = await import('@cubesandbox/sdk');
const { cubeConfig } = await import('../../src/server/computer.ts');
const { decryptSandboxTrafficToken } = await import('../../src/server/token-crypto.ts');

interface ComputerRow {
  id: string;
  sandbox_id: string | null;
  cube_traffic_token_ciphertext: string | null;
  state: string;
}

let sandbox: InstanceType<typeof Sandbox> | undefined;
try {
  const [rows] = await pool.query(
    'SELECT t.id, c.sandbox_id, c.cube_traffic_token_ciphertext, c.state FROM tenants t JOIN computers c ON c.tenant_id = t.id WHERE t.slug = ? LIMIT 1',
    [tenantSlug],
  );
  const computer = (rows as ComputerRow[])[0];
  if (!computer?.sandbox_id || !computer.cube_traffic_token_ciphertext || computer.state !== 'running') {
    throw new Error('The selected tenant must have a running microVM and a stored traffic token.');
  }

  const [activeRows] = await pool.query(
    "SELECT COUNT(*) AS active_count FROM runs WHERE tenant_id = ? AND status IN ('queued', 'working')",
    [computer.id],
  );
  if (Number((activeRows as Array<{ active_count: number }>)[0]?.active_count || 0) !== 0) {
    throw new Error('The selected tenant has an active Agent run; refusing asset export.');
  }

  sandbox = await Sandbox.connect(computer.sandbox_id, { config: cubeConfig() });
  if (!sandbox.trafficAccessToken) {
    const authenticated = new Sandbox({
      sandboxID: sandbox.sandboxId,
      templateID: sandbox.templateId,
      domain: sandbox.domain,
      trafficAccessToken: decryptSandboxTrafficToken(computer.cube_traffic_token_ciphertext),
      envdAccessToken: sandbox.envdAccessToken,
    }, sandbox.config);
    sandbox.close();
    sandbox = authenticated;
  }

  const metadata = await sandbox.commands.run([
    'set -eu',
    "dpkg-query -s novnc | awk -F': ' '$1 == \"Version\" {print \"novnc.version=\" $2}'",
    "test -r /usr/share/doc/novnc/copyright",
    `tar -czf '${remoteArchive}' -C /usr/share/novnc .`,
    `stat -c 'novnc.archive.bytes=%s' '${remoteArchive}'`,
    'du -sh /usr/share/novnc',
    'find /usr/share/novnc -type f | wc -l',
    'find /usr/share/novnc -type l -print',
  ].join('\n'), { timeoutMs: 30_000 });
  if (metadata.exitCode !== 0) throw new Error('Could not package the guest noVNC application assets: ' + metadata.stderr.slice(-800));
  const packageVersion = metadata.stdout.match(/^novnc\.version=(\S+)$/m)?.[1];
  if (!packageVersion) throw new Error('The guest noVNC Debian package version was not reported.');

  const archive = Buffer.from(await sandbox.files.read(remoteArchive, { format: 'bytes' }));
  if (archive.byteLength === 0 || archive.byteLength > 16 * 1024 * 1024) throw new Error('The noVNC archive size is outside the expected 0–16 MiB range.');
  const listing = spawnSync('tar', ['-tzf', '-'], { input: archive, encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 });
  if (listing.status !== 0) throw new Error('Could not validate the noVNC archive paths: ' + String(listing.stderr || '').slice(-800));
  const entries = listing.stdout.split(/\r?\n/).filter(Boolean);
  for (const entry of entries) {
    const relative = entry.replace(/^\.\//, '').replace(/\/$/, '');
    if (!relative) continue;
    if (relative.startsWith('/') || relative.split('/').some(part => part === '..' || part === '.')) {
      throw new Error('The noVNC archive contains an unsafe path.');
    }
  }

  let targetExists = false;
  try { await access(targetDir); targetExists = true; }
  catch { targetExists = false; }
  if (targetExists) {
    const marker = await readFile(resolve(targetDir, 'SOURCE.md'), 'utf8').catch(() => '');
    if (!marker.includes('These noVNC application assets are copied from the `novnc` Debian package')) {
      throw new Error('public/novnc already exists and is not marked as this exporter output; refusing to overwrite it.');
    }
  } else {
    await mkdir(targetDir, { recursive: true });
  }
  const extracted = spawnSync('tar', ['-xzf', '-', '-C', targetDir], { input: archive, encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 });
  if (extracted.status !== 0) throw new Error('Could not extract noVNC assets: ' + String(extracted.stderr || '').slice(-800));

  const copyright = await sandbox.files.read('/usr/share/doc/novnc/copyright');
  await writeFile(resolve(targetDir, 'DEBIAN-COPYRIGHT.txt'), copyright, { mode: 0o644 });
  await writeFile(resolve(targetDir, 'SOURCE.md'), [
    'These noVNC application assets are copied from the `novnc` Debian package installed in the Coke Super Agent Beta microVM template.',
    '',
    'The installed package version and Debian copyright/license notices are recorded in `DEBIAN-COPYRIGHT.txt` and the template build output.',
    'Upstream project: https://github.com/novnc/noVNC',
    '',
  ].join('\n'), { mode: 0o644 });
  await writeFile(resolve(targetDir, 'package.json'), JSON.stringify({ name: 'novnc', version: packageVersion }, null, 2) + '\n', { mode: 0o644 });

  const expectedPaths = ['vnc.html', 'app/ui.js', 'core/rfb.js', 'vendor', 'package.json'];
  for (const path of expectedPaths) await access(resolve(targetDir, path));
  const totals = await countTree(targetDir);
  const digest = createHash('sha256').update(archive).digest('hex');
  process.stdout.write(JSON.stringify({
    status: 'exported',
    tenant: tenantSlug,
    remoteMetadata: metadata.stdout.trim().split(/\r?\n/),
    archiveBytes: archive.byteLength,
    archiveSha256: digest,
    archiveEntries: entries.length,
    extractedFiles: totals.files,
    extractedBytes: totals.bytes,
    target: targetDir,
  }) + '\n');
} finally {
  if (sandbox) {
    await sandbox.files.remove(remoteArchive).catch(() => undefined);
    sandbox.close();
  }
  await pool.end();
}

async function countTree(directory: string): Promise<{ files: number; bytes: number }> {
  let files = 0;
  let bytes = 0;
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = resolve(directory, entry.name);
    if (entry.isDirectory()) {
      const nested = await countTree(path);
      files += nested.files;
      bytes += nested.bytes;
    } else if (entry.isFile()) {
      if (!path.startsWith(directory + sep) && path !== directory) throw new Error('noVNC asset escaped its export directory.');
      files += 1;
      bytes += (await stat(path)).size;
    } else if (entry.isSymbolicLink()) {
      const target = await realpath(path);
      if (!target.startsWith(directory + sep)) throw new Error('A noVNC symlink escapes its export directory.');
      const info = await stat(target);
      if (!info.isFile()) throw new Error('The noVNC package contains a non-file symlink.');
      files += 1;
      bytes += info.size;
    } else {
      throw new Error('The noVNC package contains an unexpected filesystem entry.');
    }
  }
  return { files, bytes };
}
