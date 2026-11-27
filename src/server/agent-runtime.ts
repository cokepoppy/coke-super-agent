import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import type { PtyHandle } from '@cubesandbox/sdk';
import type { RowDataPacket } from 'mysql2/promise';
import type { RunStatus, RunTraceEvent } from '../shared/types.ts';
import { hasSupportedPiRuntimeContract } from '../shared/pi-runtime-contract.ts';
import { createPiRuntimeKey } from '../shared/pi-runtime-key.ts';
import { connectTenantSandbox, getTenantComputer, startTenantComputer } from './computer.ts';
import { config } from './config.ts';
import { pool } from './db.ts';
import { runGuestPty, stageRuntimeBundle, startGuestPty } from './runtime-bundle.ts';
import { appendRunTrace, sanitizeRunTrace, transitionRun } from './task-store.ts';
import { isGuestAgentProcessCommandLine } from './guest-process-identity.ts';
import { classifyGuestRunRecovery } from './guest-run-recovery.ts';

interface PendingRun extends RowDataPacket {
  id: string;
  tenant_id: string;
  thread_id: string;
  prompt: string;
  status: RunStatus;
}

interface GuestRunState {
  status?: 'working' | 'waiting_for_user' | 'done' | 'failed';
  stage?: string;
  errorName?: string;
  message?: string;
  pid?: number;
  updatedAt?: string;
  traces?: Array<RunTraceEvent & { sequence: number }>;
}

const activeTenants = new Set<string>();
let scanner: NodeJS.Timeout | undefined;
let stopped = true;

const desktopBootstrapScript = resolve(process.cwd(), 'scripts/cube/bootstrap-dsh-runtime.sh');
const hostBundleScript = resolve(process.cwd(), 'scripts/cube/prepare-dsh-runtime-linux-arm64.sh');
const guestPackageDirectory = resolve(process.cwd(), 'scripts/cube/dsh-runtime');
const guestRuntimeScript = resolve(guestPackageDirectory, 'run-task.mjs');
const guestComputerPlugin = resolve(guestPackageDirectory, 'computer-plugin.mjs');
const guestChromePipeBridge = resolve(guestPackageDirectory, 'chrome-cdp-pipe-bridge.mjs');
const guestRuntimeManifest = resolve(guestPackageDirectory, 'runtime-manifest.json');
const guestRuntimeLauncher = resolve(guestPackageDirectory, 'dsh-runtime-launcher.mjs');
const guestBootstrapWrapper = resolve(process.cwd(), 'scripts/cube/run-dsh-runtime-bootstrap.sh');
const piPackageDirectory = resolve(process.cwd(), 'scripts/cube/pi-runtime');
const piRuntimeScript = resolve(piPackageDirectory, 'run-task.mjs');
const piRuntimeManifest = resolve(piPackageDirectory, 'runtime-manifest.json');
const piBundleBuilder = resolve(process.cwd(), 'scripts/cube/prepare-pi-runtime-linux-arm64.sh');
type HostRuntimeBundle = { archivePath: string; runtimeKey: string; archiveSha256: string; size: number };
const hostBundlePromises = new Map<string, Promise<HostRuntimeBundle>>();
const runtimeErrorLogAt = new Map<string, number>();
const runtimeErrorLogSuppressed = new Map<string, number>();
const guestTerminalExitGraceMs = 35_000;

export function startAgentRuntime(): void {
  stopped = false;
  writeRuntimeLog('queue.scanner.start', 'info', { intervalMs: 2500 });
  void scanPendingTenants();
  scanner = setInterval(() => void scanPendingTenants(), 2500);
  scanner.unref();
}

export function stopAgentRuntime(): void {
  stopped = true;
  if (scanner) clearInterval(scanner);
  scanner = undefined;
  writeRuntimeLog('queue.scanner.stop', 'info', { activeTenantCount: activeTenants.size });
}

export function scheduleAgentRun(tenantId: string): void {
  if (!stopped) {
    void drainTenant(tenantId).catch(error => {
      writeRateLimitedRuntimeError(`queue.drain:${tenantId}`, 'queue.drain.failed', { tenantId, ...runtimeErrorDetails(error) });
    });
  }
}

async function scanPendingTenants(): Promise<void> {
  if (stopped) return;
  try {
    const [rows] = await pool.query<RowDataPacket[]>(
      "SELECT DISTINCT tenant_id FROM runs WHERE status IN ('queued', 'working') LIMIT 100",
    );
    for (const row of rows) scheduleAgentRun(String(row.tenant_id));
  } catch (error) {
    writeRateLimitedRuntimeError('queue.scan', 'queue.scan.failed', runtimeErrorDetails(error));
  }
}

async function nextPendingRun(tenantId: string): Promise<PendingRun | null> {
  const [rows] = await pool.execute<PendingRun[]>(
    `SELECT id, tenant_id, thread_id, prompt, status FROM runs
      WHERE tenant_id = ? AND status IN ('working', 'queued')
      ORDER BY CASE status WHEN 'working' THEN 0 ELSE 1 END, created_at ASC LIMIT 1`,
    [tenantId],
  );
  return rows[0] || null;
}

async function drainTenant(tenantId: string): Promise<void> {
  if (stopped || activeTenants.has(tenantId)) return;
  const drainStartedAt = Date.now();
  activeTenants.add(tenantId);
  writeRuntimeLog('queue.drain.start', 'info', { tenantId });
  try {
    while (!stopped) {
      const run = await nextPendingRun(tenantId);
      if (!run) return;
      if (run.status === 'queued') {
        await transitionRun(tenantId, run.id, 'working', 'progress', 'Agent Runtime 已接单，正在准备租户云电脑。');
        await trace(run, { component: 'agent-runtime', stage: 'queue.accepted', level: 'info', message: 'Agent Runtime 已接单。' });
      }
      try {
        await executeRun(run);
      } catch (error) {
        const message = safeError(error);
        await trace(run, { component: 'agent-runtime', stage: 'run.failed', level: 'error', message, details: runtimeErrorDetails(error) });
        await transitionRun(tenantId, run.id, 'failed', 'failed', message).catch(transitionError => {
          const failure = sanitizeRunTrace({ component: 'agent-runtime', stage: 'run.failed.persist', level: 'error', message: safeError(transitionError) });
          process.stderr.write(JSON.stringify({ timestamp: new Date().toISOString(), logger: 'coke-super-agent.run', tenantId, runId: run.id, sequence: null, persisted: false, ...failure }) + '\n');
        });
      }
    }
  } finally {
    activeTenants.delete(tenantId);
    writeRuntimeLog('queue.drain.complete', 'info', { tenantId, durationMs: Date.now() - drainStartedAt });
    if (!stopped) {
      const remaining = await nextPendingRun(tenantId).catch(() => null);
      if (remaining) queueMicrotask(() => scheduleAgentRun(tenantId));
    }
  }
}

function writeRuntimeLog(stage: string, level: 'info' | 'warning' | 'error', details: Record<string, unknown> = {}): void {
  process.stdout.write(JSON.stringify({ timestamp: new Date().toISOString(), logger: 'coke-super-agent.agent-runtime', stage, level, ...details }) + '\n');
}

function writeRateLimitedRuntimeError(key: string, stage: string, details: Record<string, unknown>): void {
  const now = Date.now();
  const last = runtimeErrorLogAt.get(key) || 0;
  if (now - last < 30_000) {
    runtimeErrorLogSuppressed.set(key, (runtimeErrorLogSuppressed.get(key) || 0) + 1);
    return;
  }
  const suppressedOccurrences = runtimeErrorLogSuppressed.get(key) || 0;
  runtimeErrorLogAt.set(key, now);
  runtimeErrorLogSuppressed.delete(key);
  writeRuntimeLog(stage, 'error', { ...details, suppressedOccurrences });
}

