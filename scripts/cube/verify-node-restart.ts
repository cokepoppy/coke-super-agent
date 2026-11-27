import 'dotenv/config';
import { spawnSync } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { appendFileSync, mkdirSync, statfsSync } from 'node:fs';
import { homedir } from 'node:os';
import { isIPv4 } from 'node:net';
import { join } from 'node:path';
import type { RowDataPacket } from 'mysql2/promise';
import { Sandbox } from '@cubesandbox/sdk';
import { connectTenantSandbox, cubeConfig } from '../../src/server/computer.ts';
import { config } from '../../src/server/config.ts';
import { pool } from '../../src/server/db.ts';

const runningIds = (process.env.CSA_RESTART_EXPECT_RUNNING || '').split(',').filter(Boolean);
const pausedIds = (process.env.CSA_RESTART_EXPECT_PAUSED || '').split(',').filter(Boolean);
const nodePrivateIp = process.env.CSA_RESTART_NODE_PRIVATE_IP || '';
const validId = (value: string) => /^[a-f0-9]{32}$/.test(value);
if (process.env.CSA_RESTART_NODE_EXECUTE !== '1' || !runningIds.length || !isIPv4(nodePrivateIp) || ![...runningIds, ...pausedIds].every(validId) || new Set([...runningIds, ...pausedIds]).size !== runningIds.length + pausedIds.length || !['127.0.0.1', 'localhost', '::1'].includes(new URL(config.cube.apiUrl).hostname)) {
  throw new Error('Set CSA_RESTART_NODE_EXECUTE=1 plus explicit, distinct expected running and paused Cube sandbox IDs for the local node.');
}
const runId = randomUUID();
const marker = randomBytes(16).toString('hex');
const markerPath = `/data/shared/csa-tenant-workspaces/.csa-restart-test-${runId}`;
const logDir = process.env.CSA_BUILD_LOG_DIR || join(homedir(), '.local/share/csa-cube-node/build-logs');
mkdirSync(logDir, { recursive: true, mode: 0o700 });
const logPath = join(logDir, `node-restart-${new Date().toISOString().replace(/[:.]/g, '-')}-${runId}.jsonl`);
const started = Date.now();
const cube = cubeConfig();
let stopAttempted = false;
let pauseAttempted = false;
let markerCreated = false;
let failed = false;
function log(stage: string, details: Record<string, unknown> = {}) {
  const line = JSON.stringify({ timestamp: new Date().toISOString(), runId, elapsedMs: Date.now() - started, stage, ...details }) + '\n';
  process.stdout.write(line);
  appendFileSync(logPath, line, { mode: 0o600 });
}
function lima(args: string[], timeout = 60_000) {
  const result = spawnSync(config.cube.limaCommand, args, {
    env: { PATH: process.env.PATH, HOME: homedir(), LIMA_HOME: config.cube.limaHome },
    encoding: 'utf8', timeout, maxBuffer: 1024 * 1024,
  });
  if (result.status !== 0) throw new Error(`Lima command failed (${result.status ?? result.error?.message ?? 'unknown'}): ${result.stderr.slice(-1000)}`);
  return result.stdout.trim();
}
function node(args: string[]) { return lima(['shell', 'cube-node', '--', ...args], 30_000); }
function ensureTunnel() {
  const result = spawnSync('/bin/bash', ['scripts/cube/ensure-local-api-tunnel.sh'], {
    env: { PATH: process.env.PATH, HOME: homedir(), LIMA_HOME: config.cube.limaHome, CSA_LOCAL_REGISTRY_DATA_DIR: process.env.CSA_LOCAL_REGISTRY_DATA_DIR },
    encoding: 'utf8', timeout: 60_000, maxBuffer: 1024 * 1024,
  });
  if (result.status !== 0) throw new Error(`Cube tunnel recovery failed (${result.status ?? result.error?.message ?? 'unknown'}): ${result.stderr.slice(-1000)}`);
  log('tunnel.ready');
}
function freeLabBytes() { const s = statfsSync(config.cube.limaHome); return s.bavail * s.bsize; }
async function activeTaskCount() {
  const [rows] = await pool.query<RowDataPacket[]>("SELECT COUNT(*) AS n FROM runs WHERE status NOT IN ('done', 'failed', 'cancelled')");
  return Number(rows[0]?.n || 0);
}
async function states() {
  const rows = await Sandbox.list(cube);
  return rows.map(row => ({ id: String(row.sandboxID || row.sandbox_id || row.id || ''), state: String(row.state || '') }));
}
function expectStates(actual: Array<{ id: string; state: string }>, expected: Record<string, string>) {
  if (actual.length !== Object.keys(expected).length || actual.some(item => expected[item.id] !== item.state)) {
    throw new Error(`Sandbox states differ from the expected maintenance window: ${JSON.stringify(actual)}`);
  }
}
async function waitForCube() {
  const deadline = Date.now() + 90_000;
  while (Date.now() < deadline) {
    try { if ((await fetch(`${config.cube.apiUrl}/health`, { signal: AbortSignal.timeout(3000) })).ok) return; } catch { /* tunnel can reconnect */ }
    await new Promise(resolve => setTimeout(resolve, 2000));
  }
  throw new Error('Cube API did not recover within 90 seconds.');
}
async function waitForNodeServices() {
  const deadline = Date.now() + 90_000;
  while (Date.now() < deadline) {
    try {
      if (node(['curl', '-fsS', '--max-time', '3', 'http://127.0.0.1:3000/health']) === '{"status":"ok"}') return;
    } catch { /* Cube containers may still be starting. */ }
    await new Promise(resolve => setTimeout(resolve, 2000));
  }
  throw new Error('Cube API inside the Lima node did not recover within 90 seconds.');
}
async function restoreRunning() {
  for (const id of runningIds) {
    const deadline = Date.now() + 90_000;
    let item = (await states()).find(row => row.id === id);
    while (item && (item.state === 'pausing' || item.state === 'unknown') && Date.now() < deadline) {
      await new Promise(resolve => setTimeout(resolve, 2000));
      item = (await states()).find(row => row.id === id);
    }
    if (!item) throw new Error(`Previously running sandbox ${id} is missing.`);
    if (item.state === 'paused') {
      log('sandbox.resume.start', { sandboxId: id });
      const sandbox = await Sandbox.connect(id, { config: cube });
      sandbox.close();
      log('sandbox.resume.requested', { sandboxId: id });
    } else if (item.state !== 'running') throw new Error(`Sandbox ${id} is in unexpected state ${item.state}.`);
  }
  const deadline = Date.now() + 90_000;
  while (Date.now() < deadline) {
    const now = await states();
    if (runningIds.every(id => now.some(row => row.id === id && row.state === 'running')) && pausedIds.every(id => now.some(row => row.id === id && row.state === 'paused'))) return;
    await new Promise(resolve => setTimeout(resolve, 2000));
  }
  throw new Error('The original sandbox states did not recover within 90 seconds.');
}
try {
  if (await activeTaskCount()) throw new Error('The application has active or queued tasks; no node interruption was started.');
  expectStates(await states(), Object.fromEntries([...runningIds.map(id => [id, 'running']), ...pausedIds.map(id => [id, 'paused'])]));
  log('preflight.passed', { runningIds, pausedIds, labFreeBytes: freeLabBytes() });
  node(['sudo', '-n', 'bash', '-c', 'set -eu; mountpoint -q /data/shared/csa-tenant-workspaces; test "$(stat -c "%d:%i" /data/cubelet/csa-tenant-workspaces)" = "$(stat -c "%d:%i" /data/shared/csa-tenant-workspaces)"; umask 077; set -C; printf %s "$2" > "$1"', '--', markerPath, marker]);
  markerCreated = true;
  log('workspace.marker.created');

  for (const id of runningIds) {
    if (await activeTaskCount()) throw new Error('A task became active during preflight; aborting the restart.');
    log('sandbox.pause.start', { sandboxId: id });
    pauseAttempted = true;
    const sandbox = new Sandbox({ sandboxID: id }, cube);
    try { await sandbox.pause({ wait: true, timeoutMs: 180_000, intervalMs: 2000 }); }
    finally { sandbox.close(); }
    log('sandbox.pause.complete', { sandboxId: id });
  }
  expectStates(await states(), Object.fromEntries([...runningIds, ...pausedIds].map(id => [id, 'paused'])));
  const freeBytes = freeLabBytes();
  if (freeBytes < 12 * 1024 ** 3) throw new Error(`After pausing VMs the lab has only ${freeBytes} bytes free; node restart was skipped.`);
  log('snapshot.preflight.passed', { labFreeBytes: freeBytes });

  stopAttempted = true;
  log('node.stop.start');
  lima(['--tty=false', 'stop', 'cube-node'], 120_000);
  log('node.stop.complete');
  log('node.start.start');
  lima(['--tty=false', 'start', 'cube-node', '--timeout', '120s'], 150_000);
  log('node.start.complete');
  ensureTunnel();
  await waitForCube();
  expectStates(await states(), Object.fromEntries([...runningIds, ...pausedIds].map(id => [id, 'paused'])));
  node(['sudo', '-n', 'bash', '-c', 'set -eu; mountpoint -q /data/shared/csa-tenant-workspaces; test "$(stat -c "%d:%i" /data/cubelet/csa-tenant-workspaces)" = "$(stat -c "%d:%i" /data/shared/csa-tenant-workspaces)"; test "$(cat "$1")" = "$2"', '--', markerPath, marker]);
  if (!node(['hostname', '-I']).split(/\s+/).includes(nodePrivateIp)) throw new Error('The configured private-network probe is no longer a node address.');
  log('workspace.mount.after-restart.passed');
  await restoreRunning();
  log('sandbox.states.restored');

  for (const id of runningIds) {
    const [rows] = await pool.execute<RowDataPacket[]>('SELECT tenant_id FROM computers WHERE sandbox_id = ?', [id]);
    if (!rows[0]?.tenant_id) throw new Error(`No tenant record for sandbox ${id}.`);
    const sandbox = await connectTenantSandbox(String(rows[0].tenant_id));
    try {
      const result = await sandbox.commands.run(`python3 - <<'PY'
import json,socket
r={}
for name,host,port in [('private','${nodePrivateIp}',22),('public','api.deepseek.com',443)]:
 try:
  with socket.create_connection((host,port),timeout=4): r[name]=True
 except OSError: r[name]=False
print(json.dumps(r))
PY`, { timeoutMs: 30_000 });
      const observed = JSON.parse(result.stdout) as { private?: boolean; public?: boolean };
      if (result.exitCode !== 0 || observed.private !== false || observed.public !== true) throw new Error(`Sandbox ${id} failed the post-restart network probe.`);
      log('sandbox.network.after-restart.passed', { sandboxId: id, privateConnected: observed.private, publicConnected: observed.public });
    } finally { sandbox.close(); }
  }
  expectStates(await states(), Object.fromEntries([...runningIds.map(id => [id, 'running']), ...pausedIds.map(id => [id, 'paused'])]));
  log('verification.passed');
} catch (error) {
  failed = true;
  let message = error instanceof Error ? error.message : String(error);
  for (const secret of [config.cube.apiKey, config.mysql.password, config.tokenEncryptionKey].filter(Boolean)) message = message.replaceAll(secret, '[redacted]');
  log('verification.failed', { error: message });
} finally {
  if (stopAttempted) {
    try { await waitForNodeServices(); ensureTunnel(); await waitForCube(); }
    catch {
      try { log('recovery.node.start'); lima(['--tty=false', 'start', 'cube-node', '--timeout', '120s'], 150_000); await waitForNodeServices(); ensureTunnel(); await waitForCube(); }
      catch (error) { failed = true; log('recovery.node.failed', { error: error instanceof Error ? error.message : String(error) }); }
    }
  }
  if (pauseAttempted) {
    try { await restoreRunning(); log('recovery.original-states.confirmed'); }
    catch (error) { failed = true; log('recovery.original-states.failed', { error: error instanceof Error ? error.message : String(error) }); }
  }
  if (markerCreated) {
    try { node(['sudo', '-n', 'bash', '-c', 'set -eu; mountpoint -q /data/shared/csa-tenant-workspaces; test "$(cat "$1")" = "$2"; unlink -- "$1"', '--', markerPath, marker]); log('workspace.marker.removed'); }
    catch (error) { failed = true; log('workspace.marker.cleanup.failed', { error: error instanceof Error ? error.message : String(error) }); }
  }
  await pool.end();
  log('complete', { success: !failed });
  process.stdout.write(`diagnostic_log=${logPath}\n`);
  if (failed) process.exitCode = 1;
}
