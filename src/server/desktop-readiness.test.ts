import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { ComputerView } from '../shared/types.ts';
import { DesktopReadinessError, waitForTenantDesktopReady } from './desktop-readiness.ts';

const computer = (state: ComputerView['state'], desktopState: ComputerView['desktopState']): ComputerView => ({
  state,
  desktopState,
  updatedAt: new Date(0).toISOString(),
});

test('waits until both the tenant VM and desktop are ready', async () => {
  const states = [computer('running', 'installing'), computer('running', 'ready')];
  let reads = 0;
  const result = await waitForTenantDesktopReady(async () => {
    reads += 1;
    return states.shift() || computer('running', 'ready');
  }, { timeoutMs: 1_000, sleep: async () => undefined });

  assert.equal(result?.state, 'running');
  assert.equal(result?.desktopState, 'ready');
  assert.equal(reads, 2);
});

test('fails immediately when the desktop bootstrap has failed', async () => {
  await assert.rejects(
    waitForTenantDesktopReady(async () => computer('running', 'failed'), { timeoutMs: 60_000 }),
    (error: unknown) => error instanceof DesktopReadinessError && /桌面启动失败/.test(error.message),
  );
});

test('does not start a task after the desktop readiness deadline', async () => {
  await assert.rejects(
    waitForTenantDesktopReady(async () => computer('running', 'installing'), { timeoutMs: 0 }),
    (error: unknown) => error instanceof DesktopReadinessError && /任务未启动/.test(error.message),
  );
});

test('returns when the runtime is cancelled before polling again', async () => {
  let cancelled = false;
  const result = await waitForTenantDesktopReady(async () => {
    cancelled = true;
    return computer('running', 'installing');
  }, { timeoutMs: 60_000, isCancelled: () => cancelled });

  assert.equal(result, null);
});
