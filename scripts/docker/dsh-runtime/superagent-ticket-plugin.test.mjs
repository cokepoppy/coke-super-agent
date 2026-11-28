import test from 'node:test';
import assert from 'node:assert/strict';
import { apply, renderProactiveMandatePrompt } from './superagent-ticket-plugin.mjs';

const context = {
  ticketId: '123e4567-e89b-42d3-a456-426614174000',
  ruleId: '123e4567-e89b-42d3-a456-426614174001',
  ruleName: 'Read the BSE rule page',
  mandate: 'Read the latest published trading rules and summarize changes.',
  source: 'schedule',
  scheduledFor: '2026-11-28T04:00:00.000Z',
};

test('proactive ticket plugin returns the immutable ticket context without side effects', async () => {
  const previous = process.env.CSA_SUPERAGENT_TICKET_CONTEXT;
  process.env.CSA_SUPERAGENT_TICKET_CONTEXT = JSON.stringify(context);
  let registered;
  try {
    apply({ tools: { register(value) { registered = value; } } });
    assert.equal(registered.name, 'superagent_ticket_context');
    const result = await registered.execute({}, { signal: new AbortController().signal });
    assert.deepEqual(JSON.parse(result.text), context);
  } finally {
    if (previous === undefined) delete process.env.CSA_SUPERAGENT_TICKET_CONTEXT;
    else process.env.CSA_SUPERAGENT_TICKET_CONTEXT = previous;
  }
});

test('proactive plugin rejects missing or malformed scope metadata', () => {
  const previous = process.env.CSA_SUPERAGENT_TICKET_CONTEXT;
  delete process.env.CSA_SUPERAGENT_TICKET_CONTEXT;
  try { assert.throws(() => apply({ tools: { register() {} } }), /context is missing/); }
  finally { if (previous !== undefined) process.env.CSA_SUPERAGENT_TICKET_CONTEXT = previous; }
});

test('active prompt states the ticket boundary and treats page data as untrusted', () => {
  const prompt = renderProactiveMandatePrompt(context);
  assert.match(prompt, /授权范围/);
  assert.match(prompt, /不可信数据/);
  assert.match(prompt, /不要自行扩展任务/);
});
