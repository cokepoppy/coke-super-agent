import 'dotenv/config';
import { randomUUID } from 'node:crypto';
import { appendFileSync } from 'node:fs';
import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { Config, NEVER_TIMEOUT, Sandbox } from '@cubesandbox/sdk';
import { runGuestPty } from '../../src/server/runtime-bundle.ts';

const apiUrl = process.env.CUBE_API_URL || '';
const templateId = process.env.CSA_CHROME_PIPE_TEMPLATE_ID || '';
const apiKey = process.env.CUBE_API_KEY || undefined;
const apiHost = apiUrl ? new URL(apiUrl).hostname : '';
const localCubeApi = apiHost === '127.0.0.1' || apiHost === 'localhost' || apiHost === '::1';
const proxyNodeIp = process.env.CUBE_PROXY_NODE_IP || (localCubeApi ? '127.0.0.1' : undefined);
const proxyPort = Number(process.env.CUBE_PROXY_PORT_HTTP || (localCubeApi ? '28080' : '80'));
const proxyScheme = process.env.CUBE_PROXY_SCHEME || 'http';
const sandboxDomain = process.env.CUBE_SANDBOX_DOMAIN || 'cube.app';
const logDirectory = process.env.CSA_BUILD_LOG_DIR || join(homedir(), '.local/share/csa-cube-node/build-logs');
const runId = randomUUID();
const startedAt = Date.now();
const logPath = join(logDirectory, 'chrome-pipe-' + new Date().toISOString().replace(/[:.]/g, '-') + '-' + runId + '.jsonl');
const guestTimeoutMs = Number(process.env.CSA_CHROME_PIPE_TIMEOUT_MS || '300000');
const guiMode = process.env.CSA_CHROME_PIPE_GUI === '1';

await mkdir(logDirectory, { recursive: true, mode: 0o700 });
await writeFile(logPath, '', { mode: 0o600 });
await chmod(logPath, 0o600);

const redact = (value: string): string => value
  .replace(/(https?:\/\/)[^/@\s]+:[^/@\s]+@/gi, '$1[redacted]@')
  .replace(/([?&](?:token|key|password|secret)=)[^&\s]+/gi, '$1[redacted]')
  .replace(/(DevTools listening on ws:\/\/)[^\s]+/g, '$1[redacted]')
  .replace(/(\/devtools\/browser\/)[A-Za-z0-9_-]+/g, '$1[redacted]');

function log(stage: string, fields: Record<string, string | number | boolean | null> = {}): void {
  const row = JSON.stringify({
    timestamp: new Date().toISOString(),
    runId,
    elapsedMs: Date.now() - startedAt,
    stage,
    ...fields,
  });
  process.stdout.write(row + '\n');
  appendFileSync(logPath, row + '\n', { mode: 0o600 });
}

if (!apiUrl || !templateId) throw new Error('Set CUBE_API_URL and CSA_CHROME_PIPE_TEMPLATE_ID.');
if (!Number.isSafeInteger(proxyPort) || proxyPort < 1 || proxyPort > 65535) throw new Error('CUBE_PROXY_PORT_HTTP must be a valid TCP port.');
if (!Number.isSafeInteger(guestTimeoutMs) || guestTimeoutMs < 30_000 || guestTimeoutMs > 360_000) {
  throw new Error('CSA_CHROME_PIPE_TIMEOUT_MS must be between 30000 and 360000.');
}

const config = new Config({ apiUrl, apiKey, proxyNodeIp, proxyPort, proxyScheme, sandboxDomain, requestTimeoutMs: 30_000 });
const guestProbe = await readFile(new URL('./diagnose-chrome-pipe-guest.mjs', import.meta.url), 'utf8');
let sandbox: Sandbox | undefined;

try {
  log('sandbox.create.start', {
    templateId,
    cpuCount: 2000,
    memoryMb: 2048,
    writableLayerSize: '2Gi',
    guiMode,
    proxyNodeIp: proxyNodeIp || 'dns',
    proxyPort,
    proxyScheme,
    sandboxDomain,
  });
  sandbox = await Sandbox.create({
    config,
    template: templateId,
    timeout: NEVER_TIMEOUT,
    allowInternetAccess: true,
    network: { allowPublicTraffic: false, allowOut: ['0.0.0.0/0'] },
    extra: { restartPolicy: 'Never' },
    metadata: { csa_chrome_pipe_diagnostic: 'true', csa_diagnostic_run: runId },
  });
  const info = await sandbox.getInfo();
  log('sandbox.create.complete', {
    sandboxId: sandbox.sandboxId,
    state: String(info.state || 'unknown'),
    dataPlaneHost: sandbox.getHost(49983),
  });

  const remotePath = '/tmp/csa-chrome-pipe-probe.mjs';
  log('guest.file.stage.start', {
    sandboxId: sandbox.sandboxId,
    path: remotePath,
    bytes: Buffer.byteLength(guestProbe),
  });
  await sandbox.files.write(remotePath, guestProbe);
  log('guest.file.stage.complete', { sandboxId: sandbox.sandboxId, path: remotePath });

  const command = "CSA_RUN_ID='" + runId + "' CSA_CHROME_PIPE_TIMEOUT_MS='" + guestTimeoutMs
    + "' CSA_CHROME_PIPE_GUI='" + (guiMode ? '1' : '0') + "' dbus-run-session -- node '" + remotePath + "'";
  const result = await runGuestPty(
    sandbox,
    command,
    '/',
    {},
    line => log('guest.output', { sandboxId: sandbox!.sandboxId, line: redact(line) }),
    guestTimeoutMs + 30_000,
  );
  log('guest.command.complete', { sandboxId: sandbox.sandboxId, exitCode: result.exitCode });
  if (result.exitCode !== 0) process.exitCode = 1;
} catch (error) {
  const value = error instanceof Error ? error : new Error(String(error));
  const cause = value.cause instanceof Error ? value.cause : undefined;
  const causeCode = cause && 'code' in cause && typeof cause.code === 'string' ? cause.code : '';
  log('diagnostic.failed', {
    sandboxId: sandbox?.sandboxId || 'not-created',
    dataPlaneHost: sandbox?.getHost(49983) || '',
    errorName: value.name,
    error: redact(value.message),
    errorCauseName: cause?.name || '',
    errorCauseCode: causeCode,
    errorCause: cause ? redact(cause.message) : '',
  });
  process.exitCode = 1;
} finally {
  if (sandbox) {
    try {
      log('sandbox.cleanup.start', { sandboxId: sandbox.sandboxId });
      await sandbox.kill();
      log('sandbox.cleanup.complete', { sandboxId: sandbox.sandboxId });
    } catch (error) {
      log('sandbox.cleanup.failed', {
        sandboxId: sandbox.sandboxId,
        error: redact(error instanceof Error ? error.message : String(error)),
      });
      process.exitCode = 1;
    }
    sandbox.close();
  }
  process.stdout.write('diagnostic_log=' + logPath + '\n');
}
