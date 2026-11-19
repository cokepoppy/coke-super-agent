import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pool } from './db.ts';

export async function migrate(): Promise<void> {
  await pool.query(`CREATE TABLE IF NOT EXISTS schema_migrations (
    version INT UNSIGNED NOT NULL PRIMARY KEY,
    applied_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci`);

  const [applied] = await pool.execute('SELECT version FROM schema_migrations WHERE version = 1');
  if (Array.isArray(applied) && applied.length > 0) return;

  const sql = await readFile(resolve(process.cwd(), 'migrations/001_initial.sql'), 'utf8');
  const statements = sql.split(';').map(value => value.trim()).filter(Boolean);
  for (const statement of statements) await pool.query(statement);
  await pool.execute('INSERT IGNORE INTO schema_migrations (version) VALUES (1)');
}

if (process.argv[1] && resolve(process.argv[1]) === resolve('src/server/migrate.ts')) {
  migrate().then(async () => {
    process.stdout.write('Database schema is ready.\n');
    await pool.end();
  }).catch(async error => {
    process.stderr.write('Database migration failed: ' + (error instanceof Error ? error.message : String(error)) + '\n');
    await pool.end();
    process.exitCode = 1;
  });
}
