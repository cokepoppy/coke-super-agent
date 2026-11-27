import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { Config, NEVER_TIMEOUT, Sandbox, SandboxNotFoundError } from '@cubesandbox/sdk';
import type { PoolConnection, RowDataPacket } from 'mysql2/promise';
import { runGuestPty } from './runtime-bundle.ts';
import type { BrowserState, ComputerState, ComputerView, RunTraceEvent } from '../shared/types.ts';
import { pool } from './db.ts';
import { config } from './config.ts';
import { assertTokenEncryptionKey, decryptSandboxTrafficToken, encryptSandboxTrafficToken } from './token-crypto.ts';
import { sanitizeRunTrace } from './task-store.ts';
import { provisionTenantWorkspace, TenantWorkspaceConfigurationError } from './tenant-workspace.ts';

interface ComputerRow extends RowDataPacket {
  sandbox_id: string | null;
  cube_traffic_token_ciphertext?: string | null;
  state: ComputerState;
  desktop_state: ComputerView['desktopState'];
  generation: number;
  create_pending?: number;
  updated_at: Date | string;
}

type ComputerOperation = { generation: number } & (
  | { kind: 'vm'; sandboxId: string | null; trafficTokenCiphertext: string | null }
  | { kind: 'desktop'; sandboxId: string; trafficTokenCiphertext: string }
);

const desktopBootstrapByTenant = new Map<string, Promise<void>>();
const desktopBootstrapTimeoutMs = 30 * 60_000;

type TraceSink = (event: RunTraceEvent) => Promise<void>;
type ComputerStartOptions = { purpose?: 'desktop' | 'task'; trace?: TraceSink; runId?: string };

async function emitTrace(sink: TraceSink | undefined, event: RunTraceEvent, tenantId?: string, runId?: string): Promise<void> {
  const safeEvent = sanitizeRunTrace(event);
  process.stdout.write(JSON.stringify({
    timestamp: new Date().toISOString(),
    logger: 'coke-super-agent.computer',
    ...(tenantId ? { tenantId } : {}),
    ...(runId ? { runId } : {}),
    ...safeEvent,
  }) + '\n');
  if (!sink) return;
  try { await sink(safeEvent); }
  catch (error) {
    const failure = sanitizeRunTrace({ component: 'trace-store', stage: 'computer.event.persist.failed', level: 'error', message: error instanceof Error ? error.message : String(error) });
    process.stderr.write(JSON.stringify({ timestamp: new Date().toISOString(), logger: 'coke-super-agent.computer', ...failure }) + '\n');
  }
}

function errorDetails(error: unknown): Record<string, string> {
  const value = error instanceof Error ? error : new Error(String(error));
  const detail: Record<string, string> = {
    errorName: value.name || 'Error',
    errorMessage: value.message,
  };
  if (value.stack) detail.errorStack = value.stack;
  if (value.cause instanceof Error) {
    detail.errorCause = value.cause.message;
    if (value.cause.stack) detail.errorCauseStack = value.cause.stack;
  }
  const diagnostics = (value as Error & { diagnostics?: Record<string, unknown> }).diagnostics;
  if (diagnostics) {
    for (const [key, item] of Object.entries(diagnostics)) {
      if (typeof item === 'string' || typeof item === 'number' || typeof item === 'boolean') {
        detail[key] = String(item);
      }
    }
  }
  const secrets = [config.agent.apiKey, config.cube.apiKey].filter(Boolean);
  for (const key of Object.keys(detail)) {
    detail[key] = secrets.reduce((text, secret) => text.split(secret).join('[redacted]'), detail[key]);
  }
  return detail;
}

export class ComputerNotConfiguredError extends Error {}
export class ComputerOperationError extends Error {}
export class ComputerRecoveryRequiredError extends ComputerOperationError {}
export class ComputerNotReadyError extends Error {}
export class DesktopNotReadyError extends ComputerNotReadyError {}
class DesktopBootstrapLeaseLostError extends Error {}

const missingSandboxMessage = '原租户 microVM 不存在，工作区可能需要恢复。已保留原电脑记录，未创建空白电脑。';
const uncertainCreateMessage = '上次 microVM 创建结果尚未确认。为保护租户工作区，已暂停重复创建，请先核对 Cube 控制面。';

function tenantTemplateId(): string {
  // New tenants use the preinstalled OCI template. Keep the legacy snapshot
  // only as a fallback for installations that have no CUBE_TEMPLATE_ID yet.
  return config.cube.templateId || config.cube.dshTemplateSnapshotId;
}

export function cubeConfig(): Config {
  const templateId = tenantTemplateId();
  if (!config.cube.apiUrl || !templateId) {
    throw new ComputerNotConfiguredError('CubeSandbox API 和模板尚未配置。');
  }
  return new Config({
    apiUrl: config.cube.apiUrl,
    apiKey: config.cube.apiKey || undefined,
    templateId,
    proxyNodeIp: config.cube.proxyNodeIp || undefined,
    proxyPort: config.cube.proxyPort,
    proxyScheme: config.cube.proxyScheme,
    sandboxDomain: config.cube.sandboxDomain,
    requestTimeoutMs: config.cube.requestTimeoutMs,
  });
}

function view(row: ComputerRow): ComputerView {
  return { state: row.state, desktopState: row.desktop_state, updatedAt: new Date(row.updated_at).toISOString() };
}

export async function getTenantComputer(tenantId: string): Promise<ComputerView> {
  const [rows] = await pool.execute<ComputerRow[]>(
    'SELECT sandbox_id, cube_traffic_token_ciphertext, state, desktop_state, generation, updated_at FROM computers WHERE tenant_id = ? LIMIT 1',
    [tenantId],
  );
  if (!rows[0]) return { state: 'not_created', desktopState: 'pending', updatedAt: new Date().toISOString() };
  if (rows[0].state === 'running' && rows[0].sandbox_id && rows[0].desktop_state === 'installing' && rows[0].cube_traffic_token_ciphertext && !desktopBootstrapByTenant.has(tenantId)) {
    scheduleDesktopBootstrap(tenantId, rows[0].sandbox_id, Number(rows[0].generation), rows[0].cube_traffic_token_ciphertext);
  }
  return view(rows[0]);
}

async function reserveOperation(tenantId: string, connection: PoolConnection, purpose: 'desktop' | 'task'): Promise<ComputerOperation | null> {
  await connection.beginTransaction();
  let committed = false;
  try {
    await connection.execute('INSERT IGNORE INTO computers (tenant_id) VALUES (?)', [tenantId]);
    const [rows] = await connection.execute<ComputerRow[]>(
      'SELECT sandbox_id, cube_traffic_token_ciphertext, state, desktop_state, generation, create_pending, updated_at FROM computers WHERE tenant_id = ? FOR UPDATE',
      [tenantId],
    );
    const current = rows[0];
    if (!current) throw new Error('Tenant computer row could not be loaded.');

    const operationIsRecent = Date.now() - new Date(current.updated_at).getTime() < 5 * 60_000;
    if (current.state === 'creating' && operationIsRecent) {
      await connection.commit();
      committed = true;
      return null;
    }
    if (current.create_pending && !current.sandbox_id) throw new ComputerRecoveryRequiredError(uncertainCreateMessage);
    if (current.state === 'running' && current.sandbox_id && current.cube_traffic_token_ciphertext) {
      if (purpose === 'task' || current.desktop_state === 'ready' || current.desktop_state === 'installing' || desktopBootstrapByTenant.has(tenantId)) {
        await connection.commit();
        committed = true;
        return null;
      }
      const generation = Number(current.generation) + 1;
      await connection.execute(
        "UPDATE computers SET generation = ?, desktop_state = 'installing', desktop_updated_at = UTC_TIMESTAMP(3) WHERE tenant_id = ?",
        [generation, tenantId],
      );
      await connection.commit();
      committed = true;
      return { kind: 'desktop', generation, sandboxId: current.sandbox_id, trafficTokenCiphertext: current.cube_traffic_token_ciphertext };
    }

    const generation = Number(current.generation) + 1;
    await connection.execute(
      "UPDATE computers SET state = 'creating', generation = ?, desktop_state = ?, desktop_updated_at = UTC_TIMESTAMP(3) WHERE tenant_id = ?",
      [generation, current.sandbox_id ? 'installing' : 'pending', tenantId],
    );
    await connection.commit();
    committed = true;
    return { kind: 'vm', generation, sandboxId: current.sandbox_id, trafficTokenCiphertext: current.cube_traffic_token_ciphertext || null };
  } catch (error) {
    if (!committed) await connection.rollback();
    throw error;
  }
}

