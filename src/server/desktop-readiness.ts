import type { ComputerView } from '../shared/types.ts';

export class DesktopReadinessError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DesktopReadinessError';
  }
}

export interface DesktopReadinessOptions {
  timeoutMs: number;
  pollIntervalMs?: number;
  isCancelled?: () => boolean;
  onPending?: (computer: ComputerView, elapsedMs: number) => void | Promise<void>;
  sleep?: (durationMs: number) => Promise<void>;
}

export async function waitForTenantDesktopReady(
  readCurrent: () => Promise<ComputerView>,
  options: DesktopReadinessOptions,
): Promise<ComputerView | null> {
  const startedAt = Date.now();
  const timeoutMs = Math.max(0, options.timeoutMs);
  const pollIntervalMs = Math.max(1, options.pollIntervalMs ?? 2_000);
  const sleep = options.sleep ?? (durationMs => new Promise<void>(resolve => setTimeout(resolve, durationMs)));
  let lastState = '';
  let lastNoticeAt = -30_000;

  for (;;) {
    if (options.isCancelled?.()) return null;
    const computer = await readCurrent();
    if (options.isCancelled?.()) return null;

    if (computer.state === 'failed') {
      throw new DesktopReadinessError('租户 Linux microVM 状态失败，云电脑未就绪。');
    }
    if (computer.state === 'paused') {
      throw new DesktopReadinessError('租户 Linux microVM 已暂停，无法启动 Agent 任务。');
    }
    if (computer.state === 'running' && computer.desktopState === 'ready') return computer;
    if (computer.desktopState === 'failed') {
      throw new DesktopReadinessError('租户 Linux 桌面启动失败；请检查云电脑调试日志后重试。');
    }

    const elapsedMs = Date.now() - startedAt;
    if (elapsedMs >= timeoutMs) {
      throw new DesktopReadinessError(`等待租户 Linux 桌面就绪超过 ${Math.ceil(timeoutMs / 60_000)} 分钟；任务未启动。`);
    }

    const currentState = `${computer.state}:${computer.desktopState}`;
    if (currentState !== lastState || elapsedMs - lastNoticeAt >= 30_000) {
      await options.onPending?.(computer, elapsedMs);
      lastState = currentState;
      lastNoticeAt = elapsedMs;
    }
    await sleep(Math.min(pollIntervalMs, timeoutMs - elapsedMs));
  }
}
