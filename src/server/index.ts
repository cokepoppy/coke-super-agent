import { config } from './config.ts';
import { pool } from './db.ts';
import { migrate } from './migrate.ts';
import { listen } from './http.ts';

async function start(): Promise<void> {
  await migrate();
  const server = listen();
  const shutdown = () => {
    server.close(() => void pool.end().finally(() => process.exit(0)));
    setTimeout(() => process.exit(1), 5000).unref();
  };
  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);
}

start().catch(async error => {
  process.stderr.write('Coke Super Agent startup failed: ' + (error instanceof Error ? error.message : String(error)) + '\n');
  await pool.end();
  process.exitCode = 1;
});