export async function startTenantComputer(tenantId: string, options: ComputerStartOptions = {}): Promise<ComputerView> {
  const { purpose = 'desktop', trace, runId } = options;
  const startedAt = Date.now();
  await emitTrace(trace, { component: 'computer', stage: 'start', level: 'info', message: '开始检查租户 microVM。', details: { purpose } }, tenantId, runId);
  let cube: Config;
  try {
    cube = cubeConfig();
    await emitTrace(trace, { component: 'configuration', stage: 'cube.config.ready', level: 'info', message: 'CubeSandbox 控制面、模板与数据面连接配置已就绪。', details: { templateId: tenantTemplateId(), requestTimeoutMs: cube.requestTimeoutMs } }, tenantId, runId);
  } catch (error) {
    await emitTrace(trace, { component: 'configuration', stage: 'cube.config.failed', level: 'error', message: 'CubeSandbox 配置校验失败。', details: errorDetails(error) }, tenantId, runId);
    throw error;
  }
  try { assertTokenEncryptionKey(); }
  catch (error) {
    await emitTrace(trace, { component: 'configuration', stage: 'computer.token-encryption-key.failed', level: 'error', message: '租户 microVM 数据面令牌加密密钥校验失败。', details: errorDetails(error) }, tenantId, runId);
    throw new ComputerNotConfiguredError('请先在仓库外环境文件中设置 CSA_TOKEN_ENCRYPTION_KEY。');
  }
  const missingRecordCheckStartedAt = Date.now();
  await emitTrace(trace, { component: 'computer', stage: 'record.reconcile.start', level: 'info', message: '检查 MySQL 中运行记录对应的 microVM 是否仍存在。' }, tenantId, runId);
  try {
    await assertExistingSandbox(tenantId, cube);
    await emitTrace(trace, { component: 'computer', stage: 'record.reconcile.complete', level: 'info', message: '租户 microVM 记录检查完成。', durationMs: Date.now() - missingRecordCheckStartedAt }, tenantId, runId);
  } catch (error) {
    await emitTrace(trace, { component: 'computer', stage: 'record.reconcile.failed', level: 'error', message: '检查 MySQL 与 CubeSandbox microVM 状态时失败。', durationMs: Date.now() - missingRecordCheckStartedAt, details: errorDetails(error) }, tenantId, runId);
    throw error;
  }
  const reserveStartedAt = Date.now();
  let connection: PoolConnection;
  try {
    connection = await pool.getConnection();
  } catch (error) {
    await emitTrace(trace, { component: 'database', stage: 'computer.connection.failed', level: 'error', message: '无法取得 MySQL 连接以预约租户云电脑操作。', durationMs: Date.now() - reserveStartedAt, details: errorDetails(error) }, tenantId, runId);
    throw error;
  }
  let operation: ComputerOperation | null;
  try {
    operation = await reserveOperation(tenantId, connection, purpose);
    await emitTrace(trace, { component: 'database', stage: 'computer.operation.reserve.complete', level: 'info', message: 'MySQL 云电脑操作预约事务已完成。', durationMs: Date.now() - reserveStartedAt, details: { generation: operation?.generation ?? null, reserved: Boolean(operation) } }, tenantId, runId);
  } catch (error) {
    await emitTrace(trace, { component: 'database', stage: 'computer.operation.reserve.failed', level: 'error', message: 'MySQL 云电脑操作预约事务失败。', durationMs: Date.now() - reserveStartedAt, details: errorDetails(error) }, tenantId, runId);
    throw error;
  } finally {
    connection.release();
  }
  if (!operation) {
    const current = await getTenantComputer(tenantId);
    if (purpose === 'desktop' && current.state === 'running' && current.desktopState === 'ready') {
      const [rows] = await pool.execute<ComputerRow[]>(
        'SELECT sandbox_id, generation FROM computers WHERE tenant_id = ? AND state = \'running\' AND desktop_state = \'ready\' LIMIT 1',
        [tenantId],
      );
      const readyRow = rows[0];
      if (readyRow?.sandbox_id) {
        const healthy = await probeTenantDesktop(tenantId, readyRow.sandbox_id, Number(readyRow.generation), trace, runId);
        if (!healthy) {
          const [updated] = await pool.execute(
            "UPDATE computers SET desktop_state = 'failed', desktop_updated_at = UTC_TIMESTAMP(3) WHERE tenant_id = ? AND sandbox_id = ? AND generation = ? AND state = 'running' AND desktop_state = 'ready'",
            [tenantId, readyRow.sandbox_id, readyRow.generation],
          );
          if ((updated as { affectedRows: number }).affectedRows === 1) {
            await emitTrace(trace, { component: 'desktop', stage: 'health.recovery.schedule', level: 'warning', message: 'MySQL 中的 ready 状态与访客机实时桌面探测不符，保留原 microVM 并重新启动桌面初始化。', details: { sandboxId: readyRow.sandbox_id, generation: Number(readyRow.generation) } }, tenantId, runId);
            return startTenantComputer(tenantId, options);
          }
          await emitTrace(trace, { component: 'desktop', stage: 'health.recovery.concurrent-change', level: 'info', message: '实时桌面探测期间租户云电脑状态已被其他操作更新。' }, tenantId, runId);
          return getTenantComputer(tenantId);
        }
      }
    }
    await emitTrace(trace, { component: 'computer', stage: 'reuse', level: 'info', message: '复用租户现有 microVM。', durationMs: Date.now() - startedAt, details: { computerState: current.state, desktopState: current.desktopState } }, tenantId, runId);
    return current;
  }
  await emitTrace(trace, { component: 'computer', stage: 'operation.reserved', level: 'info', message: 'MySQL 已为本次云电脑操作分配 generation。', details: { generation: operation.generation, operation: operation.kind, existingSandbox: Boolean(operation.sandboxId) } }, tenantId, runId);
  if (operation.kind === 'desktop') {
    scheduleDesktopBootstrap(tenantId, operation.sandboxId, operation.generation, operation.trafficTokenCiphertext, trace, runId);
    return getTenantComputer(tenantId);
  }

  let sandbox: Sandbox | undefined;
  let persisted = false;
  let creationSubmitted = false;
  try {
    if (operation.sandboxId) {
      await emitTrace(trace, { component: 'cube', stage: 'sandbox.probe', level: 'info', message: '控制面正在检查已保存的租户 microVM。', details: { sandboxId: operation.sandboxId, generation: operation.generation } }, tenantId, runId);
      const probe = new Sandbox({ sandboxID: operation.sandboxId }, cube);
      let sandboxMissing = false;
      let sandboxState = 'unknown';
      try {
        const info = await probe.getInfo();
        sandboxState = info.state;
      } catch (error) {
        if (!isSandboxNotFoundError(error)) throw error;
        sandboxMissing = true;
      } finally {
        probe.close();
      }
      if (sandboxMissing) {
        await emitTrace(trace, { component: 'cube', stage: 'sandbox.missing', level: 'error', message: missingSandboxMessage, details: { sandboxId: operation.sandboxId } }, tenantId, runId);
        const [updated] = await pool.execute(
          "UPDATE computers SET state = 'failed', desktop_state = 'failed', desktop_updated_at = UTC_TIMESTAMP(3) WHERE tenant_id = ? AND sandbox_id = ? AND generation = ? AND state = 'creating'",
          [tenantId, operation.sandboxId, operation.generation],
        );
        if ((updated as { affectedRows: number }).affectedRows === 1) throw new ComputerRecoveryRequiredError(missingSandboxMessage);
        return getTenantComputer(tenantId);
      }

      await emitTrace(trace, { component: 'cube', stage: 'sandbox.reuse', level: 'info', message: '控制面确认租户 microVM 仍存在。', details: { sandboxId: operation.sandboxId, state: sandboxState } }, tenantId, runId);

      if (!operation.trafficTokenCiphertext) throw new Error('该租户 VM 缺少保存的数据面令牌，需要重建空白测试 VM。');
      const [result] = await pool.execute(
        "UPDATE computers SET state = 'running', desktop_state = 'installing', desktop_updated_at = UTC_TIMESTAMP(3) WHERE tenant_id = ? AND generation = ? AND state = 'creating'",
        [tenantId, operation.generation],
      );
      if ((result as { affectedRows: number }).affectedRows !== 1) {
        throw new Error('Tenant computer generation changed during CubeSandbox recovery.');
      }
      persisted = true;
      await emitTrace(trace, { component: 'computer', stage: 'record.persisted', level: 'info', message: '已将恢复的 microVM 状态更新到 MySQL。', details: { sandboxId: operation.sandboxId, generation: operation.generation, desktopState: 'installing' } }, tenantId, runId);
      await emitTrace(trace, { component: 'computer', stage: 'desktop.bootstrap.schedule', level: 'info', message: '已恢复数据库中的 microVM 记录，开始检查 Linux 桌面。', details: { generation: operation.generation } }, tenantId, runId);
      scheduleDesktopBootstrap(tenantId, operation.sandboxId, operation.generation, operation.trafficTokenCiphertext, trace, runId);
      return getTenantComputer(tenantId);
    }

    const configuredTemplateId = tenantTemplateId();
    let workspace;
    await emitTrace(trace, { component: 'workspace', stage: 'prepare.start', level: 'info', message: '准备当前租户在 Cube 数据盘上的独立工作区。' }, tenantId, runId);
    try {
      workspace = await provisionTenantWorkspace(tenantId);
      await emitTrace(trace, { component: 'workspace', stage: 'prepare.complete', level: 'info', message: '租户持久工作区已准备，创建 VM 时将挂载到 /workspace。' }, tenantId, runId);
    } catch (error) {
      await emitTrace(trace, { component: 'workspace', stage: 'prepare.failed', level: 'error', message: '租户持久工作区准备失败，未创建空白 microVM。', details: errorDetails(error) }, tenantId, runId);
      if (error instanceof TenantWorkspaceConfigurationError) throw new ComputerNotConfiguredError(error.message);
      throw error;
    }
    const [marked] = await pool.execute(
      "UPDATE computers SET create_pending = TRUE WHERE tenant_id = ? AND generation = ? AND state = 'creating' AND sandbox_id IS NULL",
      [tenantId, operation.generation],
    );
    if ((marked as { affectedRows: number }).affectedRows !== 1) throw new Error('Tenant computer generation changed before the CubeSandbox request.');
    creationSubmitted = true;
    // Cube evaluates allowOut before its built-in private-network deny list.
    // Internet access is already enabled by allowInternetAccess, so a
    // 0.0.0.0/0 allow entry would also let tenants reach node-private IPs.
    const networkPolicy = { allowPublicTraffic: false };
    await emitTrace(trace, { component: 'cube', stage: 'sandbox.create.start', level: 'info', message: '使用已构建模板创建租户 microVM，并开启公网出站访问。', details: { templateId: configuredTemplateId, generation: operation.generation, requestTimeoutMs: cube.requestTimeoutMs, restartPolicy: 'Never', allowInternetAccess: true, privateNetworkPolicy: 'cube-default', allowPublicTraffic: networkPolicy.allowPublicTraffic } }, tenantId, runId);
    sandbox = await Sandbox.create({
      config: cube,
      template: configuredTemplateId,
      timeout: NEVER_TIMEOUT,
      allowInternetAccess: true,
      network: networkPolicy,
      // Match the template's Never policy. OnFailure restarts the entire
      // microVM after its liveness probe fails, which can interrupt an active
      // Harness task and leave the tenant VM in Cube's restart backoff loop.
      extra: { restartPolicy: 'Never' },
      metadata: { coke_tenant_id: tenantId, coke_generation: String(operation.generation), 'host-mount': JSON.stringify([workspace]) },
    });
    const trafficToken = sandbox.trafficAccessToken;
    if (!trafficToken) throw new Error('CubeSandbox did not return a private data-plane token.');
    const trafficTokenCiphertext = encryptSandboxTrafficToken(trafficToken);
    const [result] = await pool.execute(
      "UPDATE computers SET sandbox_id = ?, template_id = ?, cube_traffic_token_ciphertext = ?, create_pending = FALSE, state = 'running', desktop_state = 'installing', desktop_updated_at = UTC_TIMESTAMP(3) WHERE tenant_id = ? AND generation = ? AND state = 'creating'",
      [sandbox.sandboxId, sandbox.templateId, trafficTokenCiphertext, tenantId, operation.generation],
    );
    if ((result as { affectedRows: number }).affectedRows !== 1) {
      throw new Error('Tenant computer generation changed during CubeSandbox operation.');
    }
    persisted = true;
    await emitTrace(trace, { component: 'cube', stage: 'sandbox.create.ready', level: 'info', message: 'CubeSandbox 已返回租户 microVM。', durationMs: Date.now() - startedAt, details: { sandboxId: sandbox.sandboxId, templateId: sandbox.templateId, generation: operation.generation } }, tenantId, runId);
    await emitTrace(trace, { component: 'computer', stage: 'record.persisted', level: 'info', message: '租户 microVM ID 与加密数据面令牌已写入 MySQL。', details: { sandboxId: sandbox.sandboxId, templateId: sandbox.templateId, generation: operation.generation, desktopState: 'installing' } }, tenantId, runId);
    scheduleDesktopBootstrap(tenantId, sandbox.sandboxId, operation.generation, trafficTokenCiphertext, trace, runId);
    return getTenantComputer(tenantId);
  } catch (error) {
    if (!persisted) {
      await pool.execute(
        "UPDATE computers SET state = 'failed', desktop_state = 'failed', desktop_updated_at = UTC_TIMESTAMP(3) WHERE tenant_id = ? AND generation = ? AND state = 'creating'",
        [tenantId, operation.generation],
      );
      let safeToRetryCreate = !creationSubmitted;
      if (!operation.sandboxId && sandbox) {
        await emitTrace(trace, { component: 'cube', stage: 'sandbox.create.cleanup.start', level: 'warning', message: '云电脑尚未保存到 MySQL，正在清理本次创建的 microVM。', details: { sandboxId: sandbox.sandboxId, generation: operation.generation } }, tenantId, runId);
        try {
          await sandbox.kill();
          safeToRetryCreate = true;
          await emitTrace(trace, { component: 'cube', stage: 'sandbox.create.cleanup.complete', level: 'info', message: '未关联的 microVM 已清理。', details: { sandboxId: sandbox.sandboxId, generation: operation.generation } }, tenantId, runId);
        } catch (cleanupError) {
          await emitTrace(trace, { component: 'cube', stage: 'sandbox.create.cleanup.failed', level: 'error', message: '清理未关联 microVM 失败。', details: { sandboxId: sandbox.sandboxId, generation: operation.generation, ...errorDetails(cleanupError) } }, tenantId, runId);
        }
      }
      // This CubeMaster rejection happens before a sandbox is allocated.
      // Other errors (including connection loss) can have an unknown outcome.
      if (creationSubmitted && !sandbox && error instanceof Error && /error code 130597: no more resource/i.test(error.message)) safeToRetryCreate = true;
      if (!operation.sandboxId && safeToRetryCreate) {
        await pool.execute('UPDATE computers SET create_pending = FALSE WHERE tenant_id = ? AND generation = ? AND sandbox_id IS NULL', [tenantId, operation.generation]);
      }
    }
    const reason = error instanceof Error ? error.message.slice(0, 240) : 'unknown error';
    const safeReason = config.cube.apiKey ? reason.replaceAll(config.cube.apiKey, '[redacted]') : reason;
    await emitTrace(trace, { component: 'cube', stage: 'sandbox.create.error', level: 'error', message: '租户 microVM 启动或恢复失败。', durationMs: Date.now() - startedAt, details: { operationGeneration: operation.generation, sandboxId: sandbox?.sandboxId || operation.sandboxId || '', safeError: safeReason, ...errorDetails(error) } }, tenantId, runId);
    if (error instanceof ComputerRecoveryRequiredError) throw error;
    if (error instanceof ComputerNotConfiguredError) throw error;
    throw new ComputerOperationError('CubeSandbox 暂时无法启动云电脑，请稍后重试。');
  } finally {
    sandbox?.close();
  }
}

