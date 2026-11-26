import { randomUUID } from 'node:crypto';
import type { PoolConnection, RowDataPacket } from 'mysql2/promise';
import type { ActivityFeedItem, RunDetail, RunEventView, RunSummary, RunStatus, RunTraceEvent } from '../shared/types.ts';
import { pool } from './db.ts';
import { config } from './config.ts';

interface RunRow extends RowDataPacket {
  id: string;
  thread_id: string;
  title: string;
  prompt: string;
  status: RunStatus;
  created_at: Date | string;
  updated_at: Date | string;
}

interface EventRow extends RowDataPacket {
  id: number;
  sequence_no: number;
  event_type: string;
  payload: Record<string, unknown> | string;
  created_at: Date | string;
}

interface ActivityRow extends EventRow {
  run_id: string;
  title: string;
  status: RunStatus;
}

function iso(value: Date | string): string {
  return new Date(value).toISOString();
}

function toSummary(row: RunRow): RunSummary {
  return {
    id: row.id,
    threadId: row.thread_id,
    title: row.title,
    prompt: row.prompt,
    status: row.status,
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
  };
}

function toEvent(row: EventRow): RunEventView {
  let payload = row.payload;
  if (typeof payload === 'string') {
    try { payload = JSON.parse(payload) as Record<string, unknown>; }
    catch { payload = { message: 'Event payload could not be decoded.' }; }
  }
  return {
    id: Number(row.id),
    sequence: Number(row.sequence_no),
    type: row.event_type,
    payload,
    createdAt: iso(row.created_at),
  };
}

async function insertQueuedRun(connection: PoolConnection, tenantId: string, prompt: string): Promise<{ runId: string; threadId: string }> {
  const threadId = randomUUID();
  const runId = randomUUID();
  const title = prompt.replace(/\s+/g, ' ').trim().slice(0, 160) || '新任务';
  await connection.execute('INSERT INTO threads (id, tenant_id, title) VALUES (?, ?, ?)', [threadId, tenantId, title]);
  await connection.execute('INSERT INTO runs (id, tenant_id, thread_id, prompt, status) VALUES (?, ?, ?, ?, \'queued\')', [runId, tenantId, threadId, prompt]);
  await connection.execute('INSERT INTO messages (id, tenant_id, thread_id, run_id, role, body) VALUES (?, ?, ?, ?, \'user\', ?)', [randomUUID(), tenantId, threadId, runId, prompt]);
  await connection.execute(
    'INSERT INTO run_events (tenant_id, run_id, sequence_no, event_type, payload) VALUES (?, ?, 1, \'queued\', ?)',
    [tenantId, runId, JSON.stringify({ message: '任务已保存，等待 Agent Runtime 接单。' })],
  );
  await connection.execute(
    'INSERT INTO run_events (tenant_id, run_id, sequence_no, event_type, payload) VALUES (?, ?, 2, \'debug\', ?)',
    [tenantId, runId, JSON.stringify(sanitizeRunTrace({ component: 'api', stage: 'task.created', level: 'info', message: '任务请求已校验并写入 MySQL 队列。' }))],
  );
  return { runId, threadId };
}

async function loadSummary(tenantId: string, runId: string): Promise<RunSummary> {
  const [rows] = await pool.execute<RunRow[]>(
    `SELECT r.id, r.thread_id, t.title, r.prompt, r.status, r.created_at, r.updated_at
       FROM runs r JOIN threads t ON t.id = r.thread_id AND t.tenant_id = r.tenant_id
      WHERE r.id = ? AND r.tenant_id = ? LIMIT 1`,
    [runId, tenantId],
  );
  if (!rows[0]) throw new Error('Created task could not be reloaded.');
  return toSummary(rows[0]);
}

export async function createQueuedRun(tenantId: string, promptValue: unknown): Promise<RunSummary> {
  const prompt = typeof promptValue === 'string' ? promptValue.trim() : '';
  if (!prompt || prompt.length > 10_000) throw new Error('Task must contain between 1 and 10000 characters.');
  const connection = await pool.getConnection();
  let committed = false;
  try {
    await connection.beginTransaction();
    const { runId } = await insertQueuedRun(connection, tenantId, prompt);
    await connection.commit();
    committed = true;
    writeRunLog({ tenantId, runId, sequence: 2, component: 'api', stage: 'task.created', level: 'info', message: '任务请求已校验并写入 MySQL 队列。' });
    return await loadSummary(tenantId, runId);
  } catch (error) {
    if (!committed) await connection.rollback();
    throw error;
  } finally {
    connection.release();
  }
}

