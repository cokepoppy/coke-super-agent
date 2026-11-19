import test from 'node:test';
import assert from 'node:assert/strict';
import { hashPassword, verifyPassword } from './password.ts';

test('password hashes use a unique salt and verify only the original password', async () => {
  const first = await hashPassword('this-is-a-local-test-password');
  const second = await hashPassword('this-is-a-local-test-password');
  assert.notEqual(first, second);
  assert.equal(await verifyPassword('this-is-a-local-test-password', first), true);
  assert.equal(await verifyPassword('a-different-password', first), false);
  assert.equal(await verifyPassword('this-is-a-local-test-password', 'plain-text-password'), false);
});

test('password hashing rejects values outside the configured length range', async () => {
  await assert.rejects(hashPassword('short'));
  await assert.rejects(hashPassword('x'.repeat(257)));
});
