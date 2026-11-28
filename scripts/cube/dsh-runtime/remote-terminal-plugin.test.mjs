import assert from 'node:assert/strict';
import { test } from 'node:test';
import { apply } from './remote-terminal-plugin.mjs';

test('raises short model-selected terminal deadlines to the streaming-safe minimum', async () => {
  const previousUrl = process.env.COKE_CUBE_TERMINAL_BRIDGE_URL;
  const previousToken = process.env.COKE_CUBE_TERMINAL_BRIDGE_TOKEN;
  const previousFetch = globalThis.fetch;
  process.env.COKE_CUBE_TERMINAL_BRIDGE_URL = 'http://host.docker.internal:8080/api/internal/agent/terminal';
  process.env.COKE_CUBE_TERMINAL_BRIDGE_TOKEN = 'test-bridge-token-0123456789-abcdefghijklmnopqrstuvwxyz';

  let registered;
  let requestBody;
  const context = { tools: { register(tool) { registered = tool; } } };
  globalThis.fetch = async (_url, options) => {
    requestBody = JSON.parse(options.body);
    return new Response(JSON.stringify({ exitCode: 0, durationMs: 25, stdout: 'ok\n', stderr: '', outputTruncated: false }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  };

  try {
    apply(context);
    assert.equal(registered.parameters.properties.timeoutMs.minimum, 60_000);
    const result = await registered.execute(
      { command: 'printf ok', cwd: '/workspace/tasks/run', timeoutMs: 10_000 },
      { signal: new AbortController().signal },
    );
    assert.equal(requestBody.timeoutMs, 60_000);
    assert.match(result.text, /"executionLocation":"tenant-cube-microvm"/);
  } finally {
    globalThis.fetch = previousFetch;
    if (previousUrl === undefined) delete process.env.COKE_CUBE_TERMINAL_BRIDGE_URL;
    else process.env.COKE_CUBE_TERMINAL_BRIDGE_URL = previousUrl;
    if (previousToken === undefined) delete process.env.COKE_CUBE_TERMINAL_BRIDGE_TOKEN;
    else process.env.COKE_CUBE_TERMINAL_BRIDGE_TOKEN = previousToken;
  }
});