export async function createQueuedReplyRun(tenantId: string, previousRunId: string, promptValue: unknown): Promise<RunSummary> {
  const prompt = typeof promptValue === 'string' ? promptValue.trim() : '';
  if (!prompt || prompt.length > 10_000) throw new Error('Task must contain between 1 and 10000 characters.');
  const connection = await pool.getConnection();
  let committed = false;
  let runId = '';
  try {
    await connection.beginTransaction();
    const [previousRows] = await connection.execute<RowDataPacket[]>(
      'SELECT thread_id, status FROM runs WHERE id = ? AND tenant_id = ? FOR UPDATE', [previousRunId, tenantId],
    );
    const previous = previousRows[0] as { thread_id?: string; status?: RunStatus } | undefined;
    if (!previous?.thread_id) throw new Error('Task cannot be continued.');
    if (!['done', 'waiting_for_user', 'failed'].includes(String(previous.status))) throw new Error('Task cannot be continued while it is still running.');
    const [latestRows] = await connection.execute<RowDataPacket[]>(
      'SELECT status FROM runs WHERE tenant_id = ? AND thread_id = ? ORDER BY created_at DESC LIMIT 1 FOR UPDATE',
      [tenantId, previous.thread_id],
    );
    const latestStatus = String(latestRows[0]?.status || '');
    if (!['done', 'waiting_for_user', 'failed'].includes(latestStatus)) throw new Error('Task cannot be continued while a newer run is still running.');

    runId = randomUUID();
    await connection.execute(
      'INSERT INTO runs (id, tenant_id, thread_id, prompt, status) VALUES (?, ?, ?, ?, \'queued\')',
      [runId, tenantId, previous.thread_id, prompt],
    );
    await connection.execute(
      'INSERT INTO messages (id, tenant_id, thread_id, run_id, role, body) VALUES (?, ?, ?, ?, \'user\', ?)',
      [randomUUID(), tenantId, previous.thread_id, runId, prompt],
    );
    await connection.execute(
      'INSERT INTO run_events (tenant_id, run_id, sequence_no, event_type, payload) VALUES (?, ?, 1, \'queued\', ?)',
      [tenantId, runId, JSON.stringify({ message: '跟进已保存，等待 Agent Runtime 接单。' })],
    );
    await connection.execute(
      'INSERT INTO run_events (tenant_id, run_id, sequence_no, event_type, payload) VALUES (?, ?, 2, \'debug\', ?)',
      [tenantId, runId, JSON.stringify(sanitizeRunTrace({ component: 'api', stage: 'task.continued', level: 'info', message: '任务跟进已校验并写入 MySQL 队列。' }))],
    );
    await connection.execute('UPDATE threads SET updated_at = UTC_TIMESTAMP(3) WHERE id = ? AND tenant_id = ?', [previous.thread_id, tenantId]);
    await connection.commit();
    committed = true;
    writeRunLog({ tenantId, runId, sequence: 2, component: 'api', stage: 'task.continued', level: 'info', message: '任务跟进已校验并写入 MySQL 队列。' });
    return await loadSummary(tenantId, runId);
  } catch (error) {
    if (!committed) await connection.rollback();
    throw error;
  } finally {
    connection.release();
  }
}

export async function transitionRun(
  tenantId: string,
  runId: string,
  status: RunStatus,
  eventType: string,
  message: string,
): Promise<void> {
  const connection = await pool.getConnection();
  let committed = false;
  try {
    await connection.beginTransaction();
    const [runRows] = await connection.execute<RowDataPacket[]>(
      'SELECT id FROM runs WHERE id = ? AND tenant_id = ? FOR UPDATE', [runId, tenantId],
    );
    if (!runRows.length) throw new Error('Task no longer belongs to this tenant.');
    const [sequenceRows] = await connection.execute<RowDataPacket[]>(
      'SELECT COALESCE(MAX(sequence_no), 0) + 1 AS next_sequence FROM run_events WHERE tenant_id = ? AND run_id = ?',
      [tenantId, runId],
    );
    const nextSequence = Number(sequenceRows[0]?.next_sequence || 1);
    const level = eventType === 'failed' ? 'error' : eventType === 'waiting_for_user' ? 'warning' : 'info';
    const safeMessage = redactSecrets(message);
    const logEvent = {
      component: 'agent-runtime',
      stage: `run.${eventType}`,
      level,
      message: safeMessage.slice(0, 30_000),
    };
    await connection.execute('UPDATE runs SET status = ?, updated_at = UTC_TIMESTAMP(3) WHERE id = ? AND tenant_id = ?', [status, runId, tenantId]);
    await connection.execute(
      'INSERT INTO run_events (tenant_id, run_id, sequence_no, event_type, payload) VALUES (?, ?, ?, ?, ?)',
      [tenantId, runId, nextSequence, eventType, JSON.stringify(logEvent)],
    );
    await connection.execute(
      'UPDATE threads t JOIN runs r ON r.thread_id = t.id AND r.tenant_id = t.tenant_id SET t.updated_at = UTC_TIMESTAMP(3) WHERE r.id = ? AND r.tenant_id = ?',
      [runId, tenantId],
    );
    await connection.commit();
    committed = true;
    writeRunLog({
      tenantId,
      runId,
      sequence: nextSequence,
      ...logEvent,
      eventType,
      status,
      message: logEvent.message.slice(0, 3000),
    });
  } catch (error) {
    if (!committed) await connection.rollback();
    throw error;
  } finally {
    connection.release();
  }
}

