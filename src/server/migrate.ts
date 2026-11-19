import { readdir, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pool } from './db.ts';

export async function migrate(): Promise<void> {
  await pool.query(`CREATE TABLE IF NOT EXISTS schema_migrations (
    version INT UNSIGNED NOT NULL PRIMARY KEY,
    applied_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci`);

  const migrationDirectory = resolve(process.cwd(), 'migrations');
  const files = (await readdir(migrationDirectory))
    .filter(file => /^\d+_[a-z0-9_-]+\.sql$/i.test(file))
    .sort();

  for (const file of files) {
    const version = Number(file.match(/^\d+/)?.[0]);
    if (!Number.isSafeInteger(version) || version < 1) throw new Error(`Invalid migration filename: ${file}`);
    const [applied] = await pool.execute('SELECT version FROM schema_migrations WHERE version = ?', [version]);
    if (Array.isArray(applied) && applied.length > 0) continue;

    const sql = await readFile(resolve(migrationDirectory, file), 'utf8');
    const statements = sql.split(';').map(value => value.trim()).filter(Boolean);
    for (const statement of statements) await pool.query(statement);
    await pool.execute('INSERT INTO schema_migrations (version) VALUES (?)', [version]);
  }
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
