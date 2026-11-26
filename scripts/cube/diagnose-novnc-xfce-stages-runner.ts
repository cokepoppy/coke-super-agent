import { config as dotenvConfig } from 'dotenv';
import { readFile } from 'node:fs/promises';

const envPath = process.env.CSA_SUPER_AGENT_ENV_PATH;
if (envPath) dotenvConfig({ path: envPath, override: false });

const tenantSlug = process.env.CSA_DIAGNOSTIC_TENANT_SLUG || 'beta';
const { pool } = await import('../../src/server/db.ts');
const { Sandbox } = await import('@cubesandbox/sdk');
const { cubeConfig } = await import('../../src/server/computer.ts');
const { decryptSandboxTrafficToken } = await import('../../src/server/token-crypto.ts');
const { runGuestPty } = await import('../../src/server/runtime-bundle.ts');

interface ComputerRow {
  id: string;
  sandbox_id: string | null;
  cube_traffic_token_ciphertext: string | null;
  state: string;
  desktop_state: string;
  generation: number;
}

let sandbox: InstanceType<typeof Sandbox> | undefined;
try {
  const [rows] = await pool.query(
    'SELECT t.id, c.sandbox_id, c.cube_traffic_token_ciphertext, c.state, c.desktop_state, c.generation FROM tenants t JOIN computers c ON c.tenant_id = t.id WHERE t.slug = ? LIMIT 1',
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
  const activeCount = Number((activeRows as Array<{ active_count: number }>)[0]?.active_count || 0);
  process.stdout.write(`diagnostic.preflight tenant=${tenantSlug} state=${computer.state} desktop_state=${computer.desktop_state} generation=${computer.generation} active_runs=${activeCount}\n`);
  if (activeCount !== 0) throw new Error('The selected tenant has an active Agent run; refusing desktop diagnostic.');

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

  const remoteScript = await readFile(new URL('./diagnose-novnc-xfce-stages.sh', import.meta.url), 'utf8');
  const result = await runGuestPty(
    sandbox,
    remoteScript,
    '/',
    {
      CSA_NOVNC_XFCE_DISPLAY: process.env.CSA_NOVNC_XFCE_DISPLAY || ':10',
      CSA_NOVNC_XFCE_VNC_PORT: process.env.CSA_NOVNC_XFCE_VNC_PORT || '5900',
      CSA_NOVNC_XFCE_WEB_PORT: process.env.CSA_NOVNC_XFCE_WEB_PORT || '6080',
      CSA_NOVNC_XFCE_STATIC_PORT: process.env.CSA_NOVNC_XFCE_STATIC_PORT || '16092',
      CSA_NOVNC_XFCE_LISTEN_HOST: process.env.CSA_NOVNC_XFCE_LISTEN_HOST || '127.0.0.1',
      CSA_NOVNC_XFCE_HTTP_TIMEOUT: process.env.CSA_NOVNC_XFCE_HTTP_TIMEOUT || '15',
    },
    line => {
      if (!line.startsWith('novnc.xfce timestamp=')) return;
      const visibleStages = [
        'stage=pre_xfce_', 'stage=static_http.ready', 'stage=websockify.ready',
        'stage=xfce.ready', 'stage=post_xfce_', 'stage=sequence.complete', 'stage=cleanup.',
      ];
      if (visibleStages.some(stage => line.includes(stage))) process.stdout.write(line + '\n');
    },
    480_000,
  );
  process.stdout.write(`diagnostic.complete exitCode=${result.exitCode}\n`);

  const completionLine = result.output.split(/\r?\n/).find(line => line.includes('stage=sequence.complete'));
  const directory = completionLine?.split('diag_dir=')[1]?.trim();
  if (directory && /^\/tmp\/csa-novnc-xfce-[A-Za-z0-9TZ-]+$/.test(directory)) {
    const evidence = await sandbox.commands.run(
      `find ${directory} -maxdepth 1 -type f -name '*.result' -print -exec cat {} \\;`,
      { timeoutMs: 15_000 },
    );
    process.stdout.write(`diagnostic.persisted-results exitCode=${evidence.exitCode}\n${evidence.stdout}${evidence.stderr}`);
  } else {
    process.stdout.write('diagnostic.persisted-results unavailable reason=sequence-marker-missing\n');
  }
  if (result.exitCode !== 0) process.exitCode = 1;
} finally {
  sandbox?.close();
  await pool.end();
}
