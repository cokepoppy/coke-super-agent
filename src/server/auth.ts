import { createHash, randomBytes } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { RowDataPacket } from 'mysql2';
import { pool } from './db.ts';
import { config } from './config.ts';
import { verifyPassword } from './password.ts';
import type { SessionView } from '../shared/types.ts';

const cookieName = 'csa_session';
const sessionLifetimeSeconds = 7 * 24 * 60 * 60;

interface AuthRow extends RowDataPacket {
  user_id: string;
  username: string;
  user_name: string;
  tenant_id: string;
  tenant_slug: string;
  tenant_name: string;
  password_hash?: string;
}

function cookieValue(header: string | undefined, name: string): string | null {
  if (!header || header.length > 8192) return null;
  for (const segment of header.split(';')) {
    const separator = segment.indexOf('=');
    if (separator < 0 || segment.slice(0, separator).trim() !== name) continue;
    const value = segment.slice(separator + 1).trim();
    return /^[A-Za-z0-9_-]{43}$/.test(value) ? value : null;
  }
  return null;
}

function sessionHash(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

function sessionView(row: AuthRow): SessionView {
  return {
    user: { id: row.user_id, username: row.username, displayName: row.user_name },
    tenant: { id: row.tenant_id, slug: row.tenant_slug, displayName: row.tenant_name },
  };
}

export function setSessionCookie(res: ServerResponse, token: string): void {
  const secure = config.cookieSecure ? '; Secure' : '';
  res.setHeader('Set-Cookie', cookieName + '=' + token + '; Path=/; HttpOnly; SameSite=Lax; Max-Age=' + sessionLifetimeSeconds + secure);
}

export function clearSessionCookie(res: ServerResponse): void {
  const secure = config.cookieSecure ? '; Secure' : '';
  res.setHeader('Set-Cookie', cookieName + '=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0' + secure);
}

export async function login(usernameValue: unknown, passwordValue: unknown): Promise<{ token: string; session: SessionView } | null> {
  const username = typeof usernameValue === 'string' ? usernameValue.trim().toLowerCase() : '';
  const password = typeof passwordValue === 'string' ? passwordValue : '';
  if (!/^[a-z0-9._@+-]{1,120}$/.test(username) || password.length < 1 || password.length > 256) return null;

  const [rows] = await pool.execute<AuthRow[]>(
    `SELECT u.id AS user_id, u.username, u.display_name AS user_name, u.password_hash,
            t.id AS tenant_id, t.slug AS tenant_slug, t.display_name AS tenant_name
       FROM users u JOIN tenants t ON t.id = u.tenant_id
      WHERE u.username = ? LIMIT 1`,
    [username],
  );
  const row = rows[0];
  if (!row || !(await verifyPassword(password, row.password_hash || ''))) return null;

  const token = randomBytes(32).toString('base64url');
  const expires = new Date(Date.now() + sessionLifetimeSeconds * 1000);
  await pool.execute(
    'INSERT INTO sessions (token_hash, user_id, tenant_id, expires_at) VALUES (?, ?, ?, ?)',
    [sessionHash(token), row.user_id, row.tenant_id, expires],
  );
  return { token, session: sessionView(row) };
}

export async function sessionFromRequest(req: IncomingMessage): Promise<SessionView | null> {
  const token = cookieValue(req.headers.cookie, cookieName);
  if (!token) return null;
  const [rows] = await pool.execute<AuthRow[]>(
    `SELECT u.id AS user_id, u.username, u.display_name AS user_name,
            t.id AS tenant_id, t.slug AS tenant_slug, t.display_name AS tenant_name
       FROM sessions s
       JOIN users u ON u.id = s.user_id AND u.tenant_id = s.tenant_id
       JOIN tenants t ON t.id = s.tenant_id
      WHERE s.token_hash = ? AND s.expires_at > UTC_TIMESTAMP(3) LIMIT 1`,
    [sessionHash(token)],
  );
  return rows[0] ? sessionView(rows[0]) : null;
}

export async function logout(req: IncomingMessage): Promise<void> {
  const token = cookieValue(req.headers.cookie, cookieName);
  if (token) await pool.execute('DELETE FROM sessions WHERE token_hash = ?', [sessionHash(token)]);
}

export function parseSessionCookieForTest(header: string | undefined): string | null {
  return cookieValue(header, cookieName);
}
