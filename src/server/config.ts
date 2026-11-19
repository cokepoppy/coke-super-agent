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
  cube: {
    apiUrl: process.env.CUBE_API_URL || '',
    apiKey: process.env.CUBE_API_KEY || '',
    templateId: process.env.CUBE_TEMPLATE_ID || '',
    proxyNodeIp: process.env.CUBE_PROXY_NODE_IP || '',
    proxyPort: positiveInt(process.env.CUBE_PROXY_PORT_HTTP, 80),
    proxyScheme: process.env.CUBE_PROXY_SCHEME || 'http',
    requestTimeoutMs: positiveInt(process.env.CUBE_REQUEST_TIMEOUT_MS, 30_000),
  },
};

if (!config.mysql.user || !config.mysql.password) {
  throw new Error('MYSQL_USER and MYSQL_PASSWORD are required. Copy .env.example to .env and set local database credentials.');
}