export async function appendRunTrace(tenantId: string, runId: string, event: RunTraceEvent): Promise<number> {
  const payload = sanitizeRunTrace(event);
  const connection = await pool.getConnection();
  let committed = false;
  try {
    await connection.beginTransaction();
    const [runRows] = await connection.execute<RowDataPacket[]>(
      'SELECT id FROM runs WHERE id = ? AND tenant_id = ? FOR UPDATE', [runId, tenantId],
    );
    if (!runRows.length) throw new Error('Task no longer belongs to this tenant.');
    const [sequenceRows] = await connection.execute<RowDataPacket[]>(
      'SELECT COALESCE(MAX(sequence_no), 0) + 1 AS next_sequence FROM run_events WHERE tenant_id = ? AND run_id = ?',
      [tenantId, runId],
    );
    const sequence = Number(sequenceRows[0]?.next_sequence || 1);
    await connection.execute(
      'INSERT INTO run_events (tenant_id, run_id, sequence_no, event_type, payload) VALUES (?, ?, ?, \'debug\', ?)',
      [tenantId, runId, sequence, JSON.stringify(payload)],
    );
    await connection.execute(
      'UPDATE threads t JOIN runs r ON r.thread_id = t.id AND r.tenant_id = t.tenant_id SET t.updated_at = UTC_TIMESTAMP(3) WHERE r.id = ? AND r.tenant_id = ?',
      [runId, tenantId],
    );
    await connection.commit();
    committed = true;
    writeRunLog({ tenantId, runId, sequence, ...payload });
    return sequence;
  } catch (error) {
    if (!committed) await connection.rollback();
    throw error;
  } finally {
    connection.release();
  }
}

export function sanitizeRunTrace(event: RunTraceEvent): RunTraceEvent {
  const sensitiveName = /(api.?key|password|token|secret|credential|authorization|cookie|prompt|headers?)/i;
  const details: Record<string, string | number | boolean | null> = {};
  for (const [key, value] of Object.entries(event.details && typeof event.details === 'object' ? event.details : {})) {
    if (sensitiveName.test(key)) continue;
    if (typeof value === 'string') {
      const isTail = /tail|stdout|stderr/i.test(key);
      const isStructuredDiagnostic = /^(returnedErrorSummary|returnedEventSamples|returnedNotificationSamples)$/.test(key);
      const limit = key === 'errorStack' || isTail ? 2400 : isStructuredDiagnostic ? 1400 : key === 'errorMessage' ? 1600 : key === 'errorCause' ? 1200 : 500;
      const safeValue = redactSecrets(value);
      details[key.slice(0, 80)] = key === 'errorStack' || isTail ? safeValue.slice(-limit) : safeValue.slice(0, limit);
    }
    else if (value === null || typeof value === 'boolean' || (typeof value === 'number' && Number.isFinite(value))) details[key.slice(0, 80)] = value;
  }
  const component = typeof event.component === 'string' ? event.component : 'runtime';
  const stage = typeof event.stage === 'string' ? event.stage : 'unknown-stage';
  const message = typeof event.message === 'string' ? event.message : String(event.message ?? '');
  const level = event.level === 'error' || event.level === 'warning' ? event.level : 'info';
  const duration = Number(event.durationMs);
  return {
    component: redactSecrets(component).slice(0, 80),
    stage: redactSecrets(stage).slice(0, 100),
    level,
    message: redactSecrets(message).slice(0, 3000),
    ...(Number.isFinite(duration) ? { durationMs: Math.max(0, Math.trunc(duration)) } : {}),
    ...(Object.keys(details).length ? { details } : {}),
  };
}

function writeRunLog(event: {
  tenantId: string;
  runId: string;
  sequence: number;
  component?: string;
  stage?: string;
  level?: string;
  message?: string;
  durationMs?: number;
  details?: Record<string, string | number | boolean | null>;
  eventType?: string;
  status?: string;
}): void {
  const record = {
    timestamp: new Date().toISOString(),
    logger: 'coke-super-agent.run',
    ...event,
  };
  process.stdout.write(JSON.stringify(record) + '\n');
}

