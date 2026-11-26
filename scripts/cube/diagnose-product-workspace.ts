import 'dotenv/config';
import { spawnSync } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { appendFileSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { RowDataPacket } from 'mysql2/promise';
import { Sandbox } from '@cubesandbox/sdk';
import { ComputerRecoveryRequiredError, connectTenantSandbox, cubeConfig, startTenantComputer } from '../../src/server/computer.ts';
import { config } from '../../src/server/config.ts';
import { pool } from '../../src/server/db.ts';
import { migrate } from '../../src/server/migrate.ts';
import { seedLocalTenants } from '../../src/server/seed.ts';

if (!/^csa_workspace_test_[a-f0-9]+$/.test(config.mysql.database) || config.mysql.host !== '127.0.0.1' || config.mysql.port !== 13317 || config.cube.workspaceMode !== 'lima' || !['127.0.0.1', 'localhost', '::1'].includes(new URL(config.cube.apiUrl).hostname)) {
  throw new Error('Use a disposable csa_workspace_test_* schema on local test MySQL, local Cube, and the Lima workspace helper.');
}
const runId = randomUUID();
const logDir = process.env.CSA_BUILD_LOG_DIR || join(homedir(), '.local/share/csa-cube-node/build-logs');
mkdirSync(logDir, { recursive: true, mode: 0o700 });
const logPath = join(logDir, `product-workspace-${new Date().toISOString().replace(/[:.]/g, '-')}-${runId}.jsonl`);
const started = Date.now();
function log(stage: string, details: Record<string, unknown> = {}) {
  const line = JSON.stringify({ timestamp: new Date().toISOString(), runId, elapsedMs: Date.now() - started, stage, ...details }) + '\n';
  process.stdout.write(line);
  appendFileSync(logPath, line, { mode: 0o600 });
}
function nodeCommand(args: string[]) {
  const result = spawnSync(config.cube.limaCommand, ['shell', 'cube-node', '--', ...args], {
    env: { ...process.env, LIMA_HOME: config.cube.limaHome }, encoding: 'utf8', timeout: 30_000,
  });
  if (result.status !== 0) throw new Error(`Node command failed (${result.status ?? result.error?.message ?? 'unknown'}): ${result.stderr.slice(-600)}`);
  return result.stdout.trim();
}
let tenantId = '';
let active: Sandbox | undefined;
let creationUncertain = false;
let creationPhase: 'product' | 'replacement' = 'product';
let failed = false;
try {
  await migrate();
  await seedLocalTenants();
  const [tenants] = await pool.execute<RowDataPacket[]>("SELECT id FROM tenants WHERE slug = 'alpha'");
  tenantId = String(tenants[0]?.id || '');
  if (!/^[0-9a-f-]{36}$/.test(tenantId)) throw new Error('Disposable tenant not found.');
  const workspace = `/data/shared/csa-tenant-workspaces/${tenantId}`;
  const marker = randomBytes(16).toString('hex');

  log('product.create.start', { tenantId });
  creationUncertain = true;
  const view = await startTenantComputer(tenantId, { purpose: 'task' });
  if (view.state !== 'running') throw new Error(`Product did not start the test VM: ${view.state}`);
  active = await connectTenantSandbox(tenantId);
  creationUncertain = false;
  const originalId = active.sandboxId;
  const [rows] = await pool.execute<RowDataPacket[]>('SELECT sandbox_id, create_pending FROM computers WHERE tenant_id = ?', [tenantId]);
  if (rows[0]?.sandbox_id !== originalId || rows[0]?.create_pending !== 0) throw new Error('Product did not persist its VM ID and clear create_pending.');
  log('product.create.complete', { tenantId, sandboxId: originalId });

  const write = await active.commands.run(`set -eu; u="$(getent passwd 1000 | cut -d: -f1)"; test -n "$u"; runuser -u "$u" -- sh -c 'printf %s ${marker} > /workspace/product-proof.txt'; stat -f -c 'filesystem=%T' /workspace`, { timeoutMs: 40_000 });
  if (write.exitCode !== 0) throw new Error(`Tenant workspace write failed: ${write.stderr.slice(-500)}`);
  const hostResult = nodeCommand(['sudo', '-n', 'bash', '-c', 'set -eu; test "$(cat "$1/product-proof.txt")" = "$2"; printf verified', '--', workspace, marker]);
  if (hostResult !== 'verified') throw new Error('The product workspace did not reach the XFS-backed node directory.');
  log('product.workspace.write.passed', { tenantId, sandboxId: originalId, filesystem: write.stdout.trim() });

  await active.kill(); active.close(); active = undefined;
  log('product.original.killed', { sandboxId: originalId });
  let preserved = false;
  try { await startTenantComputer(tenantId, { purpose: 'task' }); }
  catch (error) { if (error instanceof ComputerRecoveryRequiredError) preserved = true; else throw error; }
  if (!preserved) throw new Error('A missing original VM did not raise the recovery error.');
  const [after] = await pool.execute<RowDataPacket[]>('SELECT sandbox_id, state FROM computers WHERE tenant_id = ?', [tenantId]);
  if (after[0]?.sandbox_id !== originalId || after[0]?.state !== 'failed') throw new Error('Missing VM identity was not preserved.');
  log('product.missing-vm.protection.passed', { sandboxId: originalId });

  const cube = cubeConfig();
  creationPhase = 'replacement';
  for (let attempt = 1; attempt <= 7; attempt += 1) {
    log('replacement.create.start', { attempt });
    creationUncertain = true;
    try {
      active = await Sandbox.create({
        config: cube, template: config.cube.templateId, timeout: 300,
        allowInternetAccess: true, network: { allowPublicTraffic: false }, extra: { restartPolicy: 'Never' },
        metadata: { csa_workspace_e2e: runId, 'host-mount': JSON.stringify([{ hostPath: workspace, mountPath: '/workspace', readOnly: false }]) },
      });
      creationUncertain = false;
      break;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (!/error code 130597: no more resource/i.test(message)) throw error;
      creationUncertain = false;
      if (attempt === 7) throw error;
      log('replacement.resource-wait', { attempt, delayMs: 8_000 });
      await new Promise(resolve => setTimeout(resolve, 8_000));
    }
  }
  if (!active) throw new Error('Replacement VM was not created.');
  const read = await active.commands.run(`set -eu; test "$(cat /workspace/product-proof.txt)" = '${marker}'; printf persisted`, { timeoutMs: 30_000 });
  if (read.exitCode !== 0 || read.stdout.trim() !== 'persisted') throw new Error('Replacement did not recover the product-created workspace.');
  log('replacement.workspace.passed', { sandboxId: active.sandboxId, originalSandboxId: originalId });
} catch (error) {
  failed = true;
  let message = error instanceof Error ? error.message : String(error);
  for (const secret of [config.cube.apiKey, config.mysql.password, config.tokenEncryptionKey].filter(Boolean)) message = message.replaceAll(secret, '[redacted]');
  log('diagnostic.failed', { error: message });
} finally {
  if (!active && creationUncertain && creationPhase === 'product' && tenantId) {
    try {
      const [rows] = await pool.execute<RowDataPacket[]>('SELECT sandbox_id, create_pending FROM computers WHERE tenant_id = ?', [tenantId]);
      if (rows[0]?.sandbox_id) {
        const recovered = new Sandbox({ sandboxID: String(rows[0].sandbox_id) }, cubeConfig());
        await recovered.getInfo();
        active = recovered;
        creationUncertain = false;
        log('sandbox.cleanup.recovered', { sandboxId: recovered.sandboxId });
      } else if (rows[0]?.create_pending === 0) {
        creationUncertain = false;
      }
    } catch (error) { log('sandbox.cleanup.recovery-unconfirmed', { error: error instanceof Error ? error.name : 'unknown' }); }
  }
  if (active) {
    try { const id = active.sandboxId; await active.kill(); active.close(); active = undefined; log('sandbox.cleanup.complete', { sandboxId: id }); }
    catch (error) { failed = true; log('sandbox.cleanup.failed', { sandboxId: active?.sandboxId, error: error instanceof Error ? error.name : 'unknown' }); }
  }
  if (tenantId && !active && !creationUncertain) {
    const workspace = `/data/shared/csa-tenant-workspaces/${tenantId}`;
    try {
      // This path belongs to the freshly-created random test tenant only.
      nodeCommand(['sudo', '-n', 'bash', '-c', 'set -eu; test -d "$1"; test ! -L "$1"; find "$1" -xdev -mindepth 1 -delete; rmdir -- "$1"', '--', workspace]);
      log('workspace.cleanup.complete', { tenantId });
    } catch (error) { failed = true; log('workspace.cleanup.failed', { tenantId, error: error instanceof Error ? error.message : String(error) }); }
  } else if (tenantId) log('workspace.cleanup.skipped', { tenantId, reason: 'VM creation or cleanup was not confirmed' });
  await pool.end();
  log('diagnostic.complete', { success: !failed });
  process.stdout.write(`diagnostic_log=${logPath}\n`, () => process.exit(failed ? 1 : 0));
}
