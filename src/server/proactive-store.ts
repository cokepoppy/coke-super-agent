import { randomUUID } from 'node:crypto';
import type { PoolConnection, RowDataPacket } from 'mysql2/promise';
import type { CreateProactiveRuleInput, PatchProactiveRuleInput, ProactiveMode, ProactiveOccurrenceOutcome, ProactiveOccurrenceView, ProactiveRuleView, ProactiveTicketContext } from '../shared/proactive.ts';
import { pool } from './db.ts';
import { maximumProactiveRulesPerScan, nextScheduledAt, normalizeProactiveRuleInput, type NormalizedProactiveRuleInput } from './proactive-policy.ts';

interface RuleRow extends RowDataPacket {
  id: string;
  tenant_id: string;
  name: string;
  prompt: string;
  interval_minutes: number;
  execution_mode: ProactiveMode;
  enabled: number | boolean;
  next_run_at: Date | string;
  last_triggered_at: Date | string | null;
  last_outcome: ProactiveOccurrenceOutcome | null;
  created_at: Date | string;
  updated_at: Date | string;
}

interface OccurrenceRow extends RowDataPacket {
  id: string;
  rule_id: string;
  rule_name: string;
  scheduled_for: Date | string;
  outcome: ProactiveOccurrenceOutcome;
  run_id: string | null;
  created_at: Date | string;
}

interface DueRuleRow extends RowDataPacket {
  id: string;
  tenant_id: string;
  name: string;
  prompt: string;
  interval_minutes: number;
  execution_mode: ProactiveMode;
  next_run_at: Date | string;
}

function iso(value: Date | string | null): string | null {
  return value === null ? null : new Date(value).toISOString();
}

function ruleView(row: RuleRow): ProactiveRuleView {
  return {
    id: row.id,
    name: row.name,
    prompt: row.prompt,
    intervalMinutes: Number(row.interval_minutes),
    mode: row.execution_mode,
    enabled: Boolean(row.enabled),
    nextRunAt: iso(row.next_run_at)!,
    lastTriggeredAt: iso(row.last_triggered_at),
    lastOutcome: row.last_outcome,
    createdAt: iso(row.created_at)!,
    updatedAt: iso(row.updated_at)!,
  };
}

function occurrenceView(row: OccurrenceRow): ProactiveOccurrenceView {
  return {
    id: row.id,
    ruleId: row.rule_id,
    ruleName: row.rule_name,
    scheduledFor: iso(row.scheduled_for)!,
    outcome: row.outcome,
    runId: row.run_id,
    createdAt: iso(row.created_at)!,
  };
}

export async function listProactiveRules(tenantId: string): Promise<{ rules: ProactiveRuleView[]; occurrences: ProactiveOccurrenceView[] }> {
  const [ruleRows] = await pool.execute<RuleRow[]>(
    `SELECT id, tenant_id, name, prompt, interval_minutes, execution_mode, enabled, next_run_at,
            last_triggered_at, last_outcome, created_at, updated_at
       FROM proactive_rules WHERE tenant_id = ? ORDER BY enabled DESC, next_run_at ASC, created_at DESC`,
    [tenantId],
  );
  const [occurrenceRows] = await pool.execute<OccurrenceRow[]>(
    `SELECT o.id, o.rule_id, o.rule_name, o.scheduled_for, o.outcome, o.run_id, o.created_at
       FROM proactive_occurrences o WHERE o.tenant_id = ? ORDER BY o.created_at DESC LIMIT 50`,
    [tenantId],
  );
  return { rules: ruleRows.map(ruleView), occurrences: occurrenceRows.map(occurrenceView) };
}

export async function createProactiveRule(tenantId: string, input: CreateProactiveRuleInput): Promise<ProactiveRuleView> {
  const normalized = normalizeProactiveRuleInput(input);
  const id = randomUUID();
  const nextRunAt = new Date(Date.now() + normalized.intervalMinutes * 60_000);
  await pool.execute(
    `INSERT INTO proactive_rules (id, tenant_id, name, prompt, interval_minutes, execution_mode, enabled, next_run_at)
     VALUES (?, ?, ?, ?, ?, ?, 1, ?)`,
    [id, tenantId, normalized.name, normalized.prompt, normalized.intervalMinutes, normalized.mode, nextRunAt],
  );
  const rule = await getRule(tenantId, id);
  if (!rule) throw new Error('Created proactive rule could not be reloaded.');
  return rule;
}

async function getRule(tenantId: string, id: string): Promise<ProactiveRuleView | null> {
  const [rows] = await pool.execute<RuleRow[]>(
    `SELECT id, tenant_id, name, prompt, interval_minutes, execution_mode, enabled, next_run_at,
            last_triggered_at, last_outcome, created_at, updated_at
       FROM proactive_rules WHERE id = ? AND tenant_id = ? LIMIT 1`,
    [id, tenantId],
  );
  return rows[0] ? ruleView(rows[0]) : null;
}

