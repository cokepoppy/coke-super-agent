import assert from 'node:assert/strict';
import { test } from 'node:test';
import { maxSessionRunDurationMs, maxSessionRunSteps } from './session-budget.mjs';

test('keeps the 25-minute total runtime deadline and allows a complete multi-step task', () => {
  assert.equal(maxSessionRunDurationMs, 25 * 60_000);
  assert.equal(maxSessionRunSteps, 40);
});