async function assertExistingSandbox(tenantId: string, cube: Config): Promise<void> {
  const [rows] = await pool.execute<ComputerRow[]>(
    'SELECT sandbox_id, state, desktop_state, generation FROM computers WHERE tenant_id = ? LIMIT 1',
    [tenantId],
  );
  const current = rows[0];
  if (current?.state !== 'running' || !current.sandbox_id) return;

  const probe = new Sandbox({ sandboxID: current.sandbox_id }, cube);
  let missing = false;
  try {
    await probe.getInfo();
  } catch (error) {
    if (!isSandboxNotFoundError(error)) throw error;
    missing = true;
  } finally {
    probe.close();
  }
  if (!missing) return;

  const [updated] = await pool.execute(
    "UPDATE computers SET state = 'failed', desktop_state = 'failed', desktop_updated_at = UTC_TIMESTAMP(3) WHERE tenant_id = ? AND sandbox_id = ? AND generation = ? AND state = 'running'",
    [tenantId, current.sandbox_id, current.generation],
  );
  if ((updated as { affectedRows: number }).affectedRows === 1) throw new ComputerRecoveryRequiredError(missingSandboxMessage);
}

async function probeTenantDesktop(tenantId: string, sandboxId: string, generation: number, trace?: TraceSink, runId?: string): Promise<boolean> {
  const startedAt = Date.now();
  let sandbox: Sandbox | undefined;
  await emitTrace(trace, { component: 'desktop', stage: 'health.probe.start', level: 'info', message: '通过访客机文件接口检查 X11 socket、桌面会话进程及 VNC/noVNC 监听端口。', details: { sandboxId, generation, timeoutMs: 15_000 } }, tenantId, runId);
  try {
    sandbox = await connectTenantSandbox(tenantId);
    if (sandbox.sandboxId !== sandboxId) {
      await emitTrace(trace, { component: 'desktop', stage: 'health.probe.superseded', level: 'warning', message: '健康探测前租户 microVM 已发生切换，跳过旧实例探测。', details: { expectedSandboxId: sandboxId, connectedSandboxId: sandbox.sandboxId, generation } }, tenantId, runId);
      return false;
    }
    const result = await probeDesktopReadiness(sandbox);
    const healthy = result.ready;
    await emitTrace(trace, { component: 'desktop', stage: healthy ? 'health.probe.complete' : 'health.probe.unhealthy', level: healthy ? 'info' : 'error', message: healthy ? '访客机桌面会话、X11 socket、VNC 监听端口和 noVNC WebSocket 监听端口均可用。' : '访客机实时桌面健康探测失败。', durationMs: Date.now() - startedAt, details: { sandboxId, generation, ...result } }, tenantId, runId);
    return healthy;
  } catch (error) {
    await emitTrace(trace, { component: 'desktop', stage: 'health.probe.failed', level: 'error', message: '通过 CubeSandbox 数据面执行访客机实时桌面探测失败。', durationMs: Date.now() - startedAt, details: { sandboxId, generation, ...errorDetails(error) } }, tenantId, runId);
    return false;
  } finally {
    sandbox?.close();
  }
}

