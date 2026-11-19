import { Config, NEVER_TIMEOUT, Sandbox, SandboxNotFoundError } from '@cubesandbox/sdk';
import type { PoolConnection, RowDataPacket } from 'mysql2/promise';
import type { ComputerState, ComputerView } from '../shared/types.ts';
import { pool } from './db.ts';
import { config } from './config.ts';

interface ComputerRow extends RowDataPacket {
  sandbox_id: string | null;
  state: ComputerState;
  generation: number;
  updated_at: Date | string;
}

interface ComputerOperation {
  generation: number;
  sandboxId: string | null;
}

export class ComputerNotConfiguredError extends Error {}
export class ComputerOperationError extends Error {}

function cubeConfig(): Config {
  if (!config.cube.apiUrl || !config.cube.templateId) {
    throw new ComputerNotConfiguredError('CubeSandbox API 和模板尚未配置。');
  }
  return new Config({
    apiUrl: config.cube.apiUrl,
    apiKey: config.cube.apiKey || undefined,
    templateId: config.cube.templateId,
    proxyNodeIp: config.cube.proxyNodeIp || undefined,
    proxyPort: config.cube.proxyPort,
    proxyScheme: config.cube.proxyScheme,
    requestTimeoutMs: config.cube.requestTimeoutMs,
  });
}

function view(row: ComputerRow): ComputerView {
  return { state: row.state, updatedAt: new Date(row.updated_at).toISOString() };
}

export async function getTenantComputer(tenantId: string): Promise<ComputerView> {
  const [rows] = await pool.execute<ComputerRow[]>(
    'SELECT sandbox_id, state, generation, updated_at FROM computers WHERE tenant_id = ? LIMIT 1',
    [tenantId],
  );
  if (!rows[0]) return { state: 'not_created', updatedAt: new Date().toISOString() };
  return view(rows[0]);
}

async function reserveOperation(tenantId: string, connection: PoolConnection): Promise<ComputerOperation | null> {
  await connection.beginTransaction();
  let committed = false;
  try {
    await connection.execute('INSERT IGNORE INTO computers (tenant_id) VALUES (?)', [tenantId]);
    const [rows] = await connection.execute<ComputerRow[]>(
      'SELECT sandbox_id, state, generation, updated_at FROM computers WHERE tenant_id = ? FOR UPDATE',
      [tenantId],
    );
    const current = rows[0];
    if (!current) throw new Error('Tenant computer row could not be loaded.');
    if (current.state === 'creating' || (current.state === 'running' && current.sandbox_id)) {
      await connection.commit();
      committed = true;
      return null;
    }

    const generation = Number(current.generation) + 1;
    await connection.execute(
      "UPDATE computers SET state = 'creating', generation = ?, template_id = ? WHERE tenant_id = ?",
      [generation, config.cube.templateId, tenantId],
    );
    await connection.commit();
    committed = true;
    return { generation, sandboxId: current.sandbox_id };
  } catch (error) {
    if (!committed) await connection.rollback();
    throw error;
  }
}

export async function startTenantComputer(tenantId: string): Promise<ComputerView> {
  const cube = cubeConfig();
  const connection = await pool.getConnection();
  let operation: ComputerOperation | null;
  try {
    operation = await reserveOperation(tenantId, connection);
  } finally {
    connection.release();
  }
  if (!operation) return getTenantComputer(tenantId);

  let sandbox: Sandbox | undefined;
  let persisted = false;
  try {
    sandbox = operation.sandboxId
      ? await Sandbox.connect(operation.sandboxId, { config: cube })
      : await Sandbox.create({
          config: cube,
          template: config.cube.templateId,
          timeout: NEVER_TIMEOUT,
          allowInternetAccess: true,
          metadata: { coke_tenant_id: tenantId, coke_generation: String(operation.generation) },
        });
    const [result] = await pool.execute(
      "UPDATE computers SET sandbox_id = ?, template_id = ?, state = 'running' WHERE tenant_id = ? AND generation = ? AND state = 'creating'",
      [sandbox.sandboxId, sandbox.templateId, tenantId, operation.generation],
    );
    if ((result as { affectedRows: number }).affectedRows !== 1) {
      throw new Error('Tenant computer generation changed during CubeSandbox operation.');
    }
    persisted = true;
    return getTenantComputer(tenantId);
  } catch (error) {
    if (!persisted) {
      if (operation.sandboxId && error instanceof SandboxNotFoundError) {
        await pool.execute(
          "UPDATE computers SET sandbox_id = NULL, state = 'failed' WHERE tenant_id = ? AND generation = ? AND state = 'creating'",
          [tenantId, operation.generation],
        );
      } else {
        await pool.execute(
          "UPDATE computers SET state = 'failed' WHERE tenant_id = ? AND generation = ? AND state = 'creating'",
          [tenantId, operation.generation],
        );
      }
      if (!operation.sandboxId && sandbox) await sandbox.kill().catch(() => undefined);
    }
    const reason = error instanceof Error ? error.message.slice(0, 240) : 'unknown error';
    const safeReason = config.cube.apiKey ? reason.replaceAll(config.cube.apiKey, '[redacted]') : reason;
    process.stderr.write('CubeSandbox computer operation failed: ' + safeReason + '\n');
    throw new ComputerOperationError('CubeSandbox 暂时无法启动云电脑，请稍后重试。');
  } finally {
    sandbox?.close();
  }
}