function redactSecrets(value: string): string {
  return [config.agent.apiKey, config.cube.apiKey].filter(Boolean)
    .reduce((result, secret) => result.split(secret).join('[redacted]'), value)
    .replace(/\bBearer\s+[A-Za-z0-9._~+/-]+=*/gi, 'Bearer [redacted]')
    .replace(/\bsk-[A-Za-z0-9_-]{8,}\b/g, '[redacted-api-key]')
    .replace(/(?:https?:\/\/)[^\s/@]+:[^\s/@]+@/gi, 'https://[redacted]@')
    .replace(/([?&](?:api[_-]?key|access[_-]?token|token|password|secret)=)[^&\s]+/gi, '$1[redacted]')
    .replace(/((?:["'`])?[\w.-]*(?:api[_-]?key|password|token|secret|credential|authorization|cookie)[\w.-]*(?:["'`])?\s*[:=]\s*(?:["'`])?)[^"'`\s,;}]+/gi, '$1[redacted]');
}

export async function listRuns(tenantId: string): Promise<RunSummary[]> {
  const [rows] = await pool.execute<RunRow[]>(
    `SELECT r.id, r.thread_id, t.title, r.prompt, r.status, r.created_at, r.updated_at
       FROM runs r JOIN threads t ON t.id = r.thread_id AND t.tenant_id = r.tenant_id
      WHERE r.tenant_id = ? ORDER BY r.updated_at DESC LIMIT 100`,
    [tenantId],
  );
  return rows.map(toSummary);
}

export async function listRecentActivity(
  tenantId: string,
  beforeId: number | null,
  limit: number,
  includeDebug: boolean,
): Promise<{ items: ActivityFeedItem[]; nextCursor: number | null }> {
  const cursorClause = beforeId === null ? '' : ' AND e.id < ?';
  const debugClause = includeDebug ? '' : " AND e.event_type <> 'debug'";
  const params = beforeId === null ? [tenantId, limit + 1] : [tenantId, beforeId, limit + 1];
  const [rows] = await pool.execute<ActivityRow[]>(
    `SELECT e.id, e.run_id, e.sequence_no, e.event_type, e.payload, e.created_at, r.status, t.title
       FROM run_events e
       JOIN runs r ON r.id = e.run_id AND r.tenant_id = e.tenant_id
       JOIN threads t ON t.id = r.thread_id AND t.tenant_id = r.tenant_id
      WHERE e.tenant_id = ?${debugClause}${cursorClause}
      ORDER BY e.id DESC LIMIT ?`,
    params,
  );
  const page = rows.slice(0, limit);
  return {
    items: page.map(row => ({
      runId: row.run_id,
      title: row.title,
      status: row.status,
      event: toEvent(row),
    })),
    nextCursor: rows.length > limit && page.length ? Number(page[page.length - 1]!.id) : null,
  };
}

export async function runExists(tenantId: string, runId: string): Promise<boolean> {
  const [rows] = await pool.execute<RowDataPacket[]>('SELECT id FROM runs WHERE id = ? AND tenant_id = ? LIMIT 1', [runId, tenantId]);
  return rows.length > 0;
}

export async function getRunDetail(tenantId: string, runId: string): Promise<RunDetail | null> {
  const [rows] = await pool.execute<RunRow[]>(
    `SELECT r.id, r.thread_id, t.title, r.prompt, r.status, r.created_at, r.updated_at
       FROM runs r JOIN threads t ON t.id = r.thread_id AND t.tenant_id = r.tenant_id
      WHERE r.id = ? AND r.tenant_id = ? LIMIT 1`,
    [runId, tenantId],
  );
  if (!rows[0]) return null;
  const [eventRows] = await pool.execute<EventRow[]>(
    'SELECT id, sequence_no, event_type, payload, created_at FROM run_events WHERE tenant_id = ? AND run_id = ? ORDER BY id ASC LIMIT 500',
    [tenantId, runId],
  );
  return { ...toSummary(rows[0]), events: eventRows.map(toEvent) };
}

export async function listEventsAfter(tenantId: string, runId: string, afterId: number): Promise<RunEventView[]> {
  const [rows] = await pool.execute<EventRow[]>(
    'SELECT id, sequence_no, event_type, payload, created_at FROM run_events WHERE tenant_id = ? AND run_id = ? AND id > ? ORDER BY id ASC LIMIT 100',
    [tenantId, runId, afterId],
  );
  return rows.map(toEvent);
}