async function runDesktopBootstrap(tenantId: string, sandboxId: string, generation: number, trafficTokenCiphertext: string, trace?: TraceSink, runId?: string): Promise<void> {
  let sandbox: Sandbox | undefined;
  let leaseConnection: PoolConnection | undefined;
  let leaseAcquired = false;
  const leaseName = `csa-desktop:${tenantId}`;
  const startedAt = Date.now();
  try {
    await emitTrace(trace, { component: 'desktop', stage: 'bootstrap.start', level: 'info', message: '开始准备 XFCE、Chromium、Node.js、Python 与 noVNC。', details: { sandboxId, generation, timeoutMs: desktopBootstrapTimeoutMs } }, tenantId, runId);
    leaseConnection = await pool.getConnection();
    const [leaseRows] = await leaseConnection.execute<RowDataPacket[]>('SELECT GET_LOCK(?, 0) AS acquired', [leaseName]);
    if (Number(leaseRows[0]?.acquired) !== 1) {
      await emitTrace(trace, { component: 'desktop', stage: 'bootstrap.lease.busy', level: 'info', message: '同一租户与 generation 的桌面引导已由另一个应用进程持有。', details: { sandboxId, generation } }, tenantId, runId);
      return;
    }
    leaseAcquired = true;
    await emitTrace(trace, { component: 'desktop', stage: 'bootstrap.lease.acquired', level: 'info', message: '已取得 MySQL 单租户桌面引导租约。', details: { sandboxId, generation } }, tenantId, runId);
    const deadline = Date.now() + desktopBootstrapTimeoutMs;
    const connected = await connectSandboxForDesktopBootstrap(sandboxId, cubeConfig(), deadline, trace, tenantId, runId);
    sandbox = connected.trafficAccessToken
      ? connected
      : withTrafficToken(connected, decryptSandboxTrafficToken(trafficTokenCiphertext));
    await emitTrace(trace, { component: 'cube', stage: 'sandbox.traffic-token.ready', level: 'info', message: '数据面连接令牌可用，开始传入桌面初始化脚本。', details: { sandboxId, generation, tokenSource: connected.trafficAccessToken ? 'cube-connect' : 'encrypted-mysql-record' } }, tenantId, runId);
    const existingReadyMarker = await readDesktopGuestFile(sandbox, '/var/lib/csa-desktop/ready');
    if (existingReadyMarker.trim()) {
      const existingReadiness = await probeDesktopReadiness(sandbox);
      await emitTrace(trace, { component: 'desktop', stage: 'bootstrap.guest-session.probe', level: existingReadiness.ready ? 'info' : 'warning', message: existingReadiness.ready ? '现有 XFCE/VNC/noVNC 会话仍健康，跳过重新启动 guest bootstrap。' : 'guest ready 标记存在，但现有会话未通过实时探测，将重新运行桌面引导。', details: { sandboxId, generation, reusedExistingSession: existingReadiness.ready, ...existingReadiness } }, tenantId, runId);
      if (existingReadiness.ready) {
        await assertDesktopBootstrapLease(leaseConnection, leaseName);
        const [updated] = await pool.execute(
          "UPDATE computers SET desktop_state = 'ready', desktop_updated_at = UTC_TIMESTAMP(3) WHERE tenant_id = ? AND sandbox_id = ? AND generation = ? AND desktop_state = 'installing'",
          [tenantId, sandboxId, generation],
        );
        if ((updated as { affectedRows: number }).affectedRows !== 1) throw new Error('Tenant desktop generation changed while reusing the existing guest session.');
        await emitTrace(trace, { component: 'desktop', stage: 'bootstrap.ready', level: 'info', message: '现有 Linux 桌面会话已重新关联到当前租户 generation。', durationMs: Date.now() - startedAt, details: { sandboxId, generation, reusedExistingSession: true, browserStatus: existingReadiness.browserStatus } }, tenantId, runId);
        return;
      }
    }
    const bootstrap = await readFile(resolve(process.cwd(), 'scripts/cube/bootstrap-linux-desktop.sh'), 'utf8');
    const launcher = await readFile(resolve(process.cwd(), 'scripts/cube/launch-linux-desktop-bootstrap.sh'), 'utf8');
    const session = await readFile(resolve(process.cwd(), 'scripts/cube/csa-desktop-session.sh'), 'utf8');
    const scripts = [
      ['/tmp/csa-desktop-bootstrap.sh', bootstrap],
      ['/tmp/csa-launch-desktop-bootstrap.sh', launcher],
      ['/tmp/csa-desktop-session.sh', session],
    ] as const;
    for (const [path, contents] of scripts) {
      const stageStartedAt = Date.now();
      await emitTrace(trace, { component: 'desktop', stage: 'bootstrap.script.stage.start', level: 'info', message: '开始传入 Linux 桌面脚本。', details: { sandboxId, generation, path, bytes: Buffer.byteLength(contents) } }, tenantId, runId);
      await retryCubeOperation(() => sandbox!.files.write(path, contents), deadline, `desktop.script.write:${path}`, trace, tenantId, runId);
      await emitTrace(trace, { component: 'desktop', stage: 'bootstrap.script.stage.complete', level: 'info', message: 'Linux 桌面脚本已传入 microVM。', durationMs: Date.now() - stageStartedAt, details: { sandboxId, generation, path, bytes: Buffer.byteLength(contents) } }, tenantId, runId);
    }
    await emitTrace(trace, { component: 'desktop', stage: 'bootstrap.files-staged', level: 'info', message: '全部桌面初始化脚本已传入 microVM。', details: { sandboxId, generation, scriptCount: scripts.length } }, tenantId, runId);

    const desktopEnvs = {
      COKE_DESKTOP_RESOLUTION: config.agent.desktopResolution,
      CSA_TENANT_ID: tenantId,
      CSA_CUBE_SANDBOX_ID: sandboxId,
      CSA_COMPUTER_GENERATION: String(generation),
      ...(runId ? { CSA_RUN_ID: runId } : {}),
      ...(config.agent.desktopAptMirror ? { CSA_APT_MIRROR: config.agent.desktopAptMirror } : {}),
    };
    const launchStartedAt = Date.now();
    await emitTrace(trace, { component: 'desktop', stage: 'bootstrap.launch.pty.start', level: 'info', message: '通过持久化 Cube PTY 启动桌面引导器。', details: { sandboxId, generation, timeoutMs: 60_000, envNames: Object.keys(desktopEnvs).sort().join(',') } }, tenantId, runId);
    let launch: { exitCode: number; output: string; ptyId: number };
    try {
      launch = await retryCubeOperation(
        () => launchDesktopBootstrapPty(sandbox!, desktopEnvs, 60_000, line => {
          void emitTrace(trace, {
            component: 'desktop',
            stage: 'bootstrap.launch.pty.output',
            level: /\b(error|failed|fatal)\b/i.test(line) ? 'warning' : 'info',
            message: '访客机桌面引导器输出。',
            details: { sandboxId, generation, ptyOutputTail: line },
          }, tenantId, runId);
        }),
        deadline,
        'desktop.bootstrap.launch.pty', trace, tenantId, runId,
      );
    } catch (error) {
      await emitTrace(trace, { component: 'desktop', stage: 'bootstrap.launch.pty.failed', level: 'error', message: '桌面引导 PTY 启动器没有及时返回。', durationMs: Date.now() - launchStartedAt, details: { sandboxId, generation, ...errorDetails(error) } }, tenantId, runId);
      throw error;
    }
    await emitTrace(trace, { component: 'desktop', stage: 'bootstrap.launch.pty.complete', level: launch.exitCode === 0 ? 'info' : 'error', message: '桌面初始化后台启动命令已从 PTY 返回。', durationMs: Date.now() - launchStartedAt, details: { sandboxId, generation, ptyId: launch.ptyId, exitCode: launch.exitCode, outputTail: launch.output.trim().slice(-1200) } }, tenantId, runId);
    if (launch.exitCode !== 0) {
      throw new Error(`Linux desktop bootstrap launcher exited ${launch.exitCode}${launch.output.trim() ? ': ' + launch.output.trim().slice(-500) : ''}`);
    }

    let lastHeartbeatAt = Date.now();
    let lastStatus = '';
    while (Date.now() < deadline) {
      const [readyMarker, exitCodeMarker] = await Promise.all([
        readDesktopGuestFile(sandbox, '/var/lib/csa-desktop/ready'),
        readDesktopGuestFile(sandbox, '/var/lib/csa-desktop/bootstrap.exitcode'),
      ]);
      const markerReady = readyMarker.trim().length > 0;
      const markerExitCode = exitCodeMarker.trim().match(/^\d{1,3}$/)?.[0] ?? 'none';
      let currentStatus = 'INSTALLING';
      if (markerReady) {
        const readiness = await probeDesktopReadiness(sandbox);
        currentStatus = readiness.ready ? 'READY' : 'READY_MARKER_STALE';
        if (currentStatus !== lastStatus || Date.now() - lastHeartbeatAt >= 30_000) {
          await emitTrace(trace, { component: 'desktop', stage: 'bootstrap.readiness.probe', level: readiness.ready ? 'info' : 'warning', message: readiness.ready ? '访客机的桌面会话、X11 socket、VNC 监听端口和 noVNC WebSocket 监听端口已通过探测。' : '访客机的桌面就绪标记与实时探测不一致。', details: { sandboxId, generation, ...readiness } }, tenantId, runId);
        }
      }
      if (markerExitCode !== 'none' && currentStatus !== 'READY') currentStatus = `EXIT:${markerExitCode}`;
      if (currentStatus !== lastStatus) {
        lastStatus = currentStatus;
        await emitTrace(trace, { component: 'desktop', stage: 'bootstrap.status', level: currentStatus.startsWith('EXIT:') ? 'error' : 'info', message: '桌面初始化状态有变化。', details: { sandboxId, generation, status: currentStatus } }, tenantId, runId);
      }
      if (currentStatus === 'READY') break;
      if (currentStatus.startsWith('EXIT:')) {
        const exitCode = currentStatus.slice('EXIT:'.length);
        const [bootstrapLog, aptLog, sessionLog] = await Promise.all([
          readGuestTail(sandbox!, '/var/lib/csa-desktop/bootstrap.log', 3_600),
          readGuestTail(sandbox!, '/var/lib/csa-desktop/apt.log', 3_600),
          readGuestTail(sandbox!, '/tmp/csa-desktop-session.log', 2_400),
        ]);
        const detail = [`--- bootstrap ---\n${bootstrapLog}`, `--- apt ---\n${aptLog}`, `--- desktop session ---\n${sessionLog}`].filter(section => section.trim()).join('\n').slice(-6_800);
        await emitTrace(trace, { component: 'desktop', stage: 'bootstrap.guest-logs', level: 'error', message: '桌面安装器失败，已从 microVM 收集 bootstrap、apt 与桌面会话日志。', details: { sandboxId, generation, exitCode, guestLogTail: detail } }, tenantId, runId);
        throw new Error(`Linux desktop bootstrap exited ${exitCode}${detail ? ': ' + detail : ''}`);
      }
      if (Date.now() - lastHeartbeatAt >= 30_000) {
        await assertDesktopBootstrapLease(leaseConnection, leaseName);
        const guestStatus = await readGuestTail(sandbox!, '/var/lib/csa-desktop/bootstrap.status', 2_400);
        await emitTrace(trace, { component: 'desktop', stage: 'bootstrap.wait', level: 'info', message: '桌面初始化仍在运行；已从访客机状态文件读取最近阶段与 apt 心跳。', durationMs: Date.now() - startedAt, details: { sandboxId, generation, elapsedSeconds: Math.floor((Date.now() - startedAt) / 1000), guestStatus } }, tenantId, runId);
        lastHeartbeatAt = Date.now();
      }
      await new Promise(resolve => setTimeout(resolve, 5_000));
    }
    if (Date.now() >= deadline) throw new Error('Linux desktop bootstrap exceeded the 30 minute wait limit.');
    await assertDesktopBootstrapLease(leaseConnection, leaseName);
    const [updated] = await pool.execute(
      "UPDATE computers SET desktop_state = 'ready', desktop_updated_at = UTC_TIMESTAMP(3) WHERE tenant_id = ? AND sandbox_id = ? AND generation = ? AND desktop_state = 'installing'",
      [tenantId, sandboxId, generation],
    );
    if ((updated as { affectedRows: number }).affectedRows !== 1) throw new Error('Linux desktop generation changed during bootstrap.');
    await emitTrace(trace, { component: 'desktop', stage: 'bootstrap.ready', level: 'info', message: 'XFCE 桌面及 noVNC 服务已启动。', durationMs: Date.now() - startedAt, details: { sandboxId, generation } }, tenantId, runId);
  } catch (error) {
    if (!(error instanceof DesktopBootstrapLeaseLostError)) {
      await pool.execute(
        "UPDATE computers SET desktop_state = 'failed', desktop_updated_at = UTC_TIMESTAMP(3) WHERE tenant_id = ? AND sandbox_id = ? AND generation = ? AND desktop_state = 'installing'",
        [tenantId, sandboxId, generation],
      ).catch(() => undefined);
    }
    const reason = error instanceof Error ? error.message.slice(0, 500) : 'unknown error';
    const safeReason = config.cube.apiKey ? reason.replaceAll(config.cube.apiKey, '[redacted]') : reason;
    await emitTrace(trace, { component: 'desktop', stage: error instanceof DesktopBootstrapLeaseLostError ? 'bootstrap.lease.lost' : 'bootstrap.error', level: error instanceof DesktopBootstrapLeaseLostError ? 'warning' : 'error', message: error instanceof DesktopBootstrapLeaseLostError ? 'MySQL 桌面引导租约已失效；当前 worker 停止更新租户状态。' : 'Linux 桌面初始化失败。', durationMs: Date.now() - startedAt, details: { safeError: safeReason, sandboxId, generation, ...errorDetails(error) } }, tenantId, runId);
  } finally {
    await emitTrace(trace, { component: 'desktop', stage: 'bootstrap.connection.close', level: 'info', message: '关闭桌面初始化阶段的数据面连接。', details: { sandboxId, generation } }, tenantId, runId);
    sandbox?.close();
    if (leaseConnection) {
      const connection = leaseConnection;
      leaseConnection = undefined;
      if (!leaseAcquired) {
        connection.release();
      } else {
        try {
          const [releaseRows] = await connection.execute<RowDataPacket[]>('SELECT RELEASE_LOCK(?) AS released', [leaseName]);
          if (Number(releaseRows[0]?.released) === 1) {
            connection.release();
            await emitTrace(trace, { component: 'desktop', stage: 'bootstrap.lease.released', level: 'info', message: '已释放 MySQL 桌面引导租约。', details: { sandboxId, generation } }, tenantId, runId);
          } else {
            connection.destroy();
            await emitTrace(trace, { component: 'desktop', stage: 'bootstrap.lease.release.unconfirmed', level: 'warning', message: 'MySQL 未确认桌面引导租约已释放；已丢弃该连接。', details: { sandboxId, generation } }, tenantId, runId);
          }
        } catch (error) {
          connection.destroy();
          await emitTrace(trace, { component: 'desktop', stage: 'bootstrap.lease.release.failed', level: 'warning', message: '释放 MySQL 桌面引导租约时连接失败，已丢弃该连接。', details: { sandboxId, generation, ...errorDetails(error) } }, tenantId, runId);
        }
      }
    }
    desktopBootstrapByTenant.delete(tenantId);
  }
}

