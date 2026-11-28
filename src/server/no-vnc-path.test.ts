import assert from 'node:assert/strict';
import test from 'node:test';
import { noVncWebSocketPath } from '../shared/no-vnc-path.ts';

test('noVNC gets a relative WebSocket path for the root deployment', () => {
  assert.equal(noVncWebSocketPath('/api/computer/desktop/websockify'), 'api/computer/desktop/websockify');
});

test('noVNC keeps the public base path without the leading slash it adds itself', () => {
  assert.equal(noVncWebSocketPath('/super-agent/api/computer/desktop/websockify'), 'super-agent/api/computer/desktop/websockify');
});

test('noVNC path normalization removes repeated leading slashes only', () => {
  assert.equal(noVncWebSocketPath('///super-agent/api/computer/desktop/websockify'), 'super-agent/api/computer/desktop/websockify');
});
