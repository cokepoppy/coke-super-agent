import { randomUUID } from 'node:crypto';
import type { RowDataPacket } from 'mysql2';
import { pool } from './db.ts';
import { hashPassword } from './password.ts';

interface TenantRow extends RowDataPacket { id: string }

async function ensureTenant(slug: string, name: string): Promise<string> {
  const id = randomUUID();
  await pool.execute('INSERT INTO tenants (id, slug, display_name) VALUES (?, ?, ?) ON DUPLICATE KEY UPDATE display_name = VALUES(display_name)', [id, slug, name]);
  const [rows] = await pool.execute<TenantRow[]>('SELECT id FROM tenants WHERE slug = ? LIMIT 1', [slug]);
  if (!rows[0]) throw new Error('Could not provision the requested test tenant.');
  return rows[0].id;
}

async function ensureUser(tenantId: string, username: string, displayName: string, passwordValue: string): Promise<void> {
  const passwordHash = await hashPassword(passwordValue);
  await pool.execute(
    'INSERT INTO users (id, tenant_id, username, display_name, password_hash) VALUES (?, ?, ?, ?, ?) ON DUPLICATE KEY UPDATE display_name = VALUES(display_name)',
    [randomUUID(), tenantId, username, displayName, passwordHash],
  );
  await pool.execute('INSERT IGNORE INTO computers (tenant_id) VALUES (?)', [tenantId]);
}

export async function seedLocalTenants(): Promise<void> {
  const alphaPassword = process.env.CSA_TEST_PASSWORD_ALPHA || '';
  const betaPassword = process.env.CSA_TEST_PASSWORD_BETA || '';
  if (alphaPassword.length < 10 || betaPassword.length < 10) {
    throw new Error('Set CSA_TEST_PASSWORD_ALPHA and CSA_TEST_PASSWORD_BETA to local passwords of at least 10 characters.');
  }
  const alphaId = await ensureTenant('alpha', 'Alpha Workspace');
  const betaId = await ensureTenant('beta', 'Beta Workspace');
  await ensureUser(alphaId, 'alice', 'Alice', alphaPassword);
  await ensureUser(betaId, 'bob', 'Bob', betaPassword);
}

if (process.argv[1]?.endsWith('/src/server/seed.ts')) {
  seedLocalTenants().then(async () => {
    process.stdout.write('Seeded the Alice and Bob local demo tenants.\n');
    await pool.end();
  }).catch(async error => {
    process.stderr.write('Local tenant seed failed: ' + (error instanceof Error ? error.message : String(error)) + '\n');
    await pool.end();
    process.exitCode = 1;
  });
}