async function assertDesktopBootstrapLease(connection: PoolConnection | undefined, leaseName: string): Promise<void> {
  if (!connection) throw new DesktopBootstrapLeaseLostError('The desktop bootstrap does not hold its MySQL lease connection.');
  try {
    const [rows] = await connection.execute<RowDataPacket[]>('SELECT IS_USED_LOCK(?) = CONNECTION_ID() AS owned', [leaseName]);
    if (Number(rows[0]?.owned) !== 1) throw new DesktopBootstrapLeaseLostError('The MySQL desktop bootstrap lease is no longer owned by this worker.');
  } catch (error) {
    if (error instanceof DesktopBootstrapLeaseLostError) throw error;
    throw new DesktopBootstrapLeaseLostError('The MySQL desktop bootstrap lease could not be confirmed.');
  }
}

function scheduleDesktopBootstrap(tenantId: string, sandboxId: string, generation: number, trafficTokenCiphertext: string, trace?: TraceSink, runId?: string): void {
  if (desktopBootstrapByTenant.has(tenantId)) return;
  const operation = runDesktopBootstrap(tenantId, sandboxId, generation, trafficTokenCiphertext, trace, runId);
  desktopBootstrapByTenant.set(tenantId, operation);
}

async function connectSandboxForDesktopBootstrap(sandboxId: string, cube: Config, deadline: number, trace?: TraceSink, tenantId?: string, runId?: string): Promise<Sandbox> {
  const probe = new Sandbox({ sandboxID: sandboxId }, cube);
  let terminatedSince: number | undefined;
  let lastObservedState = '';
  try {
    while (Date.now() < deadline) {
      const info = await retryCubeOperation(() => probe.getInfo(), deadline, 'sandbox.getInfo', trace, tenantId, runId);
      const restartState = String(info.restartStatus?.restartState || '').toLowerCase();
      const observedState = `${info.state}:${restartState}`;
      if (observedState !== lastObservedState) {
        lastObservedState = observedState;
        await emitTrace(trace, { component: 'cube', stage: 'sandbox.lifecycle', level: restartState === 'backoff' ? 'warning' : 'info', message: '读取 CubeSandbox microVM 生命周期状态。', details: { sandboxId, state: info.state, restartState: restartState || 'none', restartCount: info.restartStatus?.restartCount ?? 0 } }, tenantId, runId);
      }
      if (['gaveup', 'failed', 'succeeded'].includes(restartState)) {
        throw new Error(`CubeSandbox sandbox restart state is ${info.restartStatus.restartState}.`);
      }
      if (info.state === 'terminated') {
        terminatedSince ??= Date.now();
        if (!['backoff', 'restarting'].includes(restartState) && Date.now() - terminatedSince >= 60_000) {
          throw new Error('CubeSandbox sandbox remained terminated without an active restart.');
        }
      } else {
        terminatedSince = undefined;
      }
      if (info.state === 'running' || info.state === 'paused') {
        try {
          const connected = await retryCubeOperation(() => Sandbox.connect(sandboxId, { config: cube }), deadline, 'sandbox.connect', trace, tenantId, runId);
          await emitTrace(trace, { component: 'cube', stage: 'sandbox.connected', level: 'info', message: '已连接到租户 microVM 数据面。', details: { sandboxId } }, tenantId, runId);
          return connected;
        } catch (error) {
          // The sandbox can exit between getInfo() reporting `running` and
          // CubeAPI handling the connect request. Let the next lifecycle probe
          // decide whether it is restarting or terminal instead of failing the
          // tenant bootstrap on that race.
          const message = error instanceof Error ? error.message : String(error);
          if (/\bterminated\b/i.test(message)) {
            await wait(1_000);
            continue;
          }
          if (!isRetryableCubeOperationError(error)) throw error;
        }
      }
      await wait(2_000);
    }
    throw new Error('CubeSandbox sandbox did not become connectable within 30 minutes.');
  } finally {
    probe.close();
  }
}

