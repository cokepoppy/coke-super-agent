import assert from 'node:assert/strict';
import { test } from 'node:test';
import { classifyGuestRunRecovery } from './guest-run-recovery.ts';

test('launches only when neither guest state nor a prior launcher marker exists', () => {
  assert.equal(classifyGuestRunRecovery(null, false), 'launch');
  assert.equal(classifyGuestRunRecovery(null, true), 'fail-closed');
});

test('reattaches to a guest process recorded as working', () => {
  assert.equal(classifyGuestRunRecovery({ status: 'working' }, true), 'resume');
  assert.equal(classifyGuestRunRecovery({ status: 'working' }, false), 'resume');
});

test('persists already terminal guest state without relaunching', () => {
  for (const status of ['done', 'failed', 'waiting_for_user']) {
    assert.equal(classifyGuestRunRecovery({ status }, false), 'persist-terminal');
    assert.equal(classifyGuestRunRecovery({ status }, true), 'persist-terminal');
  }
});

test('fails closed on unknown persisted states rather than replaying a task', () => {
  assert.equal(classifyGuestRunRecovery({ status: 'starting' }, false), 'fail-closed');
  assert.equal(classifyGuestRunRecovery({ status: 'corrupt' }, true), 'fail-closed');
});
