import { cp, mkdir, writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { StringDecoder } from 'node:string_decoder';
import { pathToFileURL } from 'node:url';

const runtimeRoot = '/opt/csa-agent-runtime';
const dshHome = process.env.DSH_HOME;
const executable = `${runtimeRoot}/dsh-runtime-bin/runtime/deepseek-harness-sdk-runtime-linux-arm64`;
const launcher = `${runtimeRoot}/dsh-runtime-launcher.mjs`;
const pluginPath = `${runtimeRoot}/computer-plugin.mjs`;
const patchPath = `${dshHome}/coke-super-agent-computer.patch.yml`;
const timeoutMs = 480_000;

if (!dshHome || !dshHome.startsWith('/tmp/csa-dsh-clone-smoke-home')) {
  throw new Error('DSH profile smoke requires an isolated temporary DSH_HOME.');
}
await mkdir(dshHome, { recursive: true, mode: 0o700 });
await cp(pluginPath, `${dshHome}/computer-plugin.mjs`);
await writeFile(patchPath, `- insert:\n  - id: coke-super-agent-computer\n    name: ${pathToFileURL(`${dshHome}/computer-plugin.mjs`).href}\n`, { mode: 0o600 });

const env = { ...process.env, CSA_DSH_RUNTIME_EXECUTABLE: executable };
delete env.DEEPSEEK_API_KEY;
delete env.DEEPSEEK_BASE_URL;
const child = spawn(`${runtimeRoot}/bin/node`, [launcher, '--profile', 'sdk-minimal', '--patch', patchPath], {
  cwd: '/workspace',
  env,
  stdio: ['pipe', 'pipe', 'pipe'],
  detached: true,
});

const startedAt = Date.now();
const stderrDecoder = new StringDecoder('utf8');
let stderrBuffer = '';
let stderrTail = '';
let stdoutBuffer = '';
let initialized = false;
let shutdownResponded = false;
let settled = false;
let deadline;
let shutdownDeadline;
let heartbeat;

function emit(stage, details = {}) {
  process.stdout.write(JSON.stringify({ timestamp: new Date().toISOString(), elapsedMs: Date.now() - startedAt, stage, ...details }) + '\n');
}

function stopChild(signal) {
  try { process.kill(-child.pid, signal); }
  catch (error) {
    if (error && typeof error === 'object' && error.code !== 'ESRCH') emit('smoke.child.signal.failed', { signal, errorCode: error.code || null });
  }
}

function fail(stage, details = {}) {
  if (settled) return;
  settled = true;
  clearTimeout(deadline);
  clearTimeout(shutdownDeadline);
  clearInterval(heartbeat);
  emit(stage, { ...details, stderrTail: stderrTail.trim().slice(-1800) });
  process.exitCode = 1;
  stopChild('SIGTERM');
  setTimeout(() => stopChild('SIGKILL'), 5_000).unref();
  setTimeout(() => process.exit(1), 10_000).unref();
}

function succeed(details = {}) {
  if (settled) return;
  settled = true;
  clearTimeout(deadline);
  clearTimeout(shutdownDeadline);
  clearInterval(heartbeat);
  emit('smoke.complete', { ...details, initializeDurationMs, shutdownResponded, stderrTail: stderrTail.trim().slice(-1200) });
}

let initializeDurationMs = 0;
deadline = setTimeout(() => fail('smoke.initialize.timeout', { timeoutMs, initialized }), timeoutMs);
heartbeat = setInterval(() => emit('smoke.initialize.wait', { timeoutMs, initialized, shutdownResponded, stderrTail: stderrTail.trim().slice(-800) }), 15_000);

child.once('error', error => fail('smoke.runtime.spawn.failed', { errorName: error.name, errorCode: error.code || null }));
child.once('exit', (code, signal) => {
  if (settled) return;
  if (initialized && shutdownResponded && code === 0) succeed({ exitCode: code, signal });
  else fail('smoke.runtime.exit.unexpected', { exitCode: code, signal, initialized, shutdownResponded });
});

child.stderr.on('data', chunk => {
  const decoded = stderrDecoder.write(chunk);
  stderrBuffer += decoded;
  const lines = stderrBuffer.split(/\r?\n/);
  stderrBuffer = lines.pop() || '';
  for (const line of lines) {
    if (!line.trim()) continue;
    stderrTail = (stderrTail + line + '\n').slice(-4000);
    process.stderr.write(line + '\n');
  }
});

child.stdout.on('data', chunk => {
  stdoutBuffer += chunk.toString('utf8');
  let newline;
  while ((newline = stdoutBuffer.indexOf('\n')) >= 0) {
    const line = stdoutBuffer.slice(0, newline).trim();
    stdoutBuffer = stdoutBuffer.slice(newline + 1);
    if (!line) continue;
    let frame;
    try { frame = JSON.parse(line); }
    catch { fail('smoke.runtime.stdout.invalid', { bytes: Buffer.byteLength(line) }); return; }
    if (frame?.id === 1) {
      initializeDurationMs = Date.now() - startedAt;
      if (frame.error) {
        fail('smoke.initialize.rejected', { durationMs: initializeDurationMs, errorCode: frame.error.code ?? null, errorMessage: String(frame.error.message || '').slice(0, 700) });
        return;
      }
      initialized = true;
      emit('smoke.initialize.ready', { durationMs: initializeDurationMs, serverInfoKeys: Object.keys(frame.result?.serverInfo || {}) });
      child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'shutdown', params: {} }) + '\n');
      shutdownDeadline = setTimeout(() => fail('smoke.shutdown.timeout', { durationMs: initializeDurationMs }), 30_000);
    } else if (frame?.id === 2) {
      if (frame.error) {
        fail('smoke.shutdown.rejected', { errorCode: frame.error.code ?? null, errorMessage: String(frame.error.message || '').slice(0, 700) });
        return;
      }
      shutdownResponded = true;
      emit('smoke.shutdown.responded');
    } else {
      emit('smoke.runtime.frame', { id: frame?.id ?? null, method: frame?.method || null });
    }
  }
});

emit('smoke.initialize.request', { profile: 'sdk-minimal', provider: 'deepseek-official', model: 'deepseek-flash', computerPlugin: true, apiKeyPresent: false, timeoutMs });
child.stdin.write(JSON.stringify({
  jsonrpc: '2.0',
  id: 1,
  method: 'initialize',
  params: { cwd: '/workspace', provider: 'deepseek-official', model: 'deepseek-flash' },
}) + '\n');