async function retryCubeOperation<T>(
  operation: () => Promise<T>,
  deadline: number,
  label = 'cube.operation',
  trace?: TraceSink,
  tenantId?: string,
  runId?: string,
): Promise<T> {
  let attempt = 0;
  let lastNoticeAt = 0;
  let lastError: unknown;
  const startedAt = Date.now();
  while (Date.now() < deadline) {
    try {
      return await operation();
    } catch (error) {
      if (!isRetryableCubeOperationError(error)) throw error;
      lastError = error;
      if (attempt === 0 || Date.now() - lastNoticeAt >= 30_000) {
        await emitTrace(trace, { component: 'cube', stage: 'operation.retry', level: 'warning', message: 'CubeSandbox 数据面操作暂时不可用，按退避间隔重试。', durationMs: Date.now() - startedAt, details: { operation: label, attempt: attempt + 1, nextDelayMs: Math.min(5_000, 1_000 * (2 ** Math.min(attempt, 2))), ...errorDetails(error) } }, tenantId, runId);
        lastNoticeAt = Date.now();
      }
      await wait(Math.min(5_000, 1_000 * (2 ** Math.min(attempt, 2))));
      attempt += 1;
    }
  }
  const timeoutError = new Error(`CubeSandbox operation ${label} remained unavailable until the desktop bootstrap deadline.`);
  if (lastError !== undefined) Object.defineProperty(timeoutError, 'cause', { value: lastError });
  await emitTrace(trace, { component: 'cube', stage: 'operation.timeout', level: 'error', message: timeoutError.message, durationMs: Date.now() - startedAt, details: { operation: label, attempts: attempt, ...(lastError === undefined ? {} : errorDetails(lastError)) } }, tenantId, runId);
  throw timeoutError;
}

