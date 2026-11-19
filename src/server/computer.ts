import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { Config, NEVER_TIMEOUT, Sandbox, SandboxNotFoundError } from '@cubesandbox/sdk';
import type { PoolConnection, RowDataPacket } from 'mysql2/promise';
import type { ComputerState, ComputerView } from '../shared/types.ts';
import { pool } from './db.ts';
import { config } from './config.ts';
import { assertTokenEncryptionKey, decryptSandboxTrafficToken, encryptSandboxTrafficToken } from './token-crypto.ts';

interface ComputerRow extends RowDataPacket {
  sandbox_id: string | null;
  cube_traffic_token_ciphertext?: string | null;
  state: ComputerState;
  desktop_state: ComputerView['desktopState'];
  generation: number;
  updated_at: Date | string;
}

interface ComputerOperation {
  generation: number;
  sandboxId: string | null;
  trafficTokenCiphertext: string | null;
}

const desktopBootstrapByTenant = new Map<string, Promise<void>>();

export class ComputerNotConfiguredError extends Error {}
export class ComputerOperationError extends Error {}
export class DesktopNotReadyError extends Error {}

export function cubeConfig(): Config {
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

async function reserveOperation(tenantId: string, connection: PoolConnection): Promise<ComputerOperation | null> {
  await connection.beginTransaction();
  let committed = false;
  try {
    await connection.execute('INSERT IGNORE INTO computers (tenant_id) VALUES (?)', [tenantId]);
    const [rows] = await connection.execute<ComputerRow[]>(
      'SELECT sandbox_id, cube_traffic_token_ciphertext, state, desktop_state, generation, updated_at FROM computers WHERE tenant_id = ? FOR UPDATE',
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
    if (current.state === 'running' && current.sandbox_id && current.desktop_state === 'ready') {
      await connection.commit();
      committed = true;
      return null;
    }
    if (current.state === 'running' && current.sandbox_id && desktopBootstrapByTenant.has(tenantId)) {
      await connection.commit();
      committed = true;
      return null;
    }

    const generation = Number(current.generation) + 1;
    await connection.execute(
      "UPDATE computers SET state = 'creating', generation = ?, template_id = ?, desktop_state = ?, desktop_updated_at = UTC_TIMESTAMP(3) WHERE tenant_id = ?",
      [generation, config.cube.templateId, current.sandbox_id ? 'installing' : 'pending', tenantId],
    );
    await connection.commit();
    committed = true;
    return { generation, sandboxId: current.sandbox_id, trafficTokenCiphertext: current.cube_traffic_token_ciphertext || null };
  } catch (error) {
    if (!committed) await connection.rollback();
    throw error;
  }
}

export async function startTenantComputer(tenantId: string): Promise<ComputerView> {
  const cube = cubeConfig();
  try { assertTokenEncryptionKey(); }
  catch { throw new ComputerNotConfiguredError('请先在仓库外环境文件中设置 CSA_TOKEN_ENCRYPTION_KEY。'); }
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
    if (operation.sandboxId) {
      sandbox = await Sandbox.connect(operation.sandboxId, { config: cube });
      if (!sandbox.trafficAccessToken) {
        if (!operation.trafficTokenCiphertext) throw new Error('该租户 VM 缺少保存的数据面令牌，需要重建空白测试 VM。');
        sandbox = withTrafficToken(sandbox, decryptSandboxTrafficToken(operation.trafficTokenCiphertext));
      }
    } else {
      sandbox = await Sandbox.create({
          config: cube,
          template: config.cube.templateId,
          timeout: NEVER_TIMEOUT,
          allowInternetAccess: true,
          network: { allowPublicTraffic: false },
          // Preserve the same tenant VM disk and recover the VM if its main
          // guest process exits while packages or desktop services are being
          // initialized. Cap retries so a broken image cannot loop forever.
          extra: {
            restartPolicy: 'OnFailure',
            restartBackoff: {
              initialIntervalSecond: 10,
              multiplier: 2,
              maxIntervalSecond: 60,
              maxRestarts: 3,
            },
          },
          metadata: { coke_tenant_id: tenantId, coke_generation: String(operation.generation) },
        });
    }
    const trafficToken = sandbox.trafficAccessToken;
    if (!trafficToken) throw new Error('CubeSandbox did not return a private data-plane token.');
    const trafficTokenCiphertext = operation.trafficTokenCiphertext || encryptSandboxTrafficToken(trafficToken);
    const [result] = await pool.execute(
      "UPDATE computers SET sandbox_id = ?, template_id = ?, cube_traffic_token_ciphertext = ?, state = 'running', desktop_state = 'installing', desktop_updated_at = UTC_TIMESTAMP(3) WHERE tenant_id = ? AND generation = ? AND state = 'creating'",
      [sandbox.sandboxId, sandbox.templateId, trafficTokenCiphertext, tenantId, operation.generation],
    );
    if ((result as { affectedRows: number }).affectedRows !== 1) {
      throw new Error('Tenant computer generation changed during CubeSandbox operation.');
    }
    persisted = true;
    scheduleDesktopBootstrap(tenantId, sandbox.sandboxId, operation.generation, trafficTokenCiphertext);
    return getTenantComputer(tenantId);
  } catch (error) {
    if (!persisted) {
      if (operation.sandboxId && error instanceof SandboxNotFoundError) {
        await pool.execute(
          "UPDATE computers SET sandbox_id = NULL, state = 'failed', desktop_state = 'failed', desktop_updated_at = UTC_TIMESTAMP(3) WHERE tenant_id = ? AND generation = ? AND state = 'creating'",
          [tenantId, operation.generation],
        );
      } else {
        await pool.execute(
          "UPDATE computers SET state = 'failed', desktop_state = 'failed', desktop_updated_at = UTC_TIMESTAMP(3) WHERE tenant_id = ? AND generation = ? AND state = 'creating'",
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

async function runDesktopBootstrap(tenantId: string, sandboxId: string, generation: number, trafficTokenCiphertext: string): Promise<void> {
  let sandbox: Sandbox | undefined;
  try {
    const connected = await Sandbox.connect(sandboxId, { config: cubeConfig() });
    sandbox = connected.trafficAccessToken
      ? connected
      : withTrafficToken(connected, decryptSandboxTrafficToken(trafficTokenCiphertext));
    const bootstrap = await readFile(resolve(process.cwd(), 'scripts/cube/bootstrap-linux-desktop.sh'), 'utf8');
    const launcher = await readFile(resolve(process.cwd(), 'scripts/cube/launch-linux-desktop-bootstrap.sh'), 'utf8');
    const session = await readFile(resolve(process.cwd(), 'scripts/cube/csa-desktop-session.sh'), 'utf8');
    await sandbox.files.write('/tmp/csa-desktop-bootstrap.sh', bootstrap);
    await sandbox.files.write('/tmp/csa-launch-desktop-bootstrap.sh', launcher);
    await sandbox.files.write('/tmp/csa-desktop-session.sh', session);

    const launch = await sandbox.commands.run('bash /tmp/csa-launch-desktop-bootstrap.sh', { timeoutMs: 15_000 });
    if (launch.exitCode !== 0) {
      const detail = (launch.stderr || launch.stdout).trim().slice(-500);
      throw new Error(`Linux desktop bootstrap could not start${detail ? ': ' + detail : ''}`);
    }

    const deadline = Date.now() + 30 * 60_000;
    while (Date.now() < deadline) {
      const status = await sandbox.commands.run(
        'if test -f /var/lib/csa-desktop/ready; then echo READY; elif test -f /var/lib/csa-desktop/bootstrap.exitcode; then printf "EXIT:"; cat /var/lib/csa-desktop/bootstrap.exitcode; else echo INSTALLING; fi',
        { timeoutMs: 15_000 },
      );
      if (status.stdout.trim() === 'READY') break;
      if (status.stdout.trim().startsWith('EXIT:')) {
        const exitCode = status.stdout.trim().slice('EXIT:'.length);
        const logs = await sandbox.commands.run('tail -n 50 /var/lib/csa-desktop/bootstrap.log 2>/dev/null || true', { timeoutMs: 15_000 });
        const detail = (logs.stderr || logs.stdout).trim().slice(-500);
        throw new Error(`Linux desktop bootstrap exited ${exitCode}${detail ? ': ' + detail : ''}`);
      }
      const ensureRunning = await sandbox.commands.run('bash /tmp/csa-launch-desktop-bootstrap.sh', { timeoutMs: 15_000 });
      if (ensureRunning.exitCode !== 0) {
        const detail = (ensureRunning.stderr || ensureRunning.stdout).trim().slice(-500);
        throw new Error(`Linux desktop bootstrap could not be resumed${detail ? ': ' + detail : ''}`);
      }
      await new Promise(resolve => setTimeout(resolve, 10_000));
    }
    if (Date.now() >= deadline) throw new Error('Linux desktop bootstrap exceeded the 30 minute wait limit.');
    const [updated] = await pool.execute(
      "UPDATE computers SET desktop_state = 'ready', desktop_updated_at = UTC_TIMESTAMP(3) WHERE tenant_id = ? AND sandbox_id = ? AND generation = ? AND desktop_state = 'installing'",
      [tenantId, sandboxId, generation],
    );
    if ((updated as { affectedRows: number }).affectedRows !== 1) throw new Error('Linux desktop generation changed during bootstrap.');
  } catch (error) {
    await pool.execute(
      "UPDATE computers SET desktop_state = 'failed', desktop_updated_at = UTC_TIMESTAMP(3) WHERE tenant_id = ? AND sandbox_id = ? AND generation = ? AND desktop_state = 'installing'",
      [tenantId, sandboxId, generation],
    ).catch(() => undefined);
    const reason = error instanceof Error ? error.message.slice(0, 500) : 'unknown error';
    const safeReason = config.cube.apiKey ? reason.replaceAll(config.cube.apiKey, '[redacted]') : reason;
    process.stderr.write('Linux desktop bootstrap failed: ' + safeReason + '\n');
  } finally {
    sandbox?.close();
    desktopBootstrapByTenant.delete(tenantId);
  }
}

function scheduleDesktopBootstrap(tenantId: string, sandboxId: string, generation: number, trafficTokenCiphertext: string): void {
  if (desktopBootstrapByTenant.has(tenantId)) return;
  const operation = runDesktopBootstrap(tenantId, sandboxId, generation, trafficTokenCiphertext);
  desktopBootstrapByTenant.set(tenantId, operation);
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

export async function getTenantDesktopCredential(tenantId: string): Promise<{ sandboxId: string; trafficToken: string }> {
  const [rows] = await pool.execute<ComputerRow[]>(
    'SELECT sandbox_id, cube_traffic_token_ciphertext, state, desktop_state, generation, updated_at FROM computers WHERE tenant_id = ? LIMIT 1',
    [tenantId],
  );
  const computer = rows[0];
  if (!computer?.sandbox_id || computer.state !== 'running' || computer.desktop_state !== 'ready') {
    throw new DesktopNotReadyError('该租户的 Linux 桌面尚未准备就绪。');
  }
  if (!computer.cube_traffic_token_ciphertext) throw new Error('该租户 VM 缺少加密的数据面令牌。');
  return { sandboxId: computer.sandbox_id, trafficToken: decryptSandboxTrafficToken(computer.cube_traffic_token_ciphertext) };
}
