import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Sandbox } from '@cubesandbox/sdk';
import { runGuestPty } from './runtime-bundle.ts';

test('runs a guest command in a streaming PTY and bounds captured output', async () => {
  const sent: string[] = [];
  let createOptions: unknown;
  const handle = {
    async sendStdin(value: string | Uint8Array) { sent.push(String(value)); },
    async wait(onData?: (chunk: Uint8Array) => void) {
      onData?.(Buffer.from('ready\n'));
      onData?.(Buffer.alloc(64, 0x61));
      return 0;
    },
    disconnect() {},
    async kill() { return true; },
  };
  const sandbox = {
    pty: {
      async create(_size: unknown, options: unknown) {
        createOptions = options;
        return handle;
      },
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
