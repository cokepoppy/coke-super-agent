import { createHmac, timingSafeEqual } from 'node:crypto';
import { config } from './config.ts';

export interface AgentBridgeClaims {
  tenantId: string;
  runId: string;
  expiresAt: number;
}

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const tokenLifetimeMs = 2 * 60 * 60 * 1000;

function signingKey(): Buffer {
  const key = Buffer.from(config.tokenEncryptionKey, 'base64url');
  if (key.length !== 32 || key.toString('base64url') !== config.tokenEncryptionKey) {
    throw new Error('CSA_TOKEN_ENCRYPTION_KEY must be configured before issuing an Agent bridge token.');
  }
  return createHmac('sha256', key).update('coke-super-agent:docker-agent-bridge:v1').digest();
}

function signature(payload: string): Buffer {
  return createHmac('sha256', signingKey()).update(payload).digest();
}

export function createAgentBridgeToken(tenantId: string, runId: string, now = Date.now()): string {
  if (!uuid.test(tenantId) || !uuid.test(runId)) throw new Error('Agent bridge identity is invalid.');
  const claims: AgentBridgeClaims = { tenantId, runId, expiresAt: now + tokenLifetimeMs };
  const payload = Buffer.from(JSON.stringify(claims)).toString('base64url');
  return `${payload}.${signature(payload).toString('base64url')}`;
}

export function verifyAgentBridgeToken(token: string, now = Date.now()): AgentBridgeClaims | null {
  if (typeof token !== 'string' || token.length > 2048) return null;
  const [payload, encodedSignature, extra] = token.split('.');
  if (!payload || !encodedSignature || extra) return null;
  let supplied: Buffer;
  let expected: Buffer;
  try {
    supplied = Buffer.from(encodedSignature, 'base64url');
    expected = signature(payload);
  } catch { return null; }
  if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) return null;
  let value: unknown;
  try { value = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')); }
  catch { return null; }
  if (!value || typeof value !== 'object') return null;
  const claims = value as Partial<AgentBridgeClaims>;
  if (!uuid.test(String(claims.tenantId || '')) || !uuid.test(String(claims.runId || ''))
    || !Number.isSafeInteger(claims.expiresAt) || Number(claims.expiresAt) <= now
    || Number(claims.expiresAt) - now > tokenLifetimeMs) return null;
  return claims as AgentBridgeClaims;
}