async function executeRun(run: PendingRun): Promise<void> {
  const runtimeEngine = config.agent.runtime;
  if (runtimeEngine !== 'dsh' && runtimeEngine !== 'pi') {
    throw new Error('CSA_AGENT_RUNTIME must be dsh or pi.');
  }
  await trace(run, { component: 'agent-runtime', stage: 'run.start', level: 'info', message: '开始执行任务。' });
  let model: { baseUrl: string; model: string };
  try { model = requireModelConfiguration(); }
  catch (error) {
    await trace(run, { component: 'configuration', stage: 'model.validate', level: 'error', message: safeError(error), details: runtimeErrorDetails(error) });
    throw error;
  }
  const modelBaseUrl = runtimeEngine === 'pi' ? config.agent.piBaseUrl : model.baseUrl;
  const endpoint = new URL(modelBaseUrl);
  await trace(run, { component: 'agent-runtime', stage: 'runtime.engine.selected', level: 'info', message: '本次任务使用 ' + (runtimeEngine === 'pi' ? 'Pi' : 'DeepSeek Harness') + ' Agent Runtime。', details: { engine: runtimeEngine } });
  await trace(run, { component: 'configuration', stage: 'model.ready', level: 'info', message: 'DeepSeek 模型与 API 地址配置已就绪。', details: { engine: runtimeEngine, model: model.model, endpointHost: endpoint.host, endpointPath: endpoint.pathname, apiProtocol: runtimeEngine === 'pi' ? 'openai-completions' : 'anthropic-messages', apiKeyConfigured: true } });
  await transitionRun(run.tenant_id, run.id, 'working', 'progress', '正在启动或恢复租户 Linux microVM。');

  let computer = await startTenantComputer(run.tenant_id, { purpose: 'task', trace: event => trace(run, event), runId: run.id });
  if (computer.state === 'creating') {
    const timeoutMs = Math.max(60_000, config.cube.requestTimeoutMs + 10_000);
    const deadline = Date.now() + timeoutMs;
    await trace(run, { component: 'cube', stage: 'sandbox.wait', level: 'info', message: '等待并发创建的租户 Linux microVM。', details: { timeoutMs } });
    do {
      await delay(2_000);
      if (stopped) return;
      computer = await getTenantComputer(run.tenant_id);
    } while (computer.state === 'creating' && Date.now() < deadline);
  }
  if (stopped) return;
  if (computer.state === 'creating') throw new Error('等待租户 Linux microVM 启动超时，请稍后重试。');
  if (computer.state !== 'running') throw new Error('租户 Linux microVM 启动失败，请到“云电脑”页面检查状态。');

  const sandbox = await connectTenantSandbox(run.tenant_id);
  try {
    await trace(run, { component: 'cube', stage: 'sandbox.data-plane.connected', level: 'info', message: '已连接租户 microVM 数据面，开始准备任务工作目录。', details: { computerState: computer.state, desktopState: computer.desktopState } });
    const runDirectory = `/workspace/.csa-super-agent/runs/${run.id}`;
    const taskDirectory = `/workspace/tasks/${run.thread_id}`;
    const prepared = await runGuestPty(
      sandbox,
      `set -eu; desktop_user="$(/usr/bin/getent passwd 1000 | /usr/bin/cut -d: -f1)"; if [ -z "$desktop_user" ]; then echo 'desktop UID 1000 is missing' >&2; exit 1; fi; desktop_uid="$(/usr/bin/id -u "$desktop_user")"; desktop_gid="$(/usr/bin/id -g "$desktop_user")"; install -d -m 0755 /opt/csa-agent-runtime /var/lib/csa-agent-runtime /workspace/.csa-super-agent /workspace/.csa-super-agent/runs /workspace/tasks; chown "$desktop_uid:$desktop_gid" /workspace/.csa-super-agent /workspace/.csa-super-agent/runs /workspace/tasks; install -d -o "$desktop_uid" -g "$desktop_gid" -m 0700 ${runDirectory} ${taskDirectory}`,
      '/', {}, undefined, 45_000,
    );
    if (prepared.exitCode !== 0) throw new Error('无法准备租户的 Agent Runtime 工作目录。');
    await trace(run, { component: 'agent-runtime', stage: 'guest.workspace.ready', level: 'info', message: '租户任务目录与 runtime 目录已准备好。', details: { threadId: run.thread_id } });

    const runtimeFiles = {
      packageJson: await readFile(resolve(guestPackageDirectory, 'package.json'), 'utf8'),
      packageLock: await readFile(resolve(guestPackageDirectory, 'package-lock.json'), 'utf8'),
      runtimeManifest: await readFile(guestRuntimeManifest, 'utf8'),
      runtimeSource: await readFile(guestRuntimeScript, 'utf8'),
      computerSource: await readFile(guestComputerPlugin, 'utf8'),
      chromeBridgeSource: await readFile(guestChromePipeBridge, 'utf8'),
      runtimeLauncher: await readFile(guestRuntimeLauncher, 'utf8'),
      bootstrapSource: await readFile(desktopBootstrapScript, 'utf8'),
      bootstrapWrapper: await readFile(guestBootstrapWrapper, 'utf8'),
    };
    let piRuntimeDirectory: string | undefined;
    try {
      if (runtimeEngine === 'pi') {
        const piFiles = {
          packageJson: await readFile(resolve(piPackageDirectory, 'package.json'), 'utf8'),
          packageLock: await readFile(resolve(piPackageDirectory, 'package-lock.json'), 'utf8'),
          runtimeManifest: await readFile(piRuntimeManifest, 'utf8'),
          runtimeSource: await readFile(piRuntimeScript, 'utf8'),
          computerSource: await readFile(guestComputerPlugin, 'utf8'),
        };
        piRuntimeDirectory = await installGuestPiRuntime(sandbox, run, piFiles);
      } else {
        await installGuestRuntime(sandbox, run, runtimeFiles);
      }
    }
    catch (error) {
      await trace(run, { component: 'runtime-install', stage: 'runtime.install.error', level: 'error', message: safeError(error), details: runtimeErrorDetails(error) });
      throw error;
    }
    if (stopped) return;

    const existingState = await readGuestState(sandbox, `${runDirectory}/state.json`);
    const launcherPath = `${runDirectory}/launcher.pid`;
    const launcherMarkerExists = await sandbox.files.exists(launcherPath);
    const recoveryDecision = classifyGuestRunRecovery(existingState, launcherMarkerExists);
    await trace(run, {
      component: 'agent-runtime',
      stage: 'guest.recovery.inspect',
      level: recoveryDecision === 'fail-closed' ? 'warning' : 'info',
      message: '检查 microVM 中已持久化的 Agent 状态，决定恢复、提交结果或启动新进程。',
      details: {
        decision: recoveryDecision,
        statePresent: existingState !== null,
        stateStatus: existingState?.status || null,
        guestPidPresent: Number.isSafeInteger(existingState?.pid),
        launcherMarkerExists,
      },
    });
    if (recoveryDecision === 'persist-terminal' && existingState) {
      await publishGuestTraces(run, existingState, 0);
      await trace(run, { component: 'agent-runtime', stage: 'guest.recovery.terminal-state', level: 'info', message: 'guest 已写入最终状态；恢复器直接提交该结果，不会重新运行任务。', details: { status: existingState.status ?? null } });
      await persistGuestTerminalState(run, sandbox, existingState);
      return;
    }
    if (recoveryDecision === 'resume' && existingState) {
      const launcherPidValue = Number((await sandbox.files.read(launcherPath).catch(() => '')).trim());
      const launcherPidValid = Number.isSafeInteger(launcherPidValue) && launcherPidValue > 0;
      const agentProcessMatches = Number.isSafeInteger(existingState.pid)
        ? await guestProcessIsAlive(sandbox, existingState.pid!, run.id)
        : false;
      await trace(run, {
        component: 'agent-runtime',
        stage: 'guest.recovery.process.inspect',
        level: agentProcessMatches && launcherPidValid ? 'info' : 'warning',
        message: '核对 guest Agent PID、任务身份和可重新连接的 PTY launcher。',
        details: {
          agentPidPresent: Number.isSafeInteger(existingState.pid),
          agentProcessMatches,
          launcherPidValid,
        },
      });
      let guestHandle: PtyHandle | undefined;
      if (agentProcessMatches && launcherPidValid) {
        const reconnectStartedAt = Date.now();
        await trace(run, { component: 'agent-runtime', stage: 'guest.pty.reconnect.start', level: 'info', message: '正在重新连接仍在运行的 microVM Agent PTY。' });
        try {
          guestHandle = await sandbox.pty.connect(launcherPidValue, { timeoutMs: 0 });
          await trace(run, { component: 'agent-runtime', stage: 'guest.pty.reconnect.complete', level: 'info', message: '已重新连接 microVM Agent PTY，将继续监听原任务，不会启动第二个 Agent 进程。', durationMs: Date.now() - reconnectStartedAt });
        } catch (error) {
          await trace(run, { component: 'agent-runtime', stage: 'guest.pty.reconnect.failed', level: 'warning', message: '无法重新连接仍在运行的 Agent PTY。', durationMs: Date.now() - reconnectStartedAt, details: runtimeErrorDetails(error) });
        }
      }
      if (guestHandle) {
        await monitorGuestRun(sandbox, run, existingState, runDirectory, guestHandle);
        return;
      }
      const message = 'microVM 中仍有未完成的 Agent 状态，但无法验证或重新连接原进程；外部操作结果需要核实。为避免重复操作，任务没有自动重放。可以在同一对话中继续。';
      await trace(run, { component: 'agent-runtime', stage: 'guest.recovery.abandoned', level: 'error', message: '原 Agent 进程无法安全恢复，停止自动重放。' });
      await transitionRun(run.tenant_id, run.id, 'failed', 'failed', message);
      return;
    }
    if (recoveryDecision === 'fail-closed') {
      const message = 'microVM 中的任务状态不完整或无法识别；外部操作结果需要核实。为避免重复操作，任务没有自动重放。可以在同一对话中继续。';
      await trace(run, { component: 'agent-runtime', stage: 'guest.recovery.uncertain', level: 'error', message: 'guest 状态与 launcher 标记不一致，无法证明任务尚未开始；停止自动重放。' });
      await transitionRun(run.tenant_id, run.id, 'failed', 'failed', message);
      return;
    }

    await sandbox.files.write(join(runDirectory, 'input.json'), JSON.stringify({ threadId: run.thread_id, prompt: run.prompt, baseUrl: runtimeEngine === 'pi' ? config.agent.piBaseUrl : model.baseUrl, model: model.model }));
    const runtimeLockSource = runtimeEngine === 'pi'
      ? await readFile(resolve(piPackageDirectory, 'package-lock.json'), 'utf8')
      : runtimeFiles.packageLock;
    const runtimeLock = createHash('sha256').update(runtimeLockSource).digest('hex').slice(0, 16);
    const guestRuntimeEntry = runtimeEngine === 'pi'
      ? join(piRuntimeDirectory!, 'run-task.mjs')
      : '/opt/csa-agent-runtime/dsh-sdk-client/dist/run-task.bundle.mjs';
    await trace(run, { component: runtimeEngine, stage: runtimeEngine === 'pi' ? 'runtime.launch' : 'harness.launch', level: 'info', message: runtimeEngine === 'pi' ? '启动 Pi SDK Agent Runtime。' : '启动 DeepSeek Harness SDK runtime。', details: { profile: runtimeEngine === 'pi' ? 'sdk' : 'sdk-minimal', model: model.model, runtimeLock } });
    const guestOutputPath = `${runDirectory}/stdout.log`;
    const computerTraceFollow = runtimeEngine === 'pi'
      ? `: > ${guestOutputPath}; /usr/bin/tail -n 0 -F ${guestOutputPath} & log_tail_pid=$!`
      : '';
    const computerTraceStop = runtimeEngine === 'pi'
      ? '/usr/bin/kill "$log_tail_pid" 2>/dev/null || true; wait "$log_tail_pid" 2>/dev/null || true'
      : '';
    const startCommand = [
      'printf "%s\\n" "$$" > ' + runDirectory + '/launcher.pid',
      computerTraceFollow,
      '/usr/bin/setpriv --reuid=1000 --regid="$(/usr/bin/id -g "$(/usr/bin/getent passwd 1000 | /usr/bin/cut -d: -f1)")" --init-groups /opt/csa-agent-runtime/bin/node ' + guestRuntimeEntry + ' ' + run.id + ' > ' + guestOutputPath + ' 2>&1 & agent_pid=$!',
      'while /usr/bin/kill -0 "$agent_pid" 2>/dev/null; do printf "csa_agent_task_running\\n"; /usr/bin/sleep 15; done',
      'wait "$agent_pid"; status=$?',
      computerTraceStop,
      'exit "$status"',
    ].filter(Boolean).join('; ');
    const guestHandle = await startGuestPty(sandbox, startCommand, taskDirectory, {
      HOME: '/workspace/.desktop-home',
      DISPLAY: ':1',
      PATH: '/opt/csa-agent-runtime/bin:/opt/csa-agent-runtime:/usr/local/bin:/usr/bin:/bin',
      CSA_TENANT_ID: run.tenant_id,
      CSA_RUN_ID: run.id,
      DEEPSEEK_API_KEY: config.agent.apiKey,
      DSH_PERMISSION_MODE: 'danger-full-access',
      COKE_DESKTOP_RESOLUTION: config.agent.desktopResolution,
      COKE_AGENT_HANDOFF_FILE: `${runDirectory}/handoff.json`,
    });
    await monitorGuestRun(sandbox, run, { status: 'working', message: runtimeEngine === 'pi' ? 'Pi SDK 已在租户 microVM 中启动。' : 'DeepSeek Harness 已在租户 microVM 中启动。' }, runDirectory, guestHandle);
  } finally {
    sandbox.close();
  }
}

