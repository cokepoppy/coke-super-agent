import test from 'node:test';
import assert from 'node:assert/strict';
import type { PoolConnection } from 'mysql2/promise';
import { normalizeGuestTraceSequence, sanitizeRunTrace, transitionRun } from './task-store.ts';

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

test('a leased run transition stays on the lock-owning connection', async () => {
  const calls: string[] = [];
  const connection = {
    beginTransaction: async () => { calls.push('begin'); },
    execute: async (sql: string) => {
      calls.push(sql);
      if (sql.startsWith('SELECT id FROM runs')) return [[{ id: 'run-a' }], []];
      if (sql.startsWith('SELECT COALESCE')) return [[{ next_sequence: 2 }], []];
      return [{ affectedRows: 1 }, []];
    },
    commit: async () => { calls.push('commit'); },
    rollback: async () => { calls.push('rollback'); },
    release: () => { calls.push('release'); },
  } as unknown as PoolConnection;

  await transitionRun('tenant-a', 'run-a', 'working', 'progress', 'Testing', connection);
  assert.equal(calls[0], 'begin');
  assert.ok(calls.some(sql => sql.startsWith('UPDATE runs SET status')));
  assert.equal(calls.at(-1), 'commit');
  assert.ok(!calls.includes('release'));
});

test('persisted DSH trace cursors reject invalid or negative values', () => {
  assert.equal(normalizeGuestTraceSequence(0), 0);
  assert.equal(normalizeGuestTraceSequence('42'), 42);
  assert.equal(normalizeGuestTraceSequence(-1), 0);
  assert.equal(normalizeGuestTraceSequence('not-a-sequence'), 0);
});
