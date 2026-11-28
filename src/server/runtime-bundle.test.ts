import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Sandbox } from '@cubesandbox/sdk';
import { runGuestPty } from './runtime-bundle.ts';

test('runs a guest command in a streaming PTY and bounds captured output', async () => {
  const sent: string[] = [];
  let createOptions: unknown;
  const handle = {
    pid: 123,
    exitCode: null as number | null,
    async sendStdin(value: string | Uint8Array) { sent.push(String(value)); },
    async wait(onData?: (chunk: Uint8Array) => void) {
      onData?.(Buffer.from('ready\n'));
      onData?.(Buffer.alloc(64, 0x61));
      return 0;
    },
    disconnect() {},
  };
  const sandbox = {
    pty: {
      async create(_size: unknown, options: unknown) {
        createOptions = options;
        return handle;
      },
      async kill() { return true; },
    },
  } as unknown as Sandbox;

  const result = await runGuestPty(sandbox, 'printf ready', '/workspace/tasks/run', {}, undefined, 60_000, 16);

  assert.deepEqual(createOptions, { cwd: '/workspace/tasks/run', envs: {}, timeoutMs: 0 });
  assert.match(sent[0] || '', /^stty -echo/);
  assert.match(sent[1] || '', /^exec bash -c /);
  assert.equal(result.exitCode, 0);
  assert.equal(result.output, 'ready\n' + 'a'.repeat(10));
  assert.equal(result.outputBytes, 70);
  assert.equal(result.outputTruncated, true);
});

test('returns a nonzero guest exit code and preserves PTY output', async () => {
  const stages: string[] = [];
  const handle = {
    pid: 456,
    exitCode: 2,
    async sendStdin() {},
    async wait(onData?: (chunk: Uint8Array) => void) {
      onData?.(Buffer.from('syntax error\n'));
      throw new Error('PTY exited with error: exit status 2');
    },
    disconnect() {},
  };
  const sandbox = {
    pty: { async create() { return handle; } },
  } as unknown as Sandbox;

  const result = await runGuestPty(sandbox, 'false', '/workspace', {}, undefined, 60_000, 1024, event => stages.push(event.stage));

  assert.equal(result.exitCode, 2);
  assert.equal(result.output, 'syntax error\n');
  assert.ok(stages.includes('pty.wait.exit-status-reported-as-error'));
  assert.ok(stages.includes('pty.wait.complete'));
});

test('bounds timeout cleanup with the PTY kill request deadline', async () => {
  let killTimeoutMs = 0;
  let disconnected = false;
  const handle = {
    pid: 789,
    exitCode: null,
    async sendStdin() {},
    async wait() { return await new Promise<number>(() => {}); },
    disconnect() { disconnected = true; },
  };
  const sandbox = {
    pty: {
      async create() { return handle; },
      async kill(_pid: number, timeoutMs: number) { killTimeoutMs = timeoutMs; return true; },
    },
  } as unknown as Sandbox;

  await assert.rejects(
    runGuestPty(sandbox, 'sleep 1', '/workspace', {}, undefined, 5, 1024),
    /exceeded its 5ms command limit/,
  );
  assert.equal(killTimeoutMs, 10_000);
  assert.equal(disconnected, true);
});
