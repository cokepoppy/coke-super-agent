import { randomUUID } from 'node:crypto';
import type { PoolConnection, RowDataPacket } from 'mysql2/promise';
import type { RunDetail, RunEventView, RunSummary, RunStatus } from '../shared/types.ts';
import { pool } from './db.ts';

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
    [tenantId, runId, JSON.stringify({ message: '任务已保存，等待 Agent Runtime 执行。' })],
  );
  return { runId, threadId };
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
    const [rows] = await pool.execute<RunRow[]>(
      `SELECT r.id, r.thread_id, t.title, r.prompt, r.status, r.created_at, r.updated_at
         FROM runs r JOIN threads t ON t.id = r.thread_id AND t.tenant_id = r.tenant_id
        WHERE r.id = ? AND r.tenant_id = ? LIMIT 1`,
      [runId, tenantId],
    );
    if (!rows[0]) throw new Error('Created task could not be reloaded.');
    return toSummary(rows[0]);
  } catch (error) {
    if (!committed) await connection.rollback();
    throw error;
  } finally {
    connection.release();
  }
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
