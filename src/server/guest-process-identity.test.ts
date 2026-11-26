import assert from 'node:assert/strict';
import { test } from 'node:test';
import { isGuestAgentProcessCommandLine } from './guest-process-identity.ts';

const runId = 'd3954b86-c67b-45ac-970f-2cfda765ec20';

test('matches the DSH runtime entry and exact run id in proc argv', () => {
  const cmdline = `/opt/csa-agent-runtime/bin/node\0/opt/csa-agent-runtime/dsh-sdk-client/dist/run-task.bundle.mjs\0${runId}\0`;
  assert.equal(isGuestAgentProcessCommandLine(cmdline, runId), true);
});

test('matches a versioned Pi runtime entry and exact run id in proc argv', () => {
  const cmdline = `/opt/csa-agent-runtime/bin/node\0/opt/csa-agent-runtime/pi-15931a246b2f00c2/run-task.mjs\0${runId}\0`;
  assert.equal(isGuestAgentProcessCommandLine(cmdline, runId), true);
});

test('rejects a different run id and paths outside the locked runtime layout', () => {
  const wrongRun = `/opt/csa-agent-runtime/bin/node\0/opt/csa-agent-runtime/pi-15931a246b2f00c2/run-task.mjs\0other-run\0`;
  const wrongPath = `/opt/csa-agent-runtime/bin/node\0/tmp/pi-15931a246b2f00c2/run-task.mjs\0${runId}\0`;
  const malformedKey = `/opt/csa-agent-runtime/bin/node\0/opt/csa-agent-runtime/pi-15931a246b2f00c2aa/run-task.mjs\0${runId}\0`;
  assert.equal(isGuestAgentProcessCommandLine(wrongRun, runId), false);
  assert.equal(isGuestAgentProcessCommandLine(wrongPath, runId), false);
  assert.equal(isGuestAgentProcessCommandLine(malformedKey, runId), false);
});
