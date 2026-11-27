import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { promisify } from 'node:util';
import { claimAndStartDockerDsh, claimDockerDshLaunchIntentScript, DockerDshRecoveryPendingError } from './docker-dsh-launch-intent.ts';

const exec = promisify(execFile);

test('a persistent Docker run launch intent has exactly one claimant', async () => {
  const root = await mkdtemp(join(tmpdir(), 'csa-launch-intent-'));
  const directory = join(root, 'run with spaces');
  try {
    const contenders = await Promise.all(Array.from({ length: 24 }, async (_, index) => {
      const { stdout } = await exec('/bin/sh', ['-c', claimDockerDshLaunchIntentScript, 'csa-claim', directory, `worker-${index}`]);
      return { index, result: stdout.trim() };
    }));
    const winners = contenders.filter(contender => contender.result === 'created');
    assert.equal(winners.length, 1);
    assert.equal(contenders.filter(contender => contender.result === 'exists').length, 23);
    assert.equal((await readFile(join(directory, 'launch.intent'), 'utf8')).trim(), `worker-${winners[0].index}`);
    const retry = await exec('/bin/sh', ['-c', claimDockerDshLaunchIntentScript, 'csa-claim', directory, 'retry']);
    assert.equal(retry.stdout, 'exists');
    assert.equal((await readFile(join(directory, 'launch.intent'), 'utf8')).trim(), `worker-${winners[0].index}`);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('a successor cannot overwrite input or relaunch after ownership is lost', async () => {
  let owned = true;
  let claimed = false;
  let finishWrite!: () => void;
  let writing!: () => void;
  const writingStarted = new Promise<void>(resolve => { writing = resolve; });
  const writeFinished = new Promise<void>(resolve => { finishWrite = resolve; });
  let starts = 0;
  let writes = 0;
  const claim = async () => { if (claimed) return false; claimed = true; return true; };
  const first = claimAndStartDockerDsh({
    lease: { assertOwned: async () => { if (!owned) throw new Error('lease lost'); } },
    claim,
    writeInput: async () => { writes += 1; writing(); await writeFinished; },
    start: async () => { starts += 1; },
    isStopped: () => false,
  });
  await writingStarted;
  owned = false;
  await assert.rejects(claimAndStartDockerDsh({
    lease: { assertOwned: async () => undefined },
    claim,
    writeInput: async () => { writes += 1; },
    start: async () => { starts += 1; },
    isStopped: () => false,
  }), DockerDshRecoveryPendingError);
  finishWrite();
  await assert.rejects(first, /lease lost/);
  assert.equal(writes, 1);
  assert.equal(starts, 0);
});

test('an unknown Docker start result retains the claim and is not retried', async () => {
  let claimed = false;
  let starts = 0;
  const options = {
    lease: { assertOwned: async () => undefined },
    claim: async () => { if (claimed) return false; claimed = true; return true; },
    writeInput: async () => undefined,
    start: async () => { starts += 1; throw new Error('connection closed after submit'); },
    isStopped: () => false,
  };
  await assert.rejects(claimAndStartDockerDsh(options), DockerDshRecoveryPendingError);
  await assert.rejects(claimAndStartDockerDsh(options), DockerDshRecoveryPendingError);
  assert.equal(starts, 1);
});