async function installGuestRuntime(
  sandbox: Awaited<ReturnType<typeof connectTenantSandbox>>,
  run: PendingRun,
  files: {
    packageJson: string;
    packageLock: string;
    runtimeManifest: string;
    runtimeSource: string;
    computerSource: string;
    chromeBridgeSource: string;
    runtimeLauncher: string;
    bootstrapSource: string;
    bootstrapWrapper: string;
  },
): Promise<void> {
  const runtimeSyncStartedAt = Date.now();
  const packageLock = files.packageLock;
  const expectedLockHash = createHash('sha256').update(packageLock).digest('hex');
  const manifest = JSON.parse(files.runtimeManifest) as { deepseekHarnessVersion?: string; runtimeWheelSha256?: string };
  const expectedWheelHash = String(manifest.runtimeWheelSha256 || '');
  const runtimeVersion = String(manifest.deepseekHarnessVersion || '');
  if (!/^[a-f0-9]{64}$/.test(expectedWheelHash) || runtimeVersion !== '0.2.2-rc.2') {
    throw new Error('Pinned DeepSeek Harness SDK and runtime version manifest is invalid.');
  }
  const runtimeBundleBuilder = await readFile(hostBundleScript, 'utf8');
  const runtimeKey = createHash('sha256').update(packageLock).update('\0').update(files.runtimeManifest).update('\0').update(runtimeBundleBuilder).update('\0').update(files.runtimeSource).update('\0').update(files.computerSource).update('\0').update(files.chromeBridgeSource).update('\0').update(files.runtimeLauncher).update('\0').update(files.bootstrapSource).update('\0').update(files.bootstrapWrapper).digest('hex');
  await trace(run, { component: 'runtime-install', stage: 'runtime.inspect', level: 'info', message: '检查 microVM 内的 DeepSeek Harness SDK 与官方可执行 runtime 版本。', details: { runtimeKey: runtimeKey.slice(0, 16), runtimeVersion } });
  try {
    if (await sandbox.files.exists('/var/lib/csa-agent-runtime/ready') &&
      await sandbox.files.exists('/var/lib/csa-agent-runtime/package-lock.sha256') &&
      (await sandbox.files.read('/var/lib/csa-agent-runtime/package-lock.sha256')).trim() === expectedLockHash &&
      await sandbox.files.exists('/var/lib/csa-agent-runtime/runtime-wheel.sha256') &&
      (await sandbox.files.read('/var/lib/csa-agent-runtime/runtime-wheel.sha256')).trim() === expectedWheelHash &&
      await sandbox.files.exists('/var/lib/csa-agent-runtime/runtime-key.sha256') &&
      (await sandbox.files.read('/var/lib/csa-agent-runtime/runtime-key.sha256')).trim() === runtimeKey) {
      const runtimeFiles = await Promise.all([
        sandbox.files.exists('/opt/csa-agent-runtime/bin/node'),
        sandbox.files.exists('/opt/csa-agent-runtime/dsh-sdk-client/dist/run-task.bundle.mjs'),
        sandbox.files.exists('/opt/csa-agent-runtime/dsh-sdk-client/package.json'),
        sandbox.files.exists('/opt/csa-agent-runtime/dsh-runtime-launcher.mjs'),
        sandbox.files.exists('/opt/csa-agent-runtime/chrome-cdp-pipe-bridge.cjs'),
        sandbox.files.exists('/opt/csa-agent-runtime/dsh-runtime-bin/runtime/deepseek-harness-sdk-runtime-linux-arm64'),
        sandbox.files.exists('/opt/csa-agent-runtime/dsh-runtime-bin/runtime/deepseek-harness-sdk-runtime-linux-arm64-rg'),
        sandbox.files.exists('/opt/csa-agent-runtime/dsh-runtime-bin/runtime/linux-arm64/downloads.json'),
      ]);
      if (runtimeFiles.every(Boolean)) {
        await sandbox.files.write('/opt/csa-agent-runtime/computer-plugin.mjs', files.computerSource);
        await trace(run, { component: 'runtime-install', stage: 'runtime.reuse', level: 'info', message: 'SDK worker 与官方 runtime 校验和匹配，复用模板内的预装依赖。', durationMs: Date.now() - runtimeSyncStartedAt, details: { runtimeKey: runtimeKey.slice(0, 16), runtimeVersion } });
        return;
      }
    }
  } catch { /* Reinstall if the guest state is incomplete. */ }

  const prepared = await runGuestPty(
    sandbox,
    'set -eu; install -d -m 0755 /opt/csa-agent-runtime /var/lib/csa-agent-runtime',
    '/',
  );
  if (prepared.exitCode !== 0) throw new Error('无法准备租户的 Agent Runtime 安装目录。');
  await sandbox.files.write('/opt/csa-agent-runtime/package.json', files.packageJson);
  await sandbox.files.write('/opt/csa-agent-runtime/package-lock.json', files.packageLock);
  await sandbox.files.write('/opt/csa-agent-runtime/runtime-manifest.json', files.runtimeManifest);
  await sandbox.files.write('/opt/csa-agent-runtime/computer-plugin.mjs', files.computerSource);
  await sandbox.files.write('/var/lib/csa-agent-runtime/runtime-key.expected.sha256', runtimeKey + '\n');
  await sandbox.files.write('/tmp/csa-bootstrap-dsh-runtime.sh', files.bootstrapSource);
  await sandbox.files.write('/tmp/csa-run-dsh-runtime-bootstrap.sh', files.bootstrapWrapper);

  const stagedPaths = [
    '/opt/csa-agent-runtime/bin/node',
    '/opt/csa-agent-runtime/dsh-sdk-client/dist/run-task.bundle.mjs',
    '/opt/csa-agent-runtime/dsh-sdk-client/package.json',
    '/opt/csa-agent-runtime/dsh-runtime-launcher.mjs',
    '/opt/csa-agent-runtime/chrome-cdp-pipe-bridge.cjs',
    '/opt/csa-agent-runtime/dsh-runtime-bin/runtime/deepseek-harness-sdk-runtime-linux-arm64',
    '/opt/csa-agent-runtime/dsh-runtime-bin/runtime/deepseek-harness-sdk-runtime-linux-arm64-rg',
    '/opt/csa-agent-runtime/dsh-runtime-bin/runtime/linux-arm64/downloads.json',
  ];
  const [stagedRuntimeKey, stagedWheelHash, expectedRuntimeKey, stagedFiles] = await Promise.all([
    sandbox.files.read('/opt/csa-agent-runtime/runtime-key.sha256').catch(() => ''),
    sandbox.files.read('/opt/csa-agent-runtime/runtime-wheel.sha256').catch(() => ''),
    sandbox.files.read('/var/lib/csa-agent-runtime/runtime-key.expected.sha256').catch(() => ''),
    Promise.all(stagedPaths.map(path => sandbox.files.exists(path).catch(() => false))),
  ]);
  const stagedRuntimeMatches = stagedRuntimeKey.trim() === runtimeKey
    && stagedWheelHash.trim() === expectedWheelHash
    && expectedRuntimeKey.trim() === runtimeKey
    && stagedFiles.every(Boolean);

  if (stagedRuntimeMatches) {
    await trace(run, { component: 'runtime-install', stage: 'runtime.stage.reuse', level: 'info', message: '复用已解包并校验过的 runtime 文件，只重跑 profile 启动检查。', details: { runtimeKey: runtimeKey.slice(0, 16), runtimeVersion, stagedFileCount: stagedFiles.length } });
  } else {
    await trace(run, { component: 'runtime-install', stage: 'runtime.bundle.prepare', level: 'info', message: 'microVM 缺少匹配的 runtime，开始准备 Linux ARM64 SDK 和官方 Harness 可执行包。', details: { runtimeKey: runtimeKey.slice(0, 16), runtimeVersion } });
    await transitionRun(run.tenant_id, run.id, 'working', 'progress', '正在通过 Mac 的 HTTP 代理准备 Linux ARM64 SDK 与 DeepSeek Harness runtime；首次下载期间会持续报告进度。');
    const bundle = await prepareHostRuntimeBundle(run, runtimeKey);
    await trace(run, { component: 'runtime-install', stage: 'runtime.bundle.ready', level: 'info', message: 'Linux ARM64 SDK 与官方 Harness runtime 已在 Mac 宿主准备好。', details: { runtimeKey: bundle.runtimeKey.slice(0, 16), runtimeVersion, sizeBytes: bundle.size } });
    await transitionRun(run.tenant_id, run.id, 'working', 'progress', 'Linux ARM64 依赖包已准备好，正在分块传入租户 microVM。');
    const transferStartedAt = Date.now();
    await trace(run, { component: 'runtime-install', stage: 'runtime.transfer.start', level: 'info', message: '开始把 SDK 与官方 runtime 分块传入租户 microVM。', details: { sizeBytes: bundle.size } });
    await stageRuntimeBundle(sandbox, bundle, async event => {
      await trace(run, {
        component: 'runtime-transfer',
        stage: 'bundle.' + event.stage,
        level: event.level,
        message: event.message,
        ...(event.durationMs === undefined ? {} : { durationMs: event.durationMs }),
        ...(event.details ? { details: event.details } : {}),
      });
      if (event.stage === 'chunk.upload.progress' || event.stage === 'assembly.progress') {
        await transitionRun(run.tenant_id, run.id, 'working', 'progress', event.message);
      }
    });
    await trace(run, { component: 'runtime-install', stage: 'runtime.transfer.complete', level: 'info', message: 'runtime 依赖包已传入租户 microVM。', durationMs: Date.now() - transferStartedAt, details: { sizeBytes: bundle.size } });
  }
  await sandbox.files.remove('/var/lib/csa-agent-runtime/install.exit').catch(() => undefined);
  // Allow for cold snapshot restore latency before the installer launch returns.
  const launch = await sandbox.commands.run(
    [
      'set -eu',
      'nohup setsid bash /tmp/csa-run-dsh-runtime-bootstrap.sh >/var/lib/csa-agent-runtime/installer-launch.log 2>&1 </dev/null &',
      'printf "%s\\n" "$!" > /var/lib/csa-agent-runtime/installer.pid',
      'echo csa_dsh_runtime_installer_started',
    ].join('\n'),
    { timeoutMs: 60_000, envs: { CSA_TENANT_ID: run.tenant_id, CSA_RUN_ID: run.id } },
  );
  if (launch.exitCode !== 0) throw new Error('DeepSeek Harness guest installer could not be started: ' + String(launch.stderr || launch.stdout || '').slice(-800));
  await transitionRun(run.tenant_id, run.id, 'working', 'progress', '正在将 DeepSeek Harness 依赖解包并验证在租户 microVM 中。');
  await delay(1000);
  const installStartedAt = Date.now();
  let lastProgressAt = installStartedAt;
  let lastStatusApiWarningAt = 0;
  const deadline = installStartedAt + 18 * 60_000;
  while (!stopped && Date.now() < deadline) {
    let hasExitMarker = false;
    try {
      hasExitMarker = await sandbox.files.exists('/var/lib/csa-agent-runtime/install.exit');
    } catch (error) {
      if (!isRetryableDataPlaneError(error)) throw error;
      if (Date.now() - lastStatusApiWarningAt >= 30_000) {
        await trace(run, { component: 'runtime-install', stage: 'runtime.status.poll.retry', level: 'warning', message: 'Cube guest 状态接口暂时超时，正在重试读取安装结果。', details: { elapsedSeconds: Math.floor((Date.now() - installStartedAt) / 1000), error: safeError(error) } });
        lastStatusApiWarningAt = Date.now();
      }
    }
    if (hasExitMarker) {
      const result = (await readGuestFileWithRetry(sandbox, '/var/lib/csa-agent-runtime/install.exit', Math.min(deadline, Date.now() + 60_000))).trim();
      if (result === '0') {
        const ready = await guestFileExistsWithRetry(sandbox, '/var/lib/csa-agent-runtime/ready', Math.min(deadline, Date.now() + 60_000))
          && (await readGuestFileWithRetry(sandbox, '/var/lib/csa-agent-runtime/package-lock.sha256', Math.min(deadline, Date.now() + 60_000)).catch(() => '')).trim() === expectedLockHash
          && (await readGuestFileWithRetry(sandbox, '/var/lib/csa-agent-runtime/runtime-wheel.sha256', Math.min(deadline, Date.now() + 60_000)).catch(() => '')).trim() === expectedWheelHash
          && (await readGuestFileWithRetry(sandbox, '/var/lib/csa-agent-runtime/runtime-key.sha256', Math.min(deadline, Date.now() + 60_000)).catch(() => '')).trim() === runtimeKey;
        if (!ready) {
          const logTail = await readGuestInstallerLogs(sandbox);
          await trace(run, { component: 'runtime-install', stage: 'runtime.install.marker-mismatch', level: 'error', message: 'guest 安装器退出码为 0，但 ready 标记或 runtime 校验和不匹配。', details: { runtimeKey: runtimeKey.slice(0, 16), logTail } });
          throw new Error('DeepSeek Harness guest installer exited successfully without matching ready markers.' + (logTail ? ' ' + logTail.slice(-1000) : ''));
        }
        await trace(run, { component: 'runtime-install', stage: 'runtime.install.complete', level: 'info', message: 'DeepSeek Harness SDK 与官方可执行 runtime 已安装并通过校验。', durationMs: Date.now() - installStartedAt, details: { runtimeKey: runtimeKey.slice(0, 16), runtimeVersion } });
        return;
      }
      const detail = await readGuestInstallerLogs(sandbox);
      await trace(run, { component: 'runtime-install', stage: 'runtime.install.failed', level: 'error', message: 'DeepSeek Harness guest 安装脚本返回失败。', durationMs: Date.now() - installStartedAt, details: { exitCode: result, logTail: detail.slice(-1000) } });
      throw new Error('DeepSeek Harness 预下载依赖未能安装到租户云电脑，请检查 guest 解包日志后重试。');
    }

    if (Date.now() - lastProgressAt >= 30_000) {
      const elapsedSeconds = Math.floor((Date.now() - installStartedAt) / 1000);
      await transitionRun(
        run.tenant_id,
        run.id,
        'working',
        'progress',
        `DeepSeek Harness 仍在租户 microVM 内解包和验证依赖，已运行 ${elapsedSeconds} 秒。`,
      );
      const logTail = await readGuestInstallerLogs(sandbox);
      await trace(run, { component: 'runtime-install', stage: 'runtime.install.wait', level: 'info', message: 'microVM 正在解包并验证 Harness runtime。', details: { elapsedSeconds, ...(logTail ? { guestLogTail: logTail.slice(-800) } : {}) } });
      lastProgressAt = Date.now();
    }
    await delay(15_000);
  }
  if (stopped) {
    const installerPid = Number((await sandbox.files.read('/var/lib/csa-agent-runtime/installer.pid').catch(() => '')).trim());
    if (Number.isSafeInteger(installerPid) && installerPid > 0) {
      await sandbox.commands.run(`/usr/bin/kill -TERM -- -${installerPid}`, { timeoutMs: 5_000 }).catch(() => undefined);
    }
    return;
  }
  const installerPid = Number((await sandbox.files.read('/var/lib/csa-agent-runtime/installer.pid').catch(() => '')).trim());
  if (Number.isSafeInteger(installerPid) && installerPid > 0) {
    await sandbox.commands.run(`/usr/bin/kill -TERM -- -${installerPid}`, { timeoutMs: 5_000 }).catch(() => undefined);
  }
  throw new Error('DeepSeek Harness 依赖在 microVM 内安装超过 18 分钟。');
}

