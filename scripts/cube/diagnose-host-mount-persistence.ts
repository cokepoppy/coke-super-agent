import 'dotenv/config';
import { spawnSync } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { appendFileSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { Config, Sandbox } from '@cubesandbox/sdk';

const apiUrl = process.env.CUBE_API_URL || '';
const templateId = process.env.CSA_MOUNT_DIAGNOSTIC_TEMPLATE_ID || '';
if (!apiUrl || !templateId || !['127.0.0.1', 'localhost', '::1'].includes(new URL(apiUrl).hostname)) {
  throw new Error('Set the local Cube API URL and CSA_MOUNT_DIAGNOSTIC_TEMPLATE_ID.');
}
const resumeRunId = process.env.CSA_MOUNT_DIAGNOSTIC_RESUME_RUN_ID || '';
if (resumeRunId && !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(resumeRunId)) {
  throw new Error('The diagnostic resume ID must be a lowercase UUIDv4.');
}
const runId = resumeRunId || randomUUID();
const hostRoot = `/data/shared/csa-mount-probe-${runId}`;
let alphaMarker = randomBytes(16).toString('hex');
const betaMarker = randomBytes(16).toString('hex');
const limactl = process.env.CSA_LIMACTL || join(homedir(), 'Library/Application Support/Coke Super Agent/lab/lima-2.3.0/bin/limactl');
const commandEnv = { PATH: process.env.PATH, HOME: homedir(), LIMA_HOME: process.env.LIMA_HOME || join(homedir(), '.local/share/csa-cube-node/lima') };
const logDir = process.env.CSA_BUILD_LOG_DIR || join(homedir(), '.local/share/csa-cube-node/build-logs');
mkdirSync(logDir, { recursive: true, mode: 0o700 });
const logPath = join(logDir, `host-mount-persistence-${new Date().toISOString().replace(/[:.]/g, '-')}-${runId}.jsonl`);
const started = Date.now();
function log(stage: string, details: Record<string, unknown> = {}) {
  const line = JSON.stringify({ timestamp: new Date().toISOString(), runId, elapsedMs: Date.now() - started, stage, ...details }) + '\n';
  process.stdout.write(line);
  appendFileSync(logPath, line, { mode: 0o600 });
}
function lima(args: string[]) {
  const result = spawnSync(limactl, ['shell', 'cube-node', '--', ...args], { env: commandEnv, timeout: 30_000, encoding: 'utf8' });
  if (result.status !== 0) throw new Error(`Lima command failed (${result.status ?? result.error?.message ?? 'unknown'}): ${result.stderr.slice(-1000)}`);
  return result.stdout;
}
const cube = new Config({
  apiUrl, apiKey: process.env.CUBE_API_KEY || undefined,
  proxyNodeIp: process.env.CUBE_PROXY_NODE_IP || '127.0.0.1',
  proxyPort: Number(process.env.CUBE_PROXY_PORT_HTTP || '28080'),
  proxyScheme: process.env.CUBE_PROXY_SCHEME || 'http',
  sandboxDomain: process.env.CUBE_SANDBOX_DOMAIN || 'cube.app',
  requestTimeoutMs: 30_000,
});
let active: Sandbox | undefined;
let hostCreated = false;
let creationUncertain = false;
async function create(side: 'alpha' | 'beta') {
  for (let attempt = 1; attempt <= 7; attempt += 1) {
    log('sandbox.create.start', { side, templateId, attempt });
    creationUncertain = true;
    try {
      active = await Sandbox.create({
        config: cube, template: templateId, timeout: 300, allowInternetAccess: true,
        network: { allowPublicTraffic: false }, extra: { restartPolicy: 'Never' },
        metadata: {
          csa_mount_diagnostic: runId,
          'host-mount': JSON.stringify([{ hostPath: `${hostRoot}/${side}`, mountPath: '/workspace', readOnly: false }]),
        },
      });
      creationUncertain = false;
      log('sandbox.create.complete', { side, sandboxId: active.sandboxId });
      return active;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (!/error code 130597: no more resource/i.test(message)) throw error;
      // CubeMaster explicitly rejected the request before allocating a VM.
      creationUncertain = false;
      if (attempt === 7) throw error;
      log('sandbox.create.resource-wait', { side, attempt, delayMs: 8_000 });
      await new Promise(resolve => setTimeout(resolve, 8_000));
    }
  }
  throw new Error('Sandbox creation retry loop ended unexpectedly.');
}
async function run(side: string, command: string) {
  if (!active) throw new Error('No diagnostic sandbox is active.');
  const result = await active.commands.run(command, { timeoutMs: 40_000 });
  if (result.exitCode !== 0) throw new Error(`${side} command failed (${result.exitCode}): ${result.stderr.slice(-1000)} ${result.stdout.slice(-1000)}`);
  log('sandbox.probe.passed', { side, sandboxId: active.sandboxId, output: result.stdout.trim().slice(0, 500) });
}
async function kill(side: string) {
  if (!active) return;
  const sandbox = active;
  await sandbox.kill();
  active = undefined;
  sandbox.close();
  log('sandbox.cleanup.complete', { side, sandboxId: sandbox.sandboxId });
}
try {
  if (resumeRunId) {
    log('host.resume.start', { hostRoot });
    const existing = lima(['sudo', '-n', 'bash', '-c', 'set -eu; test -d "$1/alpha"; test -d "$1/beta"; test -f "$1/alpha/alpha-proof.txt"; test ! -e "$1/beta/beta-proof.txt"; cat "$1/alpha/alpha-proof.txt"', '--', hostRoot]).trim();
    if (!/^[a-f0-9]{32}$/.test(existing)) throw new Error('The saved diagnostic marker is invalid.');
    alphaMarker = existing;
    hostCreated = true;
    log('host.resume.complete');
  } else {
    log('host.prepare.start', { hostRoot });
    // All path arguments are fixed UUID-derived diagnostic paths, not user input.
    lima(['sudo', '-n', 'mkdir', '-m', '0700', '--', hostRoot]);
    hostCreated = true;
    lima(['sudo', '-n', 'mkdir', '-m', '0700', '--', `${hostRoot}/alpha`, `${hostRoot}/beta`]);
    lima(['sudo', '-n', 'chown', '1000:1000', '--', `${hostRoot}/alpha`, `${hostRoot}/beta`]);
    log('host.prepare.complete');

    await create('alpha');
    await run('alpha-write', `set -eu; u="$(getent passwd 1000 | cut -d: -f1)"; test -n "$u"; runuser -u "$u" -- sh -c 'printf %s ${alphaMarker} > /workspace/alpha-proof.txt'; test ! -e /workspace/beta-proof.txt; stat -f -c 'filesystem=%T' /workspace`);
    await kill('alpha-first');
  }

  await create('beta');
  await run('beta-write', `set -eu; test ! -e /workspace/alpha-proof.txt; u="$(getent passwd 1000 | cut -d: -f1)"; test -n "$u"; runuser -u "$u" -- sh -c 'printf %s ${betaMarker} > /workspace/beta-proof.txt'; stat -f -c 'filesystem=%T' /workspace`);
  await kill('beta');

  await create('alpha');
  await run('alpha-recreated', `set -eu; test "$(cat /workspace/alpha-proof.txt)" = '${alphaMarker}'; test ! -e /workspace/beta-proof.txt; printf 'own-file-persisted=yes peer-file-visible=no\n'`);
  await kill('alpha-recreated');

  const hostResult = lima(['sudo', '-n', 'bash', '-c', 'set -eu; test "$(cat "$1/alpha/alpha-proof.txt")" = "$2"; test "$(cat "$1/beta/beta-proof.txt")" = "$3"; printf "both-host-files-persisted=yes\\n"', '--', hostRoot, alphaMarker, betaMarker]);
  log('host.verify.passed', { output: hostResult.trim() });
  log('comparison.passed', { recreatedSandboxRetainedOwnFile: true, peerFileAbsentFromMount: true });
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  const apiKey = process.env.CUBE_API_KEY || '';
  log('diagnostic.failed', { error: apiKey ? message.replaceAll(apiKey, '[redacted]') : message });
  process.exitCode = 1;
} finally {
  if (active) {
    try { await kill('finally'); }
    catch (error) { log('sandbox.cleanup.failed', { sandboxId: active?.sandboxId, error: error instanceof Error ? error.name : 'unknown' }); process.exitCode = 1; }
  }
  if (hostCreated && !active && !creationUncertain) {
    try {
      lima(['sudo', '-n', 'bash', '-c', 'set -eu; for p in "$1/alpha/alpha-proof.txt" "$1/beta/beta-proof.txt"; do [ ! -e "$p" ] || unlink -- "$p"; done; for p in "$1/alpha" "$1/beta" "$1"; do [ ! -d "$p" ] || rmdir -- "$p"; done', '--', hostRoot]);
      log('host.cleanup.complete', { hostRoot });
    } catch (error) { log('host.cleanup.failed', { hostRoot, error: error instanceof Error ? error.message : String(error) }); process.exitCode = 1; }
  } else if (hostCreated) {
    log('host.cleanup.skipped', { hostRoot, reason: 'sandbox creation or cleanup was not confirmed' });
  }
  process.stdout.write(`diagnostic_log=${logPath}\n`);
}
