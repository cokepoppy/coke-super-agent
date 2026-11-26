import test from 'node:test';
import assert from 'node:assert/strict';
import { listTaskArtifacts, taskArtifactAbsolutePath, type ArtifactFilesystem } from './artifacts.ts';

test('task artifacts recursively list visible regular files and omit hidden entries', async () => {
  const tree: Record<string, Array<Record<string, unknown>>> = {
    '/workspace/tasks/thread-1': [
      { name: 'agent-response.md', type: 'FILE_TYPE_FILE', size: '12', modifiedTime: '2026-11-20T01:00:00Z' },
      { name: 'report', type: 'FILE_TYPE_DIRECTORY' },
      { name: '.internal', type: 'FILE_TYPE_DIRECTORY' },
      { name: 'linked-secret.txt', type: 'FILE_TYPE_SYMLINK', size: 18 },
    ],
    '/workspace/tasks/thread-1/report': [
      { name: 'summary.json', type: 'FILE_TYPE_FILE', size: 24 },
      { name: '.cache', type: 'FILE_TYPE_FILE', size: 9 },
    ],
  };
  const filesystem: ArtifactFilesystem = { list: async path => tree[path] || [] };
  assert.deepEqual(await listTaskArtifacts(filesystem, '/workspace/tasks/thread-1'), [
    { path: 'agent-response.md', name: 'agent-response.md', sizeBytes: 12, modifiedAt: '2026-11-20T01:00:00Z', mediaType: 'text/markdown', previewable: true },
    { path: 'report/summary.json', name: 'summary.json', sizeBytes: 24, modifiedAt: null, mediaType: 'application/json', previewable: true },
  ]);
});

test('task artifact paths cannot escape their task directory', () => {
  assert.equal(taskArtifactAbsolutePath('/workspace/tasks/thread-1', 'report/summary.json'), '/workspace/tasks/thread-1/report/summary.json');
  for (const value of ['', '/etc/passwd', '../other/file', 'report/../../other', 'report/.secret', 'report\\secret', 'bad\0name']) {
    assert.equal(taskArtifactAbsolutePath('/workspace/tasks/thread-1', value), null, value);
  }
});
