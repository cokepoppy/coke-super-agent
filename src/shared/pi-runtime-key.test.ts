import assert from 'node:assert/strict';
import test from 'node:test';
import { createPiRuntimeKey } from './pi-runtime-key.ts';

const input = {
  packageJson: '{"name":"pi"}',
  packageLock: 'locked-dependencies',
  runtimeManifest: '{"version":"0.73.1"}',
  bundleBuilder: 'builder-v1',
  runtimeSource: 'runner-v1',
  computerPlugin: 'computer-v1',
};

test('Pi runtime key is stable and includes the shared computer plugin', () => {
  const first = createPiRuntimeKey(input);
  assert.match(first, /^[a-f0-9]{64}$/);
  assert.equal(createPiRuntimeKey(input), first);
  assert.notEqual(createPiRuntimeKey({ ...input, computerPlugin: 'computer-v2' }), first);
});