export async function patchProactiveRule(tenantId: string, id: string, input: PatchProactiveRuleInput): Promise<ProactiveRuleView | null> {
  const connection = await pool.getConnection();
  let committed = false;
  try {
    await connection.beginTransaction();
    const [rows] = await connection.execute<RuleRow[]>(
      `SELECT id, tenant_id, name, prompt, interval_minutes, execution_mode, enabled, next_run_at,
              last_triggered_at, last_outcome, created_at, updated_at
         FROM proactive_rules WHERE id = ? AND tenant_id = ? FOR UPDATE`,
      [id, tenantId],
    );
    const current = rows[0];
    if (!current) {
      await connection.rollback();
      committed = true;
      return null;
    }
    const previous: NormalizedProactiveRuleInput = {
      name: current.name,
      prompt: current.prompt,
      intervalMinutes: Number(current.interval_minutes),
      mode: current.execution_mode,
    };
    const next = normalizeProactiveRuleInput(input, previous);
    const enabled = input.enabled === undefined ? Boolean(current.enabled) : input.enabled;
    if (typeof enabled !== 'boolean') throw new Error('enabled 必须是布尔值。');
    const intervalChanged = next.intervalMinutes !== previous.intervalMinutes;
    const nextRunAt = intervalChanged
      ? new Date(Date.now() + next.intervalMinutes * 60_000)
      : current.next_run_at;
    await connection.execute(
      `UPDATE proactive_rules
          SET name = ?, prompt = ?, interval_minutes = ?, execution_mode = ?, enabled = ?, next_run_at = ?,
              updated_at = UTC_TIMESTAMP(3)
        WHERE id = ? AND tenant_id = ?`,
      [next.name, next.prompt, next.intervalMinutes, next.mode, enabled ? 1 : 0, nextRunAt, id, tenantId],
    );
    await connection.commit();
    committed = true;
    return await getRule(tenantId, id);
  } catch (error) {
    if (!committed) await connection.rollback();
    throw error;
  } finally {
    connection.release();
  }
}

export async function deleteProactiveRule(tenantId: string, id: string): Promise<boolean> {
  const connection = await pool.getConnection();
  let committed = false;
  try {
    await connection.beginTransaction();
    const [ruleRows] = await connection.execute<RowDataPacket[]>('SELECT id FROM proactive_rules WHERE id = ? AND tenant_id = ? FOR UPDATE', [id, tenantId]);
    if (!ruleRows.length) { await connection.rollback(); committed = true; return false; }
    if (await hasOutstandingTicket(connection, tenantId, id)) throw new Error('主动规则仍有运行中或等待接管的 Ticket，请先等待任务结束。');
    await connection.execute('DELETE FROM proactive_rules WHERE id = ? AND tenant_id = ?', [id, tenantId]);
    await connection.commit();
    committed = true;
    return true;
  } catch (error) {
    if (!committed) await connection.rollback();
    throw error;
  } finally { connection.release(); }
}

export interface ProactiveDispatchResult {
  tenantId: string;
  ruleId: string;
  occurrenceId: string;
  outcome: ProactiveOccurrenceOutcome;
  runId?: string;
}

async function hasOutstandingTicket(connection: PoolConnection, tenantId: string, ruleId: string): Promise<boolean> {
  const [rows] = await connection.execute<RowDataPacket[]>(
    `SELECT o.id FROM proactive_occurrences o
       JOIN runs r ON r.id = o.run_id AND r.tenant_id = o.tenant_id
      WHERE o.tenant_id = ? AND o.rule_id = ? AND o.outcome = 'queued'
        AND r.status IN ('queued','working','waiting_for_user') LIMIT 1`,
    [tenantId, ruleId],
  );
  return rows.length > 0;
}