function isRetryableCubeOperationError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /HTTP 50[234]|ECONNRESET|ECONNREFUSED|ETIMEDOUT|EHOSTUNREACH|fetch failed|network error|not connectable in state 'stopped'/i.test(message);
}

function isSandboxNotFoundError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return error instanceof SandboxNotFoundError || /sandbox\s+[a-z0-9-]+\s+not found/i.test(message);
}

function wait(durationMs: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, durationMs));
}

function withTrafficToken(sandbox: Sandbox, trafficToken: string): Sandbox {
  const authenticated = new Sandbox({
    sandboxID: sandbox.sandboxId,
    templateID: sandbox.templateId,
    domain: sandbox.domain,
    trafficAccessToken: trafficToken,
    envdAccessToken: sandbox.envdAccessToken,
  }, sandbox.config);
  sandbox.close();
  return authenticated;
}

async function probeDesktopReadiness(sandbox: Sandbox) {
  const [tcp, tcp6, sessionPidText, sessionReady, browserText, x11SocketExists] = await Promise.all([
    readDesktopGuestFile(sandbox, '/proc/net/tcp'),
    readDesktopGuestFile(sandbox, '/proc/net/tcp6'),
    readDesktopGuestFile(sandbox, '/run/csa-desktop/session.pid'),
    readDesktopGuestFile(sandbox, '/run/csa-desktop/session.ready'),
    readDesktopGuestFile(sandbox, '/run/csa-desktop/browser.status'),
    sandbox.files.exists('/tmp/.X11-unix/X1').catch(() => false),
  ]);
  const listeners = parseDesktopTcpListeners([tcp, tcp6]);
  const sessionPid = Number(sessionPidText.trim());
  const sessionPidValid = Number.isSafeInteger(sessionPid) && sessionPid > 1;
  const sessionCmdline = sessionPidValid
    ? await readDesktopGuestFile(sandbox, `/proc/${sessionPid}/cmdline`)
    : '';
  const session = sessionPidValid
    && sessionReady.split(/\r?\n/).some(line => line === `pid=${sessionPid}`)
    && sessionCmdline.includes('csa-desktop-session');
  const browserCandidate = browserText.trim().slice(0, 16);
  const browser = browserCandidate === 'starting' || browserCandidate === 'ready' || browserCandidate === 'failed'
    ? browserCandidate
    : 'unknown';
  const websockify = listeners.has(6080);
  const vnc = listeners.has(5900);
  return {
    ready: websockify && vnc && x11SocketExists && session,
    websockifyReady: websockify,
    vncReady: vnc,
    x11Ready: x11SocketExists,
    sessionReady: session,
    browserStatus: browser,
  };
}

function parseDesktopTcpListeners(tables: string[]): Set<number> {
  const ports = new Set<number>();
  for (const table of tables) {
    for (const line of table.split(/\r?\n/)) {
      const columns = line.trim().split(/\s+/);
      if (columns[3] !== '0A') continue;
      const portHex = columns[1]?.split(':').at(-1);
      const port = portHex ? Number.parseInt(portHex, 16) : Number.NaN;
      if (Number.isInteger(port)) ports.add(port);
    }
  }
  return ports;
}

async function readDesktopGuestFile(sandbox: Sandbox, path: string): Promise<string> {
  try {
    return await sandbox.files.read(path);
  } catch {
    return '';
  }
}

