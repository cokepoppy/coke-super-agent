import test from 'node:test';
import assert from 'node:assert/strict';
import { sanitizeRunTrace } from './task-store.ts';

test('run trace redacts namespaced artifact tokens embedded in JSON text', () => {
  const safe = sanitizeRunTrace({
    component: 'cube',
    stage: 'sandbox.create',
    level: 'error',
    message: 'Cube request failed.',
    details: {
      errorMessage: '{"cube.master.rootfs.artifact.token":"artifact-secret-value","safe":"visible"}',
      'cube.master.rootfs.artifact.token': 'structured-secret-value',
    },
  });

  assert.doesNotMatch(String(safe.details?.errorMessage), /artifact-secret-value|structured-secret-value/);
  assert.match(String(safe.details?.errorMessage), /\[redacted\]/);
  assert.equal(safe.details?.['cube.master.rootfs.artifact.token'], undefined);
});

test('run trace redacts tokens in URL query parameters', () => {
  const safe = sanitizeRunTrace({
    component: 'cube',
    stage: 'sandbox.create',
    level: 'error',
    message: 'Artifact request failed.',
    details: { errorMessage: 'GET /artifact?artifact_id=abc&token=query-secret-value failed' },
  });

  assert.doesNotMatch(String(safe.details?.errorMessage), /query-secret-value/);
  assert.match(String(safe.details?.errorMessage), /token=\[redacted\]/);
});
