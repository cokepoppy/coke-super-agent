import test from 'node:test';
import assert from 'node:assert/strict';
import { nextScheduledAt, normalizeProactiveRuleInput } from './proactive-policy.ts';

test('a missed proactive interval advances directly to the next future trigger', () => {
  const scheduled = new Date('2026-11-28T00:00:00.000Z');
  const now = new Date('2026-11-28T00:16:00.000Z');
  assert.equal(nextScheduledAt(scheduled, 5, now).toISOString(), '2026-11-28T00:20:00.000Z');
});

test('proactive rule validation keeps Observe as the default and enforces interval bounds', () => {
  assert.deepEqual(normalizeProactiveRuleInput({ name: 'Check site', prompt: 'Read title and report', intervalMinutes: 5 }), {
    name: 'Check site', prompt: 'Read title and report', intervalMinutes: 5, mode: 'observe',
  });
  assert.throws(() => normalizeProactiveRuleInput({ name: 'x', prompt: 'y', intervalMinutes: 0 }), /触发间隔必须/);
  assert.throws(() => normalizeProactiveRuleInput({ name: 'x', prompt: 'y', intervalMinutes: 1, mode: 'shell' }), /规则模式必须/);
});

test('patch validation preserves omitted fields while accepting an explicit pause', () => {
  const previous = { name: 'Daily review', prompt: 'Review a public page', intervalMinutes: 60, mode: 'active' as const };
  assert.deepEqual(normalizeProactiveRuleInput({ intervalMinutes: 15 }, previous), {
    name: previous.name, prompt: previous.prompt, intervalMinutes: 15, mode: 'active',
  });
});
