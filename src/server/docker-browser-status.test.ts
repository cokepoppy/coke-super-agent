import assert from 'node:assert/strict';
import test from 'node:test';
import { resolveDockerBrowserStatus } from './docker-browser-status.ts';

test('a live CDP endpoint is ready even when an older desktop image has no status marker', () => {
  assert.equal(resolveDockerBrowserStatus('', true, true), 'ready');
});

test('an explicit browser failure remains visible', () => {
  assert.equal(resolveDockerBrowserStatus('failed', true, true), 'failed');
});

test('a ready desktop session with CDP still starting reports starting', () => {
  assert.equal(resolveDockerBrowserStatus('', true, false), 'starting');
});

test('a missing desktop session and CDP status remains unknown', () => {
  assert.equal(resolveDockerBrowserStatus('', false, false), 'unknown');
});
