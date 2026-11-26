import 'dotenv/config';
import { createHash, randomUUID } from 'node:crypto';
import { appendFileSync } from 'node:fs';
import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { Sandbox } from '@cubesandbox/sdk';
import { pool } from '../../src/server/db.ts';
import { cubeConfig } from '../../src/server/computer.ts';
import { decryptSandboxTrafficToken } from '../../src/server/token-crypto.ts';
import { runGuestPty } from '../../src/server/runtime-bundle.ts';

const tenantSlug = process.env.CSA_CHROME_PIPE_TENANT_SLUG || 'beta';
const expectedSandboxId = process.env.CSA_CHROME_PIPE_EXPECTED_SANDBOX_ID || '315bbf88bd0e497a92099d23845e7a55';
const expectedTemplateId = process.env.CSA_CHROME_PIPE_EXPECTED_TEMPLATE_ID || 'tpl-d92cea70efc040cfb32580f2';
const expectedStraceSha256 = '751817724af91cb95df566a21a154f9a7dcdd938e700e5cb9a5a47eb19752ea2';
const browserCommandTimeoutMs = Number(process.env.CSA_CHROME_PIPE_TIMEOUT_MS || '90000');
const guiModeValue = process.env.CSA_CHROME_PIPE_GUI || '1';
const traceStartupValue = process.env.CSA_CHROME_PIPE_TRACE_STARTUP || '0';
const straceMode = process.env.CSA_CHROME_PIPE_STRACE_MODE || 'pipe';
const profileRoot = process.env.CSA_CHROME_PIPE_PROFILE_ROOT || '';
const stracePackagePath = process.env.CSA_CHROME_PIPE_STRACE_PACKAGE
  || join(homedir(), '.local/share/csa-cube-node/runtime-cache/strace_6.1-0.1_arm64.deb');
