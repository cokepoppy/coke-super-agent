import assert from 'node:assert/strict';
import test from 'node:test';
import { probeCubeApi } from './cube-health.ts';

test('Cube API probe skips when no endpoint is configured', async t => {
  const originalFetch = globalThis.fetch;
  let called = false;
  globalThis.fetch = (async () => { called = true; return new Response(null, { status: 200 }); }) as typeof fetch;
  t.after(() => { globalThis.fetch = originalFetch; });

  assert.deepEqual(await probeCubeApi(''), { checked: false, reachable: null, httpStatus: null, durationMs: 0 });
  assert.equal(called, false);
});

test('Cube API probe records a successful health response', async t => {
  const originalFetch = globalThis.fetch;
  let requestedUrl = '';
  globalThis.fetch = (async input => {
    requestedUrl = String(input);
    return new Response('{"status":"ok"}', { status: 200 });
  }) as typeof fetch;
  t.after(() => { globalThis.fetch = originalFetch; });

  const result = await probeCubeApi('http://127.0.0.1:13000');
  assert.equal(result.checked, true);
  assert.equal(result.reachable, true);
  assert.equal(result.httpStatus, 200);
  assert.equal(requestedUrl, 'http://127.0.0.1:13000/health');
});

test('Cube API probe reports HTTP errors as unreachable', async t => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => new Response(null, { status: 503 })) as typeof fetch;
  t.after(() => { globalThis.fetch = originalFetch; });

  const result = await probeCubeApi('http://127.0.0.1:13000');
  assert.equal(result.reachable, false);
  assert.equal(result.httpStatus, 503);
  assert.equal(result.errorCode, undefined);
});

test('Cube API probe preserves safe network error codes and bounds hung requests', async t => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => { throw new TypeError('fetch failed', { cause: { code: 'ECONNREFUSED' } }); }) as typeof fetch;
  t.after(() => { globalThis.fetch = originalFetch; });

  const refused = await probeCubeApi('http://127.0.0.1:13000');
  assert.equal(refused.errorName, 'TypeError');
  assert.equal(refused.errorCode, 'ECONNREFUSED');

  globalThis.fetch = (async (_input, init) => new Promise<Response>((_resolve, reject) => {
    init?.signal?.addEventListener('abort', () => {
      const error = new Error('aborted');
      error.name = 'AbortError';
      reject(error);
    }, { once: true });
  })) as typeof fetch;
  const timedOut = await probeCubeApi('http://127.0.0.1:13000', 5);
  assert.equal(timedOut.reachable, false);
  assert.equal(timedOut.errorName, 'AbortError');
});