async function readGuestInstallerLogs(sandbox: Awaited<ReturnType<typeof connectTenantSandbox>>): Promise<string> {
  const [installLog, launcherLog] = await Promise.all([
    readGuestFileWithRetry(sandbox, '/var/lib/csa-agent-runtime/install.log', Date.now() + 10_000).catch(() => ''),
    readGuestFileWithRetry(sandbox, '/var/lib/csa-agent-runtime/installer-launch.log', Date.now() + 10_000).catch(() => ''),
  ]);
  return [
    installLog.trim() ? 'install.log: ' + installLog.trim().split(/\r?\n/).slice(-6).join(' | ') : '',
    launcherLog.trim() ? 'installer-launch.log: ' + launcherLog.trim().split(/\r?\n/).slice(-6).join(' | ') : '',
  ].filter(Boolean).join(' ; ').slice(-1600);
}

async function guestFileExistsWithRetry(
  sandbox: Awaited<ReturnType<typeof connectTenantSandbox>>,
  path: string,
  deadline: number,
): Promise<boolean> {
  let lastError: unknown;
  while (Date.now() < deadline) {
    try { return await sandbox.files.exists(path); }
    catch (error) {
      if (!isRetryableDataPlaneError(error)) throw error;
      lastError = error;
      await delay(2_000);
    }
  }
  if (lastError instanceof Error) throw lastError;
  return false;
}

async function readGuestFileWithRetry(
  sandbox: Awaited<ReturnType<typeof connectTenantSandbox>>,
  path: string,
  deadline: number,
): Promise<string> {
  let lastError: unknown;
  while (Date.now() < deadline) {
    try { return await sandbox.files.read(path); }
    catch (error) {
      if (!isRetryableDataPlaneError(error)) throw error;
      lastError = error;
      await delay(2_000);
    }
  }
  if (lastError instanceof Error) throw lastError;
  throw new Error('Guest file read timed out: ' + path);
}

