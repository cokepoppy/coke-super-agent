import 'dotenv/config';
import { spawnSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { appendFileSync, mkdirSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { Config, Sandbox } from '@cubesandbox/sdk';

const apiUrl = process.env.CUBE_API_URL || '';
const templateId = process.env.CSA_VM_BENCHMARK_TEMPLATE_ID || '';
if (!apiUrl || !templateId || !['127.0.0.1', 'localhost', '::1'].includes(new URL(apiUrl).hostname)) {
  throw new Error('Set the local Cube API URL and CSA_VM_BENCHMARK_TEMPLATE_ID.');
}
const runId = randomUUID();
const hostDir = `/tmp/csa-vm-bench-${runId}`;
const remoteBinary = `/tmp/csa-vm-bench-${runId}`;
const limactl = process.env.CSA_LIMACTL || join(homedir(), 'Library/Application Support/Coke Super Agent/lab/lima-2.3.0/bin/limactl');
const commandEnv = { PATH: process.env.PATH, HOME: homedir(), LIMA_HOME: process.env.LIMA_HOME || join(homedir(), '.local/share/csa-cube-node/lima') };
const logDir = process.env.CSA_BUILD_LOG_DIR || join(homedir(), '.local/share/csa-cube-node/build-logs');
mkdirSync(logDir, { recursive: true, mode: 0o700 });
const logPath = join(logDir, `vm-performance-${new Date().toISOString().replace(/[:.]/g, '-')}-${runId}.jsonl`);
const started = Date.now();
function log(stage: string, details: Record<string, unknown> = {}) {
  const line = JSON.stringify({ timestamp: new Date().toISOString(), runId, elapsedMs: Date.now() - started, stage, ...details }) + '\n';
  process.stdout.write(line);
  appendFileSync(logPath, line, { mode: 0o600 });
}
function runLima(args: string[], input?: string) {
  const result = spawnSync(limactl, ['shell', 'cube-node', '--', ...args], {
    env: commandEnv,
    input,
    timeout: 60_000,
    maxBuffer: 4 * 1024 * 1024,
  });
  if (result.status !== 0) throw new Error(`Lima command failed (${result.status ?? result.error?.message ?? 'unknown'}): ${(result.stderr || Buffer.alloc(0)).toString().slice(-1000)}`);
  return result.stdout;
}
function samples(side: string, output: string) {
  let complete = false;
  for (const line of output.split('\n')) {
    if (!line.startsWith('{')) continue;
    const parsed = JSON.parse(line) as { stage?: unknown } & Record<string, unknown>;
    if (typeof parsed.stage !== 'string') throw new Error(`Invalid ${side} benchmark sample.`);
    if (parsed.stage === 'complete') complete = true;
    log('benchmark.sample', { side, sample: parsed });
  }
  if (!complete) throw new Error(`${side} benchmark did not complete.`);
}
const cube = new Config({
  apiUrl,
  apiKey: process.env.CUBE_API_KEY || undefined,
  proxyNodeIp: process.env.CUBE_PROXY_NODE_IP || '127.0.0.1',
  proxyPort: Number(process.env.CUBE_PROXY_PORT_HTTP || '28080'),
  proxyScheme: process.env.CUBE_PROXY_SCHEME || 'http',
  sandboxDomain: process.env.CUBE_SANDBOX_DOMAIN || 'cube.app',
  requestTimeoutMs: 30_000,
});
let sandbox: Sandbox | undefined;
let hostDirCreated = false;
try {
  log('host.compile.start', { templateId });
  const source = readFileSync(resolve('scripts/cube/diagnose-vm-performance.c'), 'utf8');
  // The UUID path is passed as an argument, never interpolated into shell code.
  runLima(['mkdir', '-m', '700', '--', hostDir]);
  hostDirCreated = true;
  const hostOutput = runLima(['bash', '-c', 'set -eu; umask 077; cat > "$1/performance.c"; gcc -O2 -static -Wall -Wextra -o "$1/performance" "$1/performance.c"; sha256sum "$1/performance"; timeout 30s "$1/performance"', '--', hostDir], source).toString();
  const hostHash = hostOutput.match(/^([a-f0-9]{64})\s/m)?.[1];
  if (!hostHash) throw new Error('The Lima host did not report a binary hash.');
  samples('lima-host', hostOutput);
  const binary = runLima(['cat', `${hostDir}/performance`]);
  const binaryHash = createHash('sha256').update(binary).digest('hex');
  if (binaryHash !== hostHash) throw new Error('The copied benchmark binary differs from the host binary.');
  log('host.binary.verified', { sha256: binaryHash, bytes: binary.length });
  runLima(['bash', '-c', 'set -eu; rm -- "$1/performance" "$1/performance.c"; rmdir -- "$1"', '--', hostDir]);
  hostDirCreated = false;

  log('sandbox.create.start', { templateId });
  sandbox = await Sandbox.create({
    config: cube,
    template: templateId,
    timeout: 300,
    allowInternetAccess: true,
    network: { allowPublicTraffic: false },
    extra: { restartPolicy: 'Never' },
    metadata: { csa_vm_performance_diagnostic: runId },
  });
  log('sandbox.create.complete', { sandboxId: sandbox.sandboxId });
  await sandbox.files.write(remoteBinary, binary);
  log('sandbox.benchmark.start', { sandboxId: sandbox.sandboxId, sha256: binaryHash });
  const result = await sandbox.commands.run(`chmod 700 '${remoteBinary}' && sha256sum '${remoteBinary}' && timeout 120s '${remoteBinary}'`, { timeoutMs: 150_000 });
  const guestHash = result.stdout.match(/^([a-f0-9]{64})\s/m)?.[1];
  if (guestHash !== binaryHash) throw new Error('The Cube guest binary differs from the Lima host binary.');
  samples('cube-microvm', result.stdout);
  if (result.exitCode !== 0) throw new Error(`Guest benchmark exited ${result.exitCode}: ${result.stderr.slice(-1000)}`);
  log('comparison.complete', { binarySha256: binaryHash });
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  const apiKey = process.env.CUBE_API_KEY || '';
  log('diagnostic.failed', { error: apiKey ? message.replaceAll(apiKey, '[redacted]') : message });
  process.exitCode = 1;
} finally {
  if (hostDirCreated) {
    try { runLima(['bash', '-c', 'set -eu; [ ! -e "$1/performance" ] || rm -- "$1/performance"; [ ! -e "$1/performance.c" ] || rm -- "$1/performance.c"; [ ! -d "$1" ] || rmdir -- "$1"', '--', hostDir]); log('host.cleanup.complete'); }
    catch (error) { log('host.cleanup.failed', { error: error instanceof Error ? error.message : String(error) }); process.exitCode = 1; }
  }
  if (sandbox) {
    try { await sandbox.kill(); log('sandbox.cleanup.complete', { sandboxId: sandbox.sandboxId }); }
    catch (error) { log('sandbox.cleanup.failed', { sandboxId: sandbox.sandboxId, error: error instanceof Error ? error.name : 'unknown' }); process.exitCode = 1; }
    sandbox.close();
  }
  process.stdout.write(`diagnostic_log=${logPath}\n`);
}
