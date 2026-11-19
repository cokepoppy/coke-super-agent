import 'dotenv/config';

function positiveInt(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
}

export const config = {
  host: process.env.CSA_HOST || '127.0.0.1',
  port: positiveInt(process.env.CSA_PORT, 8080),
  cookieSecure: process.env.CSA_COOKIE_SECURE === 'true' || (process.env.NODE_ENV === 'production' && process.env.CSA_COOKIE_SECURE !== 'false'),
  mysql: {
    host: process.env.MYSQL_HOST || '127.0.0.1',
    port: positiveInt(process.env.MYSQL_PORT, 3306),
    user: process.env.MYSQL_USER || '',
    password: process.env.MYSQL_PASSWORD || '',
    database: process.env.MYSQL_DATABASE || 'coke_super_agent',
  },
};

if (!config.mysql.user || !config.mysql.password) {
  throw new Error('MYSQL_USER and MYSQL_PASSWORD are required. Copy .env.example to .env and set local database credentials.');
}