async function installGuestPiRuntime(
  sandbox: Awaited<ReturnType<typeof connectTenantSandbox>>,
  run: PendingRun,
  files: { packageJson: string; packageLock: string; runtimeManifest: string; runtimeSource: string; computerSource: string },
): Promise<string> {
  if (!hasSupportedPiRuntimeContract(files.packageJson, files.runtimeManifest)) {
    throw new Error('Pinned Pi runtime manifest is invalid.');
  }
  const manifest = JSON.parse(files.runtimeManifest) as { package: string; version: string; apiProtocol: string };
  await ensureGuestPiNodeRuntime(sandbox, run);
  const builderSource = await readFile(piBundleBuilder, 'utf8');
  const runtimeKey = createPiRuntimeKey({
    packageJson: files.packageJson,
    packageLock: files.packageLock,
    runtimeManifest: files.runtimeManifest,
    bundleBuilder: builderSource,
    runtimeSource: files.runtimeSource,
    computerPlugin: files.computerSource,
  });
  const runtimeDirectory = '/opt/csa-agent-runtime/pi-' + runtimeKey.slice(0, 16);
  const readyPath = '/var/lib/csa-agent-runtime/pi-runtime-key.sha256';
  await trace(run, { component: 'runtime-install', stage: 'pi.runtime.inspect', level: 'info', message: '检查 microVM 内的 Pi SDK 与锁定版本。', details: { runtimeKey: runtimeKey.slice(0, 16), package: manifest.package, version: manifest.version } });
  try {
    const [recordedKey, nodeExists, entryExists, computerPluginExists, packageExists, typeboxExists] = await Promise.all([
      sandbox.files.read(readyPath).catch(() => ''),
      sandbox.files.exists('/opt/csa-agent-runtime/bin/node'),
      sandbox.files.exists(runtimeDirectory + '/run-task.mjs'),
      sandbox.files.exists(runtimeDirectory + '/computer-plugin.mjs'),
      sandbox.files.exists(runtimeDirectory + '/node_modules/@mariozechner/pi-coding-agent/package.json'),
      sandbox.files.exists(runtimeDirectory + '/node_modules/typebox/package.json'),
    ]);
    if (recordedKey.trim() === runtimeKey && nodeExists && entryExists && computerPluginExists && packageExists && typeboxExists) {
      await trace(run, { component: 'runtime-install', stage: 'pi.runtime.reuse', level: 'info', message: 'Pi SDK 与 runtime key 匹配，复用 microVM 中的预装依赖。', details: { runtimeKey: runtimeKey.slice(0, 16), version: manifest.version } });
      return runtimeDirectory;
    }
  } catch {
    // The first installation has no marker; continue with a fresh runtime directory.
  }

  const bundle = await prepareHostRuntimeBundle(run, runtimeKey, piBundleBuilder, 'Pi');
  await trace(run, { component: 'runtime-install', stage: 'pi.bundle.ready', level: 'info', message: 'Mac 宿主已准备好 Linux ARM64 Pi SDK 制品。', details: { runtimeKey: runtimeKey.slice(0, 16), version: manifest.version, sizeBytes: bundle.size } });
  await transitionRun(run.tenant_id, run.id, 'working', 'progress', 'Pi SDK 依赖已准备好，正在分块传入租户 microVM。');
  await stageRuntimeBundle(sandbox, bundle, async event => {
    await trace(run, {
      component: 'runtime-transfer',
      stage: 'pi.bundle.' + event.stage,
      level: event.level,
      message: event.message,
      ...(event.durationMs === undefined ? {} : { durationMs: event.durationMs }),
      ...(event.details ? { details: event.details } : {}),
    });
    if (event.stage === 'chunk.upload.progress' || event.stage === 'assembly.progress') {
      await transitionRun(run.tenant_id, run.id, 'working', 'progress', event.message);
    }
  }, 'Pi');

  const installCommand = [
    'set -eu',
    'echo pi.install.preflight.start runtime_key=' + runtimeKey.slice(0, 16),
    'test -x /opt/csa-agent-runtime/bin/node',
    'install -d -m 0755 ' + runtimeDirectory,
    'echo pi.extract.start archive_bytes=' + bundle.size + ' runtime_directory=' + runtimeDirectory,
    'timeout --kill-after=20s 1200s tar --warning=no-unknown-keyword --checkpoint=1000 --checkpoint-action=echo=pi.extract.checkpoint:block=%u -xzf /tmp/csa-dsh-runtime-linux-arm64.tar.gz -C ' + runtimeDirectory,
    'echo pi.extract.complete',
    'echo pi.install.files.verify.start',
    'test -s ' + runtimeDirectory + '/run-task.mjs',
    'test -s ' + runtimeDirectory + '/computer-plugin.mjs',
    'test -s ' + runtimeDirectory + '/node_modules/@mariozechner/pi-coding-agent/package.json',
    'test -s ' + runtimeDirectory + '/node_modules/typebox/package.json',
    'grep -Fq ' + manifest.version + ' ' + runtimeDirectory + '/node_modules/@mariozechner/pi-coding-agent/package.json',
    'echo pi.install.files.verify.passed version=' + manifest.version,
  ].join('; ');
  const installStartedAt = Date.now();
  await trace(run, { component: 'runtime-install', stage: 'pi.install.extract.start', level: 'info', message: '开始在 microVM 内解包 Pi SDK runtime；tar 每处理 10000 个数据块会输出进度。', details: { runtimeKey: runtimeKey.slice(0, 16), runtimeDirectory, archiveBytes: bundle.size, archiveSha256: bundle.archiveSha256, timeoutMs: 20 * 60_000 } });
  const installed = await runGuestPty(sandbox, installCommand, '/', {}, line => {
    const output = line.replace(/^tar:\s*/, '');
    if (/^pi\./.test(output) || output.includes('error') || output.includes('failed')) {
      const checkpoint = output.match(/^pi\.extract\.checkpoint:block=(\d+)\b/);
      void trace(run, {
        component: 'runtime-install',
        stage: checkpoint ? 'pi.install.extract.progress' : 'pi.install.output',
        level: output.includes('error') || output.includes('failed') ? 'warning' : 'info',
        message: checkpoint ? `Pi runtime 解包 tar 检查点 ${checkpoint[1]}。` : output.slice(0, 500),
        durationMs: Date.now() - installStartedAt,
        ...(checkpoint ? { details: { checkpoint: Number(checkpoint[1]) } } : {}),
      });
    }
  }, 20 * 60_000);
  if (installed.exitCode !== 0) throw new Error('Pi SDK 文件解包失败：' + installed.output.slice(-1200));
  await trace(run, { component: 'runtime-install', stage: 'pi.install.extract.complete', level: 'info', message: 'Pi SDK 文件已解包并通过版本校验。', durationMs: Date.now() - installStartedAt, details: { runtimeKey: runtimeKey.slice(0, 16), version: manifest.version, archiveBytes: bundle.size } });

  const smokeCommand = '/usr/bin/setpriv --reuid=1000 --regid="$(/usr/bin/id -g "$(/usr/bin/getent passwd 1000 | /usr/bin/cut -d: -f1)")" --init-groups /usr/bin/env CSA_PI_BUNDLE_IMPORT_SMOKE=1 HOME=/workspace/.desktop-home /opt/csa-agent-runtime/bin/node ' + runtimeDirectory + '/run-task.mjs';
  const smoke = await runGuestPty(sandbox, smokeCommand, '/', {}, line => {
    void trace(run, { component: 'pi', stage: 'sdk.import-smoke.output', level: 'info', message: line.slice(0, 500) });
  }, 10 * 60_000);
  if (smoke.exitCode !== 0 || !smoke.output.includes('pi_computer_tools_smoke_ok') || !smoke.output.includes('pi_sdk_import_smoke_ok')) {
    throw new Error('Pi SDK microVM import smoke failed：' + smoke.output.slice(-1200));
  }
  await sandbox.files.write(readyPath, runtimeKey + '\n');
  await sandbox.files.remove('/tmp/csa-dsh-runtime-linux-arm64.tar.gz').catch(() => undefined);
  await sandbox.files.remove('/tmp/csa-dsh-runtime-linux-arm64.tar.gz.sha256').catch(() => undefined);
  await trace(run, { component: 'runtime-install', stage: 'pi.install.complete', level: 'info', message: 'Pi SDK 已在 microVM 中解包并通过导入检查。', durationMs: Date.now() - installStartedAt, details: { runtimeKey: runtimeKey.slice(0, 16), version: manifest.version, archiveBytes: bundle.size } });
  return runtimeDirectory;
}

async function ensureGuestPiNodeRuntime(
  sandbox: Awaited<ReturnType<typeof connectTenantSandbox>>,
  run: PendingRun,
): Promise<void> {
  const startedAt = Date.now();
  const candidates = [
    '/opt/csa-agent-runtime/bin/node',
    '/opt/csa-agent-runtime/node_modules/node-linux-arm64/bin/node',
    '/usr/local/bin/node',
    '/usr/bin/node',
  ];
  await trace(run, { component: 'runtime-install', stage: 'pi.node.resolve.start', level: 'info', message: '为 Pi 检查 microVM 内已有的 ARM64 Node.js，并确认最低版本要求。', details: { minimumVersion: '22.19.0', candidates: candidates.join(',') } });
  const candidateList = candidates.map(path => `'${path}'`).join(' ');
  const command = [
    'set -eu',
    'node_path=',
    'node_version=',
    `for candidate in ${candidateList}; do`,
    '  if [ -x "$candidate" ]; then',
    '    candidate_version="$("$candidate" --version 2>/dev/null || true)"',
    '    if printf "%s\\n" "$candidate_version" | awk -F "[v.]" \'NF >= 4 && (($2 + 0) > 22 || (($2 + 0) == 22 && ($3 + 0) >= 19)) { found = 1 } END { exit !found }\'; then',
    '      node_path="$candidate"',
    '      node_version="$candidate_version"',
    '      break',
    '    fi',
    '  fi',
    'done',
    'if [ -z "$node_path" ]; then echo "pi_node_resolve_failed minimum=22.19.0"; exit 2; fi',
    'install -d -m 0755 /opt/csa-agent-runtime/bin',
    'if [ "$node_path" != /opt/csa-agent-runtime/bin/node ]; then',
    '  if [ -L /opt/csa-agent-runtime/bin/node ]; then rm -f /opt/csa-agent-runtime/bin/node; elif [ -e /opt/csa-agent-runtime/bin/node ]; then echo pi_node_path_occupied; exit 3; fi',
    '  ln -s "$node_path" /opt/csa-agent-runtime/bin/node',
    'fi',
    'resolved_version="$(/opt/csa-agent-runtime/bin/node --version)"',
    'printf "pi_node_ready path=/opt/csa-agent-runtime/bin/node source=%s version=%s\\n" "$node_path" "$resolved_version"',
  ].join('\n');
  const result = await runGuestPty(sandbox, command, '/', {}, undefined, 20_000);
  const match = result.output.match(/pi_node_ready path=\/opt\/csa-agent-runtime\/bin\/node source=([^\s]+) version=(v?\d+\.\d+\.\d+)/);
  if (result.exitCode !== 0 || !match) {
    const detail = result.output.trim().slice(-1_000);
    await trace(run, { component: 'runtime-install', stage: 'pi.node.resolve.failed', level: 'error', message: 'microVM 内没有可供 Pi 使用的 Node.js 22.19.0 或更高版本。', durationMs: Date.now() - startedAt, details: { exitCode: result.exitCode, outputTail: detail } });
    throw new Error('Pi requires Node.js >=22.19.0 in the tenant microVM.' + (detail ? ' ' + detail : ''));
  }
  await trace(run, { component: 'runtime-install', stage: 'pi.node.resolve.complete', level: 'info', message: '已选定并规范化 Pi 的 Node.js 启动路径。', durationMs: Date.now() - startedAt, details: { path: '/opt/csa-agent-runtime/bin/node', source: match[1], version: match[2] } });
}

function isRetryableDataPlaneError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /\b50[234]\b|Gateway Time-out|Bad Gateway|fetch failed|Headers Timeout|UND_ERR_HEADERS_TIMEOUT|ECONNRESET|ECONNREFUSED|ETIMEDOUT|EHOSTUNREACH/i.test(message);
}