async function insertProactiveRun(connection: PoolConnection, tenantId: string, rule: DueRuleRow, occurrenceId: string, scheduledFor: Date): Promise<string> {
  const threadId = randomUUID();
  const runId = randomUUID();
  const title = `${rule.name} · ${scheduledFor.toISOString().slice(0, 16).replace('T', ' ')}`.slice(0, 160);
  const firstEvent = JSON.stringify({ message: '主动规则触发并创建 Ticket，等待租户 Docker DSH Worker 接单。', component: 'superagent-router', stage: 'ticket.queued', source: 'schedule', ruleId: rule.id, occurrenceId });
  const trace = JSON.stringify({ component: 'superagent-router', stage: 'ticket.created', level: 'info', message: '定时 Trigger 通过租户规则授权检查，已创建独立 Worker Ticket。', details: { source: 'schedule', ruleId: rule.id, occurrenceId, scheduledFor: scheduledFor.toISOString(), workerPlacement: 'tenant-docker-dsh', executionPlacement: 'tenant-cube-microvm' } });
  await connection.execute('INSERT INTO threads (id, tenant_id, title) VALUES (?, ?, ?)', [threadId, tenantId, title]);
  await connection.execute('INSERT INTO runs (id, tenant_id, thread_id, prompt, status) VALUES (?, ?, ?, ?, \'queued\')', [runId, tenantId, threadId, rule.prompt]);
  await connection.execute('INSERT INTO messages (id, tenant_id, thread_id, run_id, role, body) VALUES (?, ?, ?, ?, \'user\', ?)', [randomUUID(), tenantId, threadId, runId, rule.prompt]);
  await connection.execute(
    `INSERT INTO run_events (tenant_id, run_id, sequence_no, event_type, payload)
     VALUES (?, ?, 1, 'queued', ?), (?, ?, 2, 'debug', ?)`,
    [tenantId, runId, firstEvent, tenantId, runId, trace],
  );
  return runId;
}

export async function dispatchDueProactiveRules(now = new Date()): Promise<ProactiveDispatchResult[]> {
  const connection = await pool.getConnection();
  let committed = false;
  try {
    await connection.beginTransaction();
    const [rows] = await connection.execute<DueRuleRow[]>(
      `SELECT id, tenant_id, name, prompt, interval_minutes, execution_mode, next_run_at
         FROM proactive_rules WHERE enabled = 1 AND next_run_at <= ?
        ORDER BY next_run_at ASC LIMIT ${maximumProactiveRulesPerScan} FOR UPDATE SKIP LOCKED`,
      [now],
    );
    const results: ProactiveDispatchResult[] = [];
    for (const rule of rows) {
      const scheduledFor = new Date(rule.next_run_at);
      const occurrenceId = randomUUID();
      const outstanding = rule.execution_mode === 'active' && await hasOutstandingTicket(connection, rule.tenant_id, rule.id);
      let outcome: ProactiveOccurrenceOutcome = rule.execution_mode === 'observe' ? 'observed' : 'queued';
      let runId: string | undefined;
      if (outstanding) outcome = 'skipped_busy';
      if (outcome === 'queued') runId = await insertProactiveRun(connection, rule.tenant_id, rule, occurrenceId, scheduledFor);
      await connection.execute(
        `INSERT INTO proactive_occurrences (id, tenant_id, rule_id, rule_name, mandate, scheduled_for, outcome, run_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        [occurrenceId, rule.tenant_id, rule.id, rule.name, rule.prompt, scheduledFor, outcome, runId || null],
      );
      const nextRunAt = nextScheduledAt(scheduledFor, Number(rule.interval_minutes), now);
      await connection.execute(
        `UPDATE proactive_rules SET next_run_at = ?, last_triggered_at = ?, last_outcome = ?, updated_at = UTC_TIMESTAMP(3)
          WHERE id = ? AND tenant_id = ?`,
        [nextRunAt, scheduledFor, outcome, rule.id, rule.tenant_id],
      );
      results.push({ tenantId: rule.tenant_id, ruleId: rule.id, occurrenceId, outcome, ...(runId ? { runId } : {}) });
    }
    await connection.commit();
    committed = true;
    for (const item of results) {
      process.stdout.write(JSON.stringify({ timestamp: new Date().toISOString(), logger: 'coke-super-agent.proactive', stage: `trigger.${item.outcome}`, level: item.outcome === 'skipped_busy' ? 'warning' : 'info', tenantId: item.tenantId, ruleId: item.ruleId, occurrenceId: item.occurrenceId, runId: item.runId || null }) + '\n');
    }
    return results;
  } catch (error) {
    if (!committed) await connection.rollback();
    throw error;
  } finally {
    connection.release();
  }
}

export async function getProactiveTicketContext(tenantId: string, runId: string): Promise<ProactiveTicketContext | null> {
  const [rows] = await pool.execute<RowDataPacket[]>(
    `SELECT o.id AS ticket_id, o.rule_id, o.rule_name, o.mandate, o.scheduled_for
       FROM proactive_occurrences o
      WHERE o.tenant_id = ? AND o.run_id = ? AND o.outcome = 'queued' LIMIT 1`,
    [tenantId, runId],
  );
  const row = rows[0] as { ticket_id: string; rule_id: string; rule_name: string; mandate: string; scheduled_for: Date | string } | undefined;
  if (!row) return null;
  return {
    ticketId: row.ticket_id,
    ruleId: row.rule_id,
    ruleName: row.rule_name,
    mandate: row.mandate,
    source: 'schedule',
    scheduledFor: iso(row.scheduled_for)!,
  };
}