const logDirectory = process.env.CSA_BUILD_LOG_DIR || join(homedir(), '.local/share/csa-cube-node/build-logs');
const runId = randomUUID();
const startedAt = Date.now();
const logPath = join(logDirectory, `existing-beta-pipe-strace-${new Date().toISOString().replace(/[:.]/g, '-')}-${runId}.jsonl`);
const sandboxIdPattern = /^[a-f0-9]{32}$/;
const shellQuote = (value: string): string => "'" + value.replace(/'/g, "'\\''") + "'";
const redact = (value: string): string => value
  .replace(/(https?:\/\/)[^/@\s]+:[^/@\s]+@/gi, '$1[redacted]@')
  .replace(/([?&](?:token|key|password|secret)=)[^&\s]+/gi, '$1[redacted]')
  .replace(/(DevTools listening on ws:\/\/)[^\s]+/g, '$1[redacted]')
  .replace(/(\/devtools\/browser\/)[A-Za-z0-9_-]+/g, '$1[redacted]');
let lastStage = 'started';

await mkdir(logDirectory, { recursive: true, mode: 0o700 });
await writeFile(logPath, '', { mode: 0o600 });
await chmod(logPath, 0o600);

function log(stage: string, fields: Record<string, unknown> = {}): void {
  if (!stage.endsWith('.failed')) lastStage = stage;
  const row = JSON.stringify({ timestamp: new Date().toISOString(), runId, elapsedMs: Date.now() - startedAt, stage, ...fields });
  process.stdout.write(row + '\n');
  appendFileSync(logPath, row + '\n', { mode: 0o600 });
}

function describeError(error: unknown, depth = 0): Record<string, unknown> {
  if (!(error instanceof Error)) return { name: 'NonError', message: redact(String(error)).slice(0, 2000) };
  const details: Record<string, unknown> = {
    name: error.name,
    message: redact(error.message).slice(0, 2000),
  };
  if (error.stack) details.stack = redact(error.stack).slice(0, 5000);
  if ('code' in error && typeof error.code === 'string') details.code = error.code;
  const cause = (error as Error & { cause?: unknown }).cause;
  if (cause !== undefined && depth < 4) details.cause = describeError(cause, depth + 1);
  return details;
}

if (!/^[a-z][a-z0-9-]{0,31}$/.test(tenantSlug)) throw new Error('CSA_CHROME_PIPE_TENANT_SLUG is invalid.');
if (!sandboxIdPattern.test(expectedSandboxId)) throw new Error('CSA_CHROME_PIPE_EXPECTED_SANDBOX_ID is invalid.');
if (!['0', '1'].includes(guiModeValue)) throw new Error('CSA_CHROME_PIPE_GUI must be 0 or 1.');
if (!['0', '1'].includes(traceStartupValue)) throw new Error('CSA_CHROME_PIPE_TRACE_STARTUP must be 0 or 1.');
const guiMode = guiModeValue === '1';
const minimumTimeoutMs = guiMode ? 30_000 : 5_000;
if (!Number.isSafeInteger(browserCommandTimeoutMs) || browserCommandTimeoutMs < minimumTimeoutMs || browserCommandTimeoutMs > 90_000) {
  throw new Error(`CSA_CHROME_PIPE_TIMEOUT_MS must be between ${minimumTimeoutMs} and 90000 for the selected GUI mode.`);
}
if (!['none', 'pipe', 'summary', 'trace'].includes(straceMode)) throw new Error('CSA_CHROME_PIPE_STRACE_MODE must be none, pipe, summary, or trace.');
if (profileRoot && profileRoot !== '/tmp') throw new Error('CSA_CHROME_PIPE_PROFILE_ROOT, when set, must be /tmp.');

const straceEnabled = straceMode !== 'none';
const packageBytes = straceEnabled ? await readFile(stracePackagePath) : Buffer.alloc(0);
const packageSha256 = straceEnabled ? createHash('sha256').update(packageBytes).digest('hex') : '';
if (straceEnabled && packageSha256 !== expectedStraceSha256) throw new Error(`strace package SHA-256 mismatch: expected ${expectedStraceSha256}, got ${packageSha256}.`);

const remoteProbePath = `/tmp/csa-chrome-pipe-${runId}.mjs`;
const remotePackagePath = `/tmp/csa-strace-${runId}.deb`;
const remoteStageDir = `/opt/csa-agent-runtime/.diagnostic-strace-${runId}`;
const remoteStracePath = `${remoteStageDir}/usr/bin/strace`;
let sandbox: Sandbox | undefined;

try {
  const [rows] = await pool.query(
    'SELECT t.id, t.slug, c.sandbox_id, c.cube_traffic_token_ciphertext, c.state, c.desktop_state, c.generation FROM tenants t JOIN computers c ON c.tenant_id = t.id WHERE t.slug = ? LIMIT 1',
    [tenantSlug],
  );
  const computer = (rows as Array<{
    id: string;
    slug: string;
    sandbox_id: string | null;
    cube_traffic_token_ciphertext: string | null;
    state: string;
    desktop_state: string;
    generation: number;
  }>)[0];
  if (!computer?.sandbox_id || computer.state !== 'running' || !computer.cube_traffic_token_ciphertext) {
    throw new Error('The selected tenant must have a running microVM and stored Cube traffic token.');
  }
  if (computer.sandbox_id !== expectedSandboxId) throw new Error('The selected tenant no longer points to the expected existing Beta sandbox; refusing to continue.');
  const [activeRows] = await pool.query(
    "SELECT COUNT(*) AS active_count FROM runs WHERE tenant_id = ? AND status IN ('queued', 'working')",
    [computer.id],
  );
  const activeRuns = Number((activeRows as Array<{ active_count: number }>)[0]?.active_count || 0);
  if (activeRuns !== 0) throw new Error('The selected tenant has active Agent runs; refusing the desktop diagnostic.');

  sandbox = await Sandbox.connect(computer.sandbox_id, { config: cubeConfig() });
  if (sandbox.templateId !== expectedTemplateId) throw new Error('The existing Beta sandbox template differs from the expected diagnostic image.');
  const info = await sandbox.getInfo();
  if (String(info.state || info.status || '').toLowerCase() !== 'running') throw new Error('The existing Beta microVM is not running.');
  if (!sandbox.trafficAccessToken) {
    const connected = sandbox;
    sandbox = new Sandbox({
      sandboxID: connected.sandboxId,
      templateID: connected.templateId,
      domain: connected.domain,
      trafficAccessToken: decryptSandboxTrafficToken(computer.cube_traffic_token_ciphertext),
      envdAccessToken: connected.envdAccessToken,
    }, connected.config);
    connected.close();
  }

  log('preflight.complete', {
    tenantSlug,
    sandboxId: sandbox.sandboxId,
    templateId: sandbox.templateId,
    tenantState: computer.state,
    desktopState: computer.desktop_state,
    generation: computer.generation,
    activeRuns,
    dataPlaneHost: sandbox.getHost(49_983),
    stracePackageBytes: packageBytes.byteLength,
    stracePackageSha256: packageSha256 || 'not-staged',
  });

  if (guiMode) {
    const displayCheck = await sandbox.commands.run(
      "for path in /tmp/.X73-lock /tmp/.X11-unix/X73; do if [ -e \"$path\" ]; then printf 'display=:73 occupied path=%s\\n' \"$path\"; exit 2; fi; done; printf 'display=:73 available\\n'",
      { timeoutMs: 10_000 },
    );
    log('guest.display.preflight', { exitCode: displayCheck.exitCode, output: redact(`${displayCheck.stdout || ''}${displayCheck.stderr || ''}`).trim() });
    if (displayCheck.exitCode !== 0) throw new Error('Isolated X display :73 is occupied; refusing to reuse another desktop session.');
  } else {
    log('guest.display.preflight.skipped', { reason: 'headless-mode' });
  }

  const probeSource = await readFile(new URL('./diagnose-chrome-pipe-guest.mjs', import.meta.url));
  if (straceEnabled) {
    log('guest.package.stage.start', { path: remotePackagePath, bytes: packageBytes.byteLength, dataPlaneHost: sandbox.getHost(49_983) });
    await sandbox.files.write(remotePackagePath, packageBytes);
    log('guest.package.stage.complete', { path: remotePackagePath, bytes: packageBytes.byteLength, sha256: packageSha256 });
  } else {
    log('guest.package.stage.skipped', { reason: 'strace-mode-none' });
  }
  log('guest.probe.stage.start', { path: remoteProbePath, bytes: probeSource.byteLength, dataPlaneHost: sandbox.getHost(49_983) });
  await sandbox.files.write(remoteProbePath, probeSource);
  log('guest.probe.stage.complete', { path: remoteProbePath, bytes: probeSource.byteLength });

  const commandLines = ['set -euo pipefail'];
  if (straceEnabled) {
    commandLines.push(
      `printf '%s  %s\\n' '${expectedStraceSha256}' ${shellQuote(remotePackagePath)} | sha256sum -c -`,
      `mkdir -m 0700 ${shellQuote(remoteStageDir)}`,
      `dpkg-deb -x ${shellQuote(remotePackagePath)} ${shellQuote(remoteStageDir)}`,
      `test -x ${shellQuote(remoteStracePath)}`,
      `${shellQuote(remoteStracePath)} --version`,
    );
  }
  const displayPrefix = guiMode ? 'DISPLAY=:73 ' : '';
  commandLines.push(
    `${displayPrefix}CSA_RUN_ID=${shellQuote(runId)} CSA_CHROME_PIPE_TIMEOUT_MS=${browserCommandTimeoutMs} CSA_CHROME_PIPE_GUI=${guiMode ? '1' : '0'} CSA_CHROME_PIPE_TRACE_STARTUP=${traceStartupValue} CSA_CHROME_PIPE_STRACE_MODE=${shellQuote(straceMode)}${straceEnabled ? ` CSA_CHROME_PIPE_STRACE_PATH=${shellQuote(remoteStracePath)} CSA_CHROME_PIPE_STRACE_WINDOW_MS=15000` : ''}${profileRoot ? ` CSA_CHROME_PIPE_PROFILE_ROOT=${shellQuote(profileRoot)}` : ''} dbus-run-session -- node ${shellQuote(remoteProbePath)}`,
  );
  const command = commandLines.join('\n');
  log('guest.pipe-probe.start', { guiMode, browserCommandTimeoutMs, traceStartup: traceStartupValue === '1', straceWindowMs: straceEnabled ? 15_000 : 0, straceMode, straceEnabled, profileRoot: profileRoot || (guiMode ? '/workspace/.desktop-home/.config/chromium' : '/tmp'), createsSandbox: false, installsPackages: false });
  const result = await runGuestPty(
    sandbox,
    command,
    '/',
    {},
    line => log('guest.output', { sandboxId: sandbox!.sandboxId, line: redact(line) }),
    guiMode ? 135_000 : 120_000,
  );
  log('guest.pipe-probe.complete', { sandboxId: sandbox.sandboxId, exitCode: result.exitCode });
  if (result.exitCode !== 0) process.exitCode = 1;
} catch (error) {
  log('diagnostic.failed', {
    tenantSlug,
    sandboxId: sandbox?.sandboxId || 'not-connected',
    failedAfter: lastStage,
    dataPlaneHost: sandbox?.getHost(49_983) || null,
    error: describeError(error),
  });
  process.exitCode = 1;
} finally {
  if (sandbox) {
    for (const path of [remoteProbePath, ...(straceEnabled ? [remotePackagePath, remoteStageDir] : [])]) {
      try {
        await sandbox.files.remove(path);
        log('guest.cleanup.complete', { path });
      } catch (error) {
        log('guest.cleanup.skipped', { path, error: describeError(error) });
      }
    }
    sandbox.close();
  }
  await pool.end();
  log('diagnostic.log', { path: logPath });
}