async function readGuestTail(sandbox: Sandbox, path: string, limit = 2_400): Promise<string> {
  try {
    const contents = Buffer.from(await sandbox.files.read(path, { format: 'bytes' }));
    return contents.subarray(Math.max(0, contents.length - limit)).toString('utf8');
  } catch {
    return '';
  }
}

async function launchDesktopBootstrapPty(
  sandbox: Sandbox,
  envs: Record<string, string>,
  timeoutMs: number,
  onOutputLine?: (line: string) => void,
): Promise<{ exitCode: number; output: string; ptyId: number }> {
  const startedAt = Date.now();
  let stage = 'pty.create';
  let handle: Awaited<ReturnType<Sandbox['pty']['create']>> | undefined;
  const decoder = new TextDecoder();
  let output = '';
  let pendingLine = '';
  let timeout: ReturnType<typeof setTimeout> | undefined;
  let rejectDeadline: ((error: Error) => void) | undefined;
  const deadlineError = new Promise<never>((_, reject) => { rejectDeadline = reject; });
  const deadline = Date.now() + timeoutMs;
  const raceDeadline = async <T>(operation: Promise<T>, operationStage: string): Promise<T> => {
    stage = operationStage;
    return Promise.race([operation, deadlineError]);
  };
  const collect = (chunk: Uint8Array): void => {
    const text = decoder.decode(chunk, { stream: true });
    output = (output + text).slice(-12_000);
    pendingLine = (pendingLine + text).slice(-4_000);
    let newline: number;
    while ((newline = pendingLine.indexOf('\n')) >= 0) {
      const line = pendingLine.slice(0, newline).replace(/\r$/, '');
      pendingLine = pendingLine.slice(newline + 1);
      if (line.trim()) onOutputLine?.(line.slice(-2_000));
    }
  };
  try {
    timeout = setTimeout(() => rejectDeadline?.(new Error(`CubeSandbox PTY desktop bootstrap launcher exceeded ${timeoutMs}ms.`)), timeoutMs);
    handle = await raceDeadline(
      sandbox.pty.create({ rows: 24, cols: 100 }, { cwd: '/', envs, timeoutMs: 0 }),
      'pty.create',
    );
    const ptyId = handle.pid;
    stage = 'pty.stream.start';
    const completion = handle.wait(collect);
    stage = 'pty.send.echo-disable';
    await raceDeadline(
      handle.sendStdin('stty -echo 2>/dev/null || true\n', Math.max(1, Math.min(15_000, deadline - Date.now()))),
      stage,
    );
    stage = 'pty.send.bootstrap-command';
    await raceDeadline(
      handle.sendStdin("exec bash -c 'exec bash /tmp/csa-launch-desktop-bootstrap.sh'\n", Math.max(1, Math.min(15_000, deadline - Date.now()))),
      stage,
    );
    stage = 'pty.wait';
    const exitCode = await Promise.race([
      completion,
      deadlineError,
    ]);
    output += decoder.decode();
    if (pendingLine.trim()) onOutputLine?.(pendingLine.slice(-2_000));
    return { exitCode, output, ptyId };
  } catch (error) {
    if (handle) await handle.kill().catch(() => undefined);
    output += decoder.decode();
    const original = error instanceof Error ? error : new Error(String(error));
    const wrapped = new Error(original.message, { cause: original });
    Object.assign(wrapped, {
      diagnostics: {
        ptyId: handle?.pid ?? 'unavailable',
        ptyStage: stage,
        ptyElapsedMs: Date.now() - startedAt,
        ptyOutputTail: output.trim().slice(-2_400),
      },
    });
    throw wrapped;
  } finally {
    if (timeout) clearTimeout(timeout);
    handle?.disconnect();
  }
}

async function getTenantSandboxCredential(tenantId: string, requireDesktop: boolean): Promise<{ sandboxId: string; trafficToken: string }> {
  const [rows] = await pool.execute<ComputerRow[]>(
    'SELECT sandbox_id, cube_traffic_token_ciphertext, state, desktop_state, generation, updated_at FROM computers WHERE tenant_id = ? LIMIT 1',
    [tenantId],
  );
  const computer = rows[0];
  const vmReady = Boolean(computer?.sandbox_id && computer.state === 'running');
  if (requireDesktop && (!vmReady || computer?.desktop_state !== 'ready')) {
    throw new DesktopNotReadyError('该租户的 Linux 桌面尚未准备就绪。');
  }
  if (!computer?.sandbox_id || computer.state !== 'running') {
    throw new ComputerNotReadyError('该租户的 Linux microVM 尚未运行。');
  }
  if (!computer.cube_traffic_token_ciphertext) throw new Error('该租户 VM 缺少加密的数据面令牌。');
  return { sandboxId: computer.sandbox_id, trafficToken: decryptSandboxTrafficToken(computer.cube_traffic_token_ciphertext) };
}

export function getTenantDesktopCredential(tenantId: string): Promise<{ sandboxId: string; trafficToken: string }> {
  return getTenantSandboxCredential(tenantId, true);
}

async function connectSandboxWithCredential(credential: { sandboxId: string; trafficToken: string }): Promise<Sandbox> {
  const sandbox = await Sandbox.connect(credential.sandboxId, { config: cubeConfig() });
  return sandbox.trafficAccessToken ? sandbox : withTrafficToken(sandbox, credential.trafficToken);
}

export async function connectTenantSandbox(tenantId: string): Promise<Sandbox> {
  return connectSandboxWithCredential(await getTenantSandboxCredential(tenantId, false));
}

export async function getTenantBrowserState(tenantId: string): Promise<BrowserState> {
  let credential: { sandboxId: string; trafficToken: string };
  try {
    credential = await getTenantDesktopCredential(tenantId);
  } catch (error) {
    if (error instanceof ComputerNotReadyError) return 'unavailable';
    throw error;
  }
  const sandbox = await connectSandboxWithCredential(credential);
  try {
    return await readTenantBrowserState(sandbox);
  } finally {
    sandbox.close();
  }
}

export async function retryTenantBrowser(tenantId: string): Promise<boolean> {
  const credential = await getTenantDesktopCredential(tenantId);
  const sandbox = await connectSandboxWithCredential(credential);
  try {
    if (await readTenantBrowserState(sandbox) !== 'failed') return false;
    await sandbox.files.write('/run/csa-desktop/browser.retry', 'retry\n');
    return true;
  } finally {
    sandbox.close();
  }
}

async function readTenantBrowserState(sandbox: Sandbox): Promise<BrowserState> {
  const [pidText, sessionReady, statusText] = await Promise.all([
    readDesktopGuestFile(sandbox, '/run/csa-desktop/session.pid'),
    readDesktopGuestFile(sandbox, '/run/csa-desktop/session.ready'),
    readDesktopGuestFile(sandbox, '/run/csa-desktop/browser.status'),
  ]);
  const pid = Number(pidText.trim());
  if (!Number.isSafeInteger(pid) || pid <= 1) return 'unknown';
  const [cmdline, processStatus] = await Promise.all([
    readDesktopGuestFile(sandbox, `/proc/${pid}/cmdline`),
    readDesktopGuestFile(sandbox, `/proc/${pid}/status`),
  ]);
  if (!sessionReady.split(/\r?\n/).some(line => line === `pid=${pid}`)
    || !cmdline.includes('csa-desktop-session')
    || /^State:\s+Z/m.test(processStatus)) return 'unknown';
  const status = statusText.trim().slice(0, 16);
  return status === 'starting' || status === 'ready' || status === 'failed' ? status : 'unknown';
}
