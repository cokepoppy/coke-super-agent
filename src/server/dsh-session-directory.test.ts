import assert from 'node:assert/strict';
import test from 'node:test';
import path from 'node:path';
import { dshSessionDirectory } from '../../scripts/cube/dsh-runtime/session-directory.ts';

test('locates a Docker DSH session using the effective task workspace', () => {
  const threadId = '8a6ee54b-5750-4b2d-bc4f-fc850c12a173';
  assert.equal(
    dshSessionDirectory('/var/lib/csa-agent-runtime/.csa-super-agent/dsh-home', `/var/lib/csa-agent-runtime/tasks/${threadId}`, threadId),
    path.join('/var/lib/csa-agent-runtime/.csa-super-agent/dsh-home', 'sessions', `--var-lib-csa-agent-runtime-tasks-${threadId}--`, threadId),
  );
});

test('locates a Cube DSH session using the workspace volume path', () => {
  const threadId = '8a6ee54b-5750-4b2d-bc4f-fc850c12a173';
  assert.equal(
    dshSessionDirectory('/workspace/.csa-super-agent/dsh-home', `/workspace/tasks/${threadId}`, threadId),
    path.join('/workspace/.csa-super-agent/dsh-home', 'sessions', `--workspace-tasks-${threadId}--`, threadId),
  );
});