async function prepareHostRuntimeBundle(
  run: PendingRun,
  expectedRuntimeKey: string,
  builderScript = hostBundleScript,
  runtimeLabel = 'DeepSeek Harness',
): Promise<HostRuntimeBundle> {
  let preparation = hostBundlePromises.get(expectedRuntimeKey);
  if (!preparation) {
    preparation = new Promise<HostRuntimeBundle>((resolveBundle, rejectBundle) => {
      const cacheRoot = process.env.CSA_AGENT_RUNTIME_CACHE_DIR || join(homedir(), '.cache/csa-cube-node/runtime-cache');
      const buildStartedAt = Date.now();
      const buildEnv: NodeJS.ProcessEnv = {
        ...process.env,
        CSA_AGENT_RUNTIME_CACHE_DIR: cacheRoot,
        CSA_NPM_HTTP_PROXY: config.agent.npmHttpProxy,
        CSA_EXPECTED_RUNTIME_KEY: expectedRuntimeKey,
      };
      delete buildEnv.DEEPSEEK_API_KEY;
      const child = spawn('bash', [builderScript], {
        env: buildEnv,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      let stdout = '';
      let stderrTail = '';
      let stderrBytesTotal = 0;
      let pendingLine = '';
      let fetchCount = 0;
      let lastPublishedAt = Date.now();
      let progressQueue = Promise.resolve();
      let buildTraceQueue = Promise.resolve();
      const queueBuildTrace = (event: Parameters<typeof trace>[1]): void => {
        buildTraceQueue = buildTraceQueue.then(() => trace(run, event)).catch(() => undefined);
      };
      const publishBuilderLine = (rawLine: string): void => {
        const line = redactRuntimeBuildOutput(rawLine).trim();
        if (!line) return;
        const stagePrefix = line.match(/^runtime_bundle_stage(_failed)?\s+(.+)$/);
        if (stagePrefix) {
          const fields = Object.fromEntries([...stagePrefix[2].matchAll(/([a-z_]+)=([^\s]+)/g)].map(match => [match[1], match[2]]));
          const stage = String(fields.stage || 'unknown');
          const details: Record<string, string | number | boolean | null> = { runtimeKey: expectedRuntimeKey.slice(0, 16) };
          for (const name of ['elapsed_seconds', 'exit_code', 'bytes', 'entries', 'sha256', 'version']) {
            const value = fields[name];
            if (value === undefined) continue;
            const number = Number(value);
            details[name] = Number.isSafeInteger(number) ? number : value.slice(0, 120);
          }
          queueBuildTrace({
            component: 'runtime-bundle-builder',
            stage: stagePrefix[1] ? 'host.build.failed' : `host.${stage}`,
            level: stagePrefix[1] ? 'error' : 'info',
            message: stagePrefix[1] ? `宿主机 runtime 构建在 ${stage} 阶段失败。` : `宿主机 runtime 构建进入 ${stage} 阶段。`,
            details,
          });
          return;
        }
        if (line.includes('Downloading the pinned official DeepSeek Harness Linux ARM64 runtime')) {
          queueBuildTrace({ component: 'runtime-wheel', stage: 'official-runtime.download.start', level: 'info', message: '开始通过 Mac HTTP 代理下载已固定 SHA-256 的官方 Linux ARM64 Harness Runtime。' });
        } else if (line.includes('Installing the version-matched TypeScript SDK')) {
          queueBuildTrace({ component: 'npm', stage: 'sdk.install.start', level: 'info', message: '开始安装与官方 Harness Runtime 同版本的 TypeScript SDK 依赖。' });
        } else if (line.startsWith('bundle_entries=')) {
          const entryCount = Number(line.slice('bundle_entries='.length));
          queueBuildTrace({ component: 'runtime-bundle', stage: 'bundle.pack.complete', level: 'info', message: '紧凑版 Linux ARM64 runtime 制品已打包。', details: { entryCount: Number.isSafeInteger(entryCount) ? entryCount : null } });
        } else if (line.startsWith('npm ci is still running through the host HTTP proxy')) {
          const elapsedSeconds = Number(line.match(/\((\d+)s elapsed/)?.[1]);
          queueBuildTrace({ component: 'npm', stage: 'sdk.install.heartbeat', level: 'info', message: 'npm ci 仍在 Mac HTTP 代理下准备 Linux ARM64 依赖。', details: { elapsedSeconds: Number.isSafeInteger(elapsedSeconds) ? elapsedSeconds : null, responseCount: fetchCount } });
        } else {
          const isBuildError = /^npm ERR!\b/i.test(line)
            || /^(?:error|fatal):/i.test(line)
            || /\b(?:build failed|installation failed|timed out|command failed)\b/i.test(line);
          const isBuildWarning = /^npm WARN\b/i.test(line)
            || /^(?:warning|retrying):/i.test(line);
          if (isBuildError || isBuildWarning) {
            queueBuildTrace({
              component: 'runtime-bundle-builder',
              stage: isBuildError ? 'host.build.output.error' : 'host.build.output.warning',
              level: isBuildError ? 'error' : 'warning',
              message: line.slice(0, 1200),
            });
          }
        }

        if (!/npm http fetch GET \d{3}\b/.test(line)) return;
        fetchCount += 1;
        if (fetchCount % 25 !== 0 || Date.now() - lastPublishedAt < 10_000) return;
        lastPublishedAt = Date.now();
        const count = fetchCount;
        progressQueue = progressQueue.then(() => transitionRun(
          run.tenant_id,
          run.id,
          'working',
          'progress',
          `正在通过 Mac HTTP 代理准备 Linux ARM64 依赖，已收到 ${count} 个 npm 响应。`,
        )).catch(error => { process.stderr.write(`Could not publish npm download progress: ${safeError(error)}\n`); });
        queueBuildTrace({ component: 'npm', stage: 'registry.download', level: 'info', message: '正在通过 Mac HTTP 代理下载锁定的 Linux ARM64 npm 依赖。', details: { responseCount: count } });
      };
      queueBuildTrace({
        component: 'runtime-bundle-builder',
        stage: 'host.build.start',
        level: 'info',
        message: '开始在 Mac 宿主准备 ' + runtimeLabel + ' 的 Linux ARM64 制品。',
        details: { runtimeKey: expectedRuntimeKey.slice(0, 16), runtimeLabel, cacheRoot, proxyConfigured: Boolean(config.agent.npmHttpProxy) },
      });
      const publishHeartbeat = (): void => {
        if (Date.now() - lastPublishedAt < 30_000) return;
        lastPublishedAt = Date.now();
        const count = fetchCount;
        progressQueue = progressQueue.then(() => transitionRun(
          run.tenant_id,
          run.id,
          'working',
          'progress',
          `runtime 依赖准备仍在运行，已收到 ${count} 个 npm registry 响应。`,
        )).catch(error => { process.stderr.write(`Could not publish npm download progress: ${safeError(error)}\n`); });
      };
      const progressTimer = setInterval(publishHeartbeat, 1_000);
      const collectStderr = (chunk: Buffer): void => {
        const value = chunk.toString();
        stderrBytesTotal += chunk.byteLength;
        stderrTail = (stderrTail + value).slice(-6000);
        pendingLine += value;
        const lines = pendingLine.split(/\r?\n/);
        pendingLine = lines.pop() || '';
        for (const line of lines) publishBuilderLine(line);
      };
      queueBuildTrace({ component: 'runtime-bundle-builder', stage: 'host.build.process.start', level: 'info', message: 'Mac 宿主 ' + runtimeLabel + ' runtime 构建子进程已启动。', details: { pid: child.pid ?? null, runtimeLabel } });
      child.stdout.on('data', (chunk: Buffer) => { stdout += chunk.toString(); });
      child.stderr.on('data', collectStderr);
      child.on('error', error => {
        clearInterval(progressTimer);
        queueBuildTrace({ component: 'runtime-bundle-builder', stage: 'host.build.process.error', level: 'error', message: `无法启动宿主机 runtime 构建子进程：${safeError(error)}`, durationMs: Date.now() - buildStartedAt });
        void buildTraceQueue.finally(() => rejectBundle(new Error(`无法启动宿主机 npm 依赖预下载：${safeError(error)}`)));
      });
      child.on('close', async (code, signal) => {
        clearInterval(progressTimer);
        if (pendingLine.trim()) publishBuilderLine(pendingLine);
        await progressQueue;
        await buildTraceQueue;
        if (code !== 0) {
          const detail = redactRuntimeBuildOutput(stderrTail.slice(-3000).trim());
          await trace(run, { component: 'runtime-bundle-builder', stage: 'host.build.process.failed', level: 'error', message: 'Mac 宿主 runtime 构建进程失败。', durationMs: Date.now() - buildStartedAt, details: { exitCode: code, signal, npmResponses: fetchCount, stdoutBytes: Buffer.byteLength(stdout), stderrBytes: stderrBytesTotal, stderrTail: detail.slice(-1800) } });
          rejectBundle(new Error('宿主机经 HTTP 代理准备 ' + runtimeLabel + ' Linux ARM64 依赖失败。' + detail.slice(-1800)));
          return;
        }
        const [archivePath, runtimeKey, archiveSha256] = stdout.trim().split('\t');
        if (!archivePath || !/^[a-f0-9]{64}$/.test(runtimeKey || '') || !/^[a-f0-9]{64}$/.test(archiveSha256 || '')) {
          await trace(run, { component: 'runtime-bundle-builder', stage: 'host.build.output.invalid', level: 'error', message: '宿主机 runtime 构建没有返回有效的制品路径、runtime key 和 SHA-256。', durationMs: Date.now() - buildStartedAt, details: { stdoutTail: redactRuntimeBuildOutput(stdout.slice(-1600)), stderrTail: redactRuntimeBuildOutput(stderrTail.slice(-1600)) } });
          rejectBundle(new Error('宿主机依赖预下载脚本未返回有效的缓存制品。'));
          return;
        }
        try {
          const archive = await stat(archivePath);
          if (!archive.isFile() || archive.size === 0) throw new Error('empty bundle');
          await trace(run, { component: 'runtime-bundle-builder', stage: 'host.build.complete', level: 'info', message: 'Mac 宿主已完成 ' + runtimeLabel + ' Linux ARM64 制品准备和 SHA-256 校验。', durationMs: Date.now() - buildStartedAt, details: { runtimeKey: runtimeKey.slice(0, 16), runtimeLabel, archiveSha256, archiveBytes: archive.size, npmResponses: fetchCount, stderrBytes: stderrBytesTotal } });
          resolveBundle({ archivePath, runtimeKey, archiveSha256, size: archive.size });
        } catch (error) {
          await trace(run, { component: 'runtime-bundle-builder', stage: 'host.build.cache.read.failed', level: 'error', message: `宿主机 runtime 缓存制品无法读取：${safeError(error)}`, durationMs: Date.now() - buildStartedAt });
          rejectBundle(new Error(`宿主机依赖缓存不可读：${safeError(error)}`));
        }
      });
    }).catch(error => {
      hostBundlePromises.delete(expectedRuntimeKey);
      throw error;
    });
    hostBundlePromises.set(expectedRuntimeKey, preparation);
  }

  const bundle = await preparation;
  if (bundle.runtimeKey !== expectedRuntimeKey) {
    hostBundlePromises.delete(expectedRuntimeKey);
    await trace(run, {
      component: 'runtime-bundle',
      stage: 'bundle.key.mismatch',
      level: 'error',
      message: '宿主机缓存 runtime 与当前锁定版本不匹配。',
      details: { expectedRuntimeKey: expectedRuntimeKey.slice(0, 16), actualRuntimeKey: bundle.runtimeKey.slice(0, 16), archivePath: bundle.archivePath },
    });
    throw new Error('宿主机预下载的 ' + runtimeLabel + ' runtime 与当前锁定版本不匹配（expected=' + expectedRuntimeKey.slice(0, 16) + ', actual=' + bundle.runtimeKey.slice(0, 16) + '）。');
  }
  return bundle;
}

function requireModelConfiguration(): { baseUrl: string; model: string } {
  const apiKey = config.agent.apiKey.trim();
  const baseUrl = config.agent.baseUrl.trim().replace(/\/$/, '');
  const model = config.agent.model.trim();
  let endpoint: URL;
  try { endpoint = new URL(baseUrl); }
  catch { throw new Error('请在仓库外环境文件中填写有效的 DEEPSEEK_BASE_URL。'); }
  const localHttp = endpoint.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(endpoint.hostname);
  if (!apiKey || /[\r\n]/.test(apiKey)) throw new Error('请在仓库外环境文件中设置 DEEPSEEK_API_KEY。');
  if (!model || model.length > 120) throw new Error('请设置已在当前 DeepSeek API 账号启用的 DSH_MODEL；Agent 不会自动切换或购买模型。');
  if ((!localHttp && endpoint.protocol !== 'https:') || endpoint.username || endpoint.password || endpoint.search || endpoint.hash || baseUrl.length > 2048) {
    throw new Error('DEEPSEEK_BASE_URL 必须是 HTTPS 地址或本机回环 HTTP 地址。');
  }
  return { baseUrl, model };
}

async function monitorGuestRun(
  sandbox: Awaited<ReturnType<typeof connectTenantSandbox>>,
  run: PendingRun,
  initial: GuestRunState | null,
  runDirectory: string,
  guestHandle: PtyHandle,
): Promise<void> {
  let lastMessage = initial?.message || '';
  let current = initial;
  let lastTraceSequence = 0;
  let lastProcessCheckAt = 0;
  let shouldDisconnect = false;
  const computerTraceStream = config.agent.runtime === 'pi' ? createComputerTraceStream(run) : undefined;
  const completion = guestHandle.wait(chunk => computerTraceStream?.write(chunk)).then(
    exitCode => ({ exitCode }),
    error => ({ error }),
  );
  try {
    while (!stopped) {
      const next = await readGuestState(sandbox, `${runDirectory}/state.json`);
      if (next) {
        current = next;
        await computerTraceStream?.flush();
        lastTraceSequence = await publishGuestTraces(run, next, lastTraceSequence);
        if (typeof next.message === 'string' && next.message && next.message !== lastMessage && !isTerminalGuestState(next.status)) {
          lastMessage = next.message;
          await transitionRun(run.tenant_id, run.id, 'working', 'progress', next.message);
        }
        if (isTerminalGuestState(next.status)) {
          await computerTraceStream?.flush();
          await persistGuestTerminalState(run, sandbox, next);
          const terminalExit = await Promise.race([
            completion,
            delay(guestTerminalExitGraceMs).then(() => null),
          ]);
          if (terminalExit === null) {
            await trace(run, {
              component: 'agent-runtime',
              stage: 'guest.process.terminal-exit.timeout',
              level: 'warning',
              message: 'guest 已写入最终任务状态，但 Agent PTY 在清理宽限期内仍未退出。',
              details: { pid: next.pid ?? null, graceMs: guestTerminalExitGraceMs },
            });
          } else if ('error' in terminalExit) {
            await trace(run, {
              component: 'agent-runtime',
              stage: 'guest.process.terminal-exit.error',
              level: 'warning',
              message: 'guest 已写入最终任务状态，Agent PTY 关闭时返回错误。',
              details: { pid: next.pid ?? null, error: safeError(terminalExit.error) },
            });
          } else {
            await trace(run, {
              component: 'agent-runtime',
              stage: 'guest.process.terminal-exit.complete',
              level: 'info',
              message: 'guest Agent PTY 已在最终任务状态后正常退出。',
              details: { pid: next.pid ?? null, exitCode: terminalExit.exitCode },
            });
          }
          await computerTraceStream?.flush();
          shouldDisconnect = true;
          return;
        }
      }

      const processOutcome = await Promise.race([completion, delay(10).then(() => null)]);
      if (processOutcome !== null) {
        await computerTraceStream?.flush();
        const exitDetail = processOutcome && 'error' in processOutcome
          ? safeError(processOutcome.error)
          : `exit ${processOutcome && 'exitCode' in processOutcome ? processOutcome.exitCode : 'unknown'}`;
        const guestOutputTail = await readGuestProcessOutput(sandbox, runDirectory);
        if (guestOutputTail) {
          await trace(run, {
            component: 'guest-runtime',
            stage: 'guest.process.output',
            level: processOutcome && 'exitCode' in processOutcome && processOutcome.exitCode === 0 ? 'warning' : 'error',
            message: 'microVM Agent stdout/stderr 尾部：\n' + guestOutputTail,
            details: { capturedBytes: Buffer.byteLength(guestOutputTail) },
          });
        }
        await trace(run, { component: 'agent-runtime', stage: 'guest.process.exit', level: 'warning', message: 'Agent 子进程已退出，正在读取 guest 最终状态。', details: { result: exitDetail } });
        const stateDeadline = Date.now() + 8_000;
        while (Date.now() < stateDeadline) {
          const finalState = await readGuestState(sandbox, `${runDirectory}/state.json`);
          if (finalState) {
            lastTraceSequence = await publishGuestTraces(run, finalState, lastTraceSequence);
            if (isTerminalGuestState(finalState.status)) {
              await persistGuestTerminalState(run, sandbox, finalState);
              return;
            }
          }
          await delay(500);
        }
        await trace(run, { component: 'agent-runtime', stage: 'guest.state.missing', level: 'error', message: 'Agent 子进程退出后，8 秒内没有读到 guest 的最终状态文件。', details: { result: exitDetail } });
        const outputContext = guestOutputTail ? '\n\nGuest stdout/stderr 尾部：\n' + guestOutputTail.slice(-1800) : '';
        await transitionRun(run.tenant_id, run.id, 'failed', 'failed', `microVM 中的 Agent 进程已退出，但 guest 没有写出可读取的最终状态（${exitDetail}）；为避免重复操作，任务没有自动重放。${outputContext}`);
        shouldDisconnect = true;
        return;
      }
      if (current?.status === 'working' && Number.isSafeInteger(current.pid) && Date.now() - lastProcessCheckAt >= 15_000) {
        lastProcessCheckAt = Date.now();
        if (!await guestProcessIsAlive(sandbox, current.pid!, run.id)) {
          await trace(run, { component: 'agent-runtime', stage: 'guest.process.missing', level: 'warning', message: 'guest 状态仍为 working，但记录的 Agent 进程 PID 已不存在；检查最终状态文件。', details: { pid: current.pid! } });
          const finalState = await readGuestState(sandbox, `${runDirectory}/state.json`);
          if (finalState && isTerminalGuestState(finalState.status)) {
            lastTraceSequence = await publishGuestTraces(run, finalState, lastTraceSequence);
            await persistGuestTerminalState(run, sandbox, finalState);
            return;
          }
          await transitionRun(run.tenant_id, run.id, 'failed', 'failed', 'microVM 中的 Agent 进程已退出且没有可读取的最终状态；为避免重复操作，任务没有自动重放。');
          shouldDisconnect = true;
          return;
        }
      }
      await delay(1200);
    }
  } finally {
    if (shouldDisconnect) guestHandle.disconnect();
  }
}

function createComputerTraceStream(run: PendingRun): { write(chunk: Uint8Array): void; flush(): Promise<void> } {
  const decoder = new TextDecoder('utf-8');
  let pending = '';
  let queued = Promise.resolve();
  let eventCount = 0;
  let truncated = false;
  const publishLine = (rawLine: string): void => {
    const line = rawLine.replace(/\u001b\[[0-9;?]*[ -/]*[@-~]/g, '').replace(/\r$/, '').trim();
    if (!line) return;
    let event: Record<string, unknown>;
    try { event = JSON.parse(line) as Record<string, unknown>; }
    catch { return; }
    if (event.logger !== 'coke-super-agent.computer-tool'
      || event.component !== 'computer-tool'
      || typeof event.stage !== 'string'
      || !/^[a-z0-9._-]{1,100}$/i.test(event.stage)) return;
    if (eventCount >= 500) {
      if (!truncated) {
        truncated = true;
        queued = queued.then(() => trace(run, {
          component: 'computer-tool',
          stage: 'trace.limit.reached',
          level: 'warning',
          message: 'Computer Use 内部轨迹达到每任务 500 条上限；后续事件仍保留在 guest 日志。',
          details: { maxEvents: 500 },
        })).catch(() => undefined);
      }
      return;
    }
    eventCount += 1;
    const details = event.details && typeof event.details === 'object' && !Array.isArray(event.details)
      ? { ...(event.details as Record<string, unknown>) }
      : {};
    if (typeof event.timestamp === 'string') details.sourceTimestamp = event.timestamp.slice(0, 40);
    const level = event.level === 'error' || event.level === 'warning' ? event.level : 'info';
    queued = queued.then(() => trace(run, {
      component: 'computer-tool',
      stage: event.stage as string,
      level,
      message: 'Computer Use internal stage.',
      details: details as Record<string, string | number | boolean | null>,
    })).catch(() => undefined);
  };
  return {
    write(chunk) {
      pending += decoder.decode(chunk, { stream: true });
      let newline: number;
      while ((newline = pending.indexOf('\n')) >= 0) {
        const line = pending.slice(0, newline);
        pending = pending.slice(newline + 1);
        publishLine(line);
      }
      if (pending.length > 32_768) pending = pending.slice(-4_096);
    },
    flush() {
      return queued;
    },
  };
}

async function readGuestProcessOutput(
  sandbox: Awaited<ReturnType<typeof connectTenantSandbox>>,
  runDirectory: string,
): Promise<string> {
  try {
    const path = runDirectory + '/stdout.log';
    const result = await sandbox.commands.run(`/usr/bin/tail -c 8192 -- '${path}' 2>/dev/null || true`, { timeoutMs: 10_000 });
    return result.stdout.replace(/\u0000/g, '').trim().slice(-2400);
  } catch {
    return '';
  }
}

async function publishGuestTraces(run: PendingRun, state: GuestRunState, lastSequence: number): Promise<number> {
  let latestSequence = lastSequence;
  for (const value of Array.isArray(state.traces) ? state.traces : []) {
    if (!value || typeof value !== 'object') continue;
    const entry = value as RunTraceEvent & { sequence: number };
    if (!Number.isSafeInteger(entry.sequence) || entry.sequence <= latestSequence) continue;
    const { sequence: _sequence, ...event } = entry;
    await trace(run, event);
    latestSequence = entry.sequence;
  }
  return latestSequence;
}

async function readGuestState(sandbox: Awaited<ReturnType<typeof connectTenantSandbox>>, file: string): Promise<GuestRunState | null> {
  try {
    if (!await sandbox.files.exists(file)) return null;
    const value: unknown = JSON.parse(await sandbox.files.read(file));
    return value && typeof value === 'object' ? value as GuestRunState : null;
  } catch { return null; }
}

async function persistGuestTerminalState(
  run: PendingRun,
  sandbox: Awaited<ReturnType<typeof connectTenantSandbox>>,
  state: GuestRunState,
): Promise<void> {
  if (state.status === 'failed') {
    if (config.agent.runtime === 'dsh') {
      await traceDshSessionFailure(run, sandbox);
    } else {
      await trace(run, {
        component: 'pi',
        stage: 'session.diagnostic.skipped',
        level: 'info',
        message: 'Pi 任务失败；跳过读取 DSH 专属 session 路径。',
        details: { runtime: config.agent.runtime, sessionId: run.thread_id },
      });
    }
  }
  await persistGuestState(run.tenant_id, run.id, state);
}

async function traceDshSessionFailure(
  run: PendingRun,
  sandbox: Awaited<ReturnType<typeof connectTenantSandbox>>,
): Promise<void> {
  const sessionDirectory = `/workspace/.csa-super-agent/dsh-home/sessions/--workspace-tasks-${run.thread_id}--/${run.thread_id}`;
  try {
    const entries = await sandbox.files.list(sessionDirectory);
    const files = entries
      .map(entry => typeof entry?.name === 'string' ? entry.name : typeof entry?.path === 'string' ? entry.path : '')
      .filter(name => /^session(?:\.v\d+)?\.jsonl$/.test(name))
      .sort((left, right) => sessionLogVersion(right) - sessionLogVersion(left));
    const sessionFile = files[0];
    if (!sessionFile) {
      await trace(run, { component: 'dsh', stage: 'harness.session.diagnostic.missing', level: 'warning', message: '任务失败后没有找到可读的 DSH session JSONL。', details: { sessionId: run.thread_id } });
      return;
    }

    const filePath = `${sessionDirectory}/${sessionFile}`;
    const fileInfo = await sandbox.files.stat(filePath);
    const fileBytes = Number(fileInfo.size);
    if (Number.isFinite(fileBytes) && fileBytes > 8 * 1024 * 1024) {
      await trace(run, { component: 'dsh', stage: 'harness.session.diagnostic.skipped', level: 'warning', message: 'DSH session JSONL 超过诊断读取上限，未读取文件内容。', details: { sessionFile, fileBytes, maxBytes: 8 * 1024 * 1024 } });
      return;
    }

    const contents = await sandbox.files.read(filePath);
    const lines = contents.split('\n').filter(Boolean).slice(-400);
    const events: Array<Record<string, unknown>> = [];
    let failedTurnIndex = -1;
    let failedReason: Record<string, unknown> | null = null;
    for (const line of lines) {
      try {
        const event: unknown = JSON.parse(line);
        if (!event || typeof event !== 'object') continue;
        const value = event as Record<string, unknown>;
        events.push(value);
        if (value.type !== 'turn/end') continue;
        const data = value.data && typeof value.data === 'object' ? value.data as Record<string, unknown> : {};
        const reason = data.reason && typeof data.reason === 'object' ? data.reason as Record<string, unknown> : {};
        if (reason.kind === 'error' || reason.kind === 'failed' || reason.kind === 'timeout') {
          failedTurnIndex = events.length - 1;
          failedReason = reason;
        }
      } catch { /* Ignore a partial or malformed final JSONL line. */ }
    }

    if (failedTurnIndex < 0 || !failedReason) {
      await trace(run, { component: 'dsh', stage: 'harness.session.diagnostic.unresolved', level: 'warning', message: 'DSH session JSONL 中没有找到带错误原因的 turn/end。', details: { sessionFile, sessionBytes: Buffer.byteLength(contents) } });
      return;
    }

    const event = events[failedTurnIndex];
    const reason = failedReason;
    const error = reason.error && typeof reason.error === 'object' ? reason.error as Record<string, unknown> : {};
    const errorMessage = typeof error.message === 'string' ? redactRuntimeBuildOutput(error.message).slice(0, 500) : '';
    const requestId = errorMessage.match(/request[_ -]?id\s*[:=]\s*([a-z0-9-]{12,80})/i)?.[1];
    const status = Number(error.status ?? error.statusCode ?? error.httpStatus);
    let turnStartIndex = -1;
    for (let index = 0; index < failedTurnIndex; index += 1) {
      if (events[index].type === 'turn/start') turnStartIndex = index;
    }
    const timeline = new Map<string, Record<string, unknown>>();
    const timelineTypes = new Set(['turn/start', 'step/start', 'request/header', 'assistant/attempt', 'step/end', 'turn/end']);
    for (let index = Math.max(0, turnStartIndex); index <= failedTurnIndex; index += 1) {
      const candidate = events[index];
      if (typeof candidate.type === 'string' && timelineTypes.has(candidate.type)) timeline.set(candidate.type, candidate);
    }
    const eventMillis = (type: string): number => valueNumber(timeline.get(type)?.time);
    const details: Record<string, string | number | boolean | null> = {
      sessionId: run.thread_id,
      sessionFile,
      sessionEventType: 'turn/end',
      sessionEventSequence: Number.isSafeInteger(valueNumber(event.seq)) ? valueNumber(event.seq) : null,
      sessionReasonKind: String(reason.kind).slice(0, 40),
    };
    for (const [field, type] of [
      ['turnStartedAt', 'turn/start'],
      ['stepStartedAt', 'step/start'],
      ['providerRequestAt', 'request/header'],
      ['assistantAttemptAt', 'assistant/attempt'],
      ['turnEndedAt', 'turn/end'],
    ] as const) {
      const millis = eventMillis(type);
      if (Number.isFinite(millis) && millis > 0) details[field] = new Date(millis).toISOString();
    }
    for (const [field, startType, endType] of [
      ['turnToStepMs', 'turn/start', 'step/start'],
      ['stepToProviderRequestMs', 'step/start', 'request/header'],
      ['providerRequestToAttemptMs', 'request/header', 'assistant/attempt'],
      ['attemptToTurnEndMs', 'assistant/attempt', 'turn/end'],
    ] as const) {
      const start = eventMillis(startType);
      const end = eventMillis(endType);
      if (Number.isFinite(start) && Number.isFinite(end) && end >= start) details[field] = end - start;
    }
    if (typeof error.code === 'string' || typeof error.code === 'number') details.errorCode = String(error.code).slice(0, 100);
    if (Number.isSafeInteger(status) && status > 0) details.httpStatus = status;
    if (requestId) details.requestId = requestId;
    if (errorMessage) details.errorMessage = errorMessage;
    await trace(run, {
      component: 'dsh',
      stage: 'harness.session.failure',
      level: 'error',
      message: `DSH session turn/end 报告 ${String(reason.kind).slice(0, 40)}。${error.code ? ` ${String(error.code).slice(0, 100)}.` : ''}${status ? ` HTTP ${status}.` : ''}${errorMessage ? ` ${errorMessage}` : ''}`.slice(0, 1200),
      details,
    });
  } catch (error) {
    const value = error instanceof Error ? error : new Error(String(error));
    await trace(run, { component: 'dsh', stage: 'harness.session.diagnostic.failed', level: 'warning', message: '读取 DSH session JSONL 诊断时失败。', details: { errorName: value.name || 'Error', errorMessage: redactRuntimeBuildOutput(value.message).slice(0, 300) } });
  }
}

function sessionLogVersion(name: string): number {
  return Number(name.match(/^session\.v(\d+)\.jsonl$/)?.[1] || 0);
}

function valueNumber(value: unknown): number {
  return typeof value === 'number' ? value : Number.NaN;
}

async function guestProcessIsAlive(sandbox: Awaited<ReturnType<typeof connectTenantSandbox>>, pid: number, runId: string): Promise<boolean> {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  const cmdline = await sandbox.files.read(`/proc/${pid}/cmdline`).catch(() => '');
  return isGuestAgentProcessCommandLine(cmdline, runId);
}

function isTerminalGuestState(status: GuestRunState['status']): boolean {
  return status === 'waiting_for_user' || status === 'done' || status === 'failed';
}

async function persistGuestState(tenantId: string, runId: string, state: GuestRunState): Promise<void> {
  const message = typeof state.message === 'string' && state.message.trim() ? state.message : 'Agent 任务结束。';
  const mapping: Record<string, { status: RunStatus; eventType: string }> = {
    waiting_for_user: { status: 'waiting_for_user', eventType: 'waiting_for_user' },
    done: { status: 'done', eventType: 'completed' },
    failed: { status: 'failed', eventType: 'failed' },
  };
  const result = mapping[String(state.status)];
  if (!result) throw new Error('Guest Agent Runtime returned an unknown terminal state.');
  const level = state.status === 'failed' ? 'error' : 'info';
  await appendRunTrace(tenantId, runId, {
    component: state.status === 'failed' ? 'dsh' : 'agent-runtime',
    stage: state.stage || `run.${state.status}`,
    level,
    message,
    ...(state.errorName ? { details: { errorName: state.errorName } } : {}),
  });
  await transitionRun(tenantId, runId, result.status, result.eventType, message);
}

async function trace(run: PendingRun, event: RunTraceEvent): Promise<void> {
  try { await appendRunTrace(run.tenant_id, run.id, event); }
  catch (error) {
    const safeEvent = sanitizeRunTrace(event);
    const safeFailure = sanitizeRunTrace({ component: 'trace-store', stage: 'event.persist.failed', level: 'error', message: safeError(error), details: runtimeErrorDetails(error) });
    process.stderr.write(JSON.stringify({
      timestamp: new Date().toISOString(),
      logger: 'coke-super-agent.run',
      tenantId: run.tenant_id,
      runId: run.id,
      sequence: null,
      persisted: false,
      ...safeEvent,
      persistenceError: safeFailure.message,
      persistenceErrorDetails: safeFailure.details,
    }) + '\n');
  }
}

function safeError(error: unknown): string {
  let value = error instanceof Error ? error.message : String(error);
  if (error instanceof Error && error.cause instanceof Error) {
    const code = (error.cause as NodeJS.ErrnoException).code;
    if (code) value += ` (${code})`;
  }
  return redactRuntimeBuildOutput(value).slice(0, 1200);
}

function runtimeErrorDetails(error: unknown): Record<string, string> {
  const value = error instanceof Error ? error : new Error(String(error));
  const details: Record<string, string> = { errorName: value.name || 'Error', errorMessage: value.message };
  if (value.stack) details.errorStack = value.stack;
  if (value.cause instanceof Error) {
    details.errorCause = value.cause.message;
    if (value.cause.stack) details.errorCauseStack = value.cause.stack;
  }
  for (const key of Object.keys(details)) details[key] = redactRuntimeBuildOutput(details[key]);
  return details;
}

function redactRuntimeBuildOutput(value: string): string {
  return [config.agent.apiKey, config.cube.apiKey].filter(Boolean)
    .reduce((result, secret) => result.split(secret).join('[redacted]'), value)
    .replace(/(?:https?:\/\/)[^\s/@]+:[^\s/@]+@/gi, 'https://[redacted]@')
    .replace(/\b(Bearer|Basic)\s+[^\s"'`]+/gi, '$1 [redacted]')
    .replace(/\bsk-[A-Za-z0-9_-]{8,}\b/g, '[redacted-api-key]')
    .replace(/((?:api[_-]?key|token|password|secret|authorization)\s*[:=]\s*)[^\s,;]+/gi, '$1[redacted]')
    .replace(/([?&](?:api[_-]?key|token|password|secret)=)[^&\s]+/gi, '$1[redacted]');
}

function delay(milliseconds: number): Promise<void> {
  return new Promise(resolveDelay => setTimeout(resolveDelay, milliseconds));
}
