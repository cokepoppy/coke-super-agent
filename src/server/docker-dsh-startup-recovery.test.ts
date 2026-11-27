import assert from 'node:assert/strict';
import { test } from 'node:test';
import { waitForDockerDshStartupEvidence } from './docker-dsh-startup-recovery.ts';

test('startup reconciliation adopts persisted state and still checks its process', async () => {
  const state = { status: 'working' };
  let processChecks = 0;
  const result = await waitForDockerDshStartupEvidence({
    readState: async () => state,
    processExists: async () => { processChecks += 1; return true; },
    assertLease: async () => undefined,
    delay: async () => undefined,
    timeoutMs: 0,
  });
  assert.deepEqual(result, { state, processExists: true });
  assert.equal(processChecks, 1);
});

test('startup reconciliation resumes a live task before its state file is written', async () => {
  let stateReads = 0;
  const result = await waitForDockerDshStartupEvidence({
    readState: async () => { stateReads += 1; return null; },
    processExists: async () => true,
    assertLease: async () => undefined,
    delay: async () => undefined,
    timeoutMs: 0,
  });
  assert.deepEqual(result, { state: null, processExists: true });
  assert.equal(stateReads, 1);
});

test('startup reconciliation reports no evidence without retrying the launch', async () => {
  let checks = 0;
  const result = await waitForDockerDshStartupEvidence({
    readState: async () => null,
    processExists: async () => { checks += 1; return false; },
    assertLease: async () => undefined,
    delay: async () => undefined,
    timeoutMs: 0,
  });
  assert.deepEqual(result, { state: null, processExists: false });
  assert.equal(checks, 1);
});
