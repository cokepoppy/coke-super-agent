import 'dotenv/config';
import { homedir } from 'node:os';
import { join } from 'node:path';

const deepseekBaseUrl = (process.env.DEEPSEEK_BASE_URL || 'https://api.deepseek.com/anthropic').trim().replace(/\/+$/, '');
const piDeepseekBaseUrl = (process.env.CSA_PI_DEEPSEEK_BASE_URL || deepseekBaseUrl.replace(/\/anthropic$/i, '') || 'https://api.deepseek.com').trim().replace(/\/+$/, '');

function positiveInt(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
}

export const config = {
  host: process.env.CSA_HOST || '127.0.0.1',
  port: positiveInt(process.env.CSA_PORT, 8080),
  cookieSecure: process.env.CSA_COOKIE_SECURE === 'true' || (process.env.NODE_ENV === 'production' && process.env.CSA_COOKIE_SECURE !== 'false'),
  tokenEncryptionKey: process.env.CSA_TOKEN_ENCRYPTION_KEY || '',
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
    dshTemplateSnapshotId: process.env.CSA_CUBE_DSH_TEMPLATE_SNAPSHOT_ID || '',
    proxyNodeIp: process.env.CUBE_PROXY_NODE_IP || '',
    proxyPort: positiveInt(process.env.CUBE_PROXY_PORT_HTTP, 80),
    proxyScheme: process.env.CUBE_PROXY_SCHEME || 'http',
    sandboxDomain: process.env.CUBE_SANDBOX_DOMAIN || 'cube.app',
    requestTimeoutMs: positiveInt(process.env.CUBE_REQUEST_TIMEOUT_MS, 30_000),
    workspaceMode: process.env.CSA_CUBE_WORKSPACE_MODE || '',
    limaCommand: process.env.CSA_LIMACTL || join(homedir(), 'Library/Application Support/Coke Super Agent/lab/lima-2.3.0/bin/limactl'),
    limaHome: process.env.LIMA_HOME || join(homedir(), '.local/share/csa-cube-node/lima'),
  },
  docker: {
    executable: process.env.CSA_DOCKER_EXECUTABLE || 'docker',
    desktopImage: process.env.CSA_DOCKER_DESKTOP_IMAGE || 'csa-super-agent-desktop:20261127.9',
    desktopCpus: process.env.CSA_DOCKER_DESKTOP_CPUS || '2',
    desktopMemory: process.env.CSA_DOCKER_DESKTOP_MEMORY || '3g',
    desktopShmSize: process.env.CSA_DOCKER_DESKTOP_SHM_SIZE || '1g',
  },
  agent: {
    runtime: (process.env.CSA_AGENT_RUNTIME || 'dsh').trim().toLowerCase(),
    dshPlacement: (process.env.CSA_DSH_PLACEMENT || 'docker').trim().toLowerCase(),
    apiKey: process.env.DEEPSEEK_API_KEY || '',
    baseUrl: deepseekBaseUrl,
    piBaseUrl: piDeepseekBaseUrl,
    model: process.env.DSH_MODEL || '',
    npmHttpProxy: process.env.CSA_NPM_HTTP_PROXY || (process.platform === 'darwin' ? 'http://127.0.0.1:7890' : ''),
    desktopAptMirror: process.env.CSA_DESKTOP_APT_MIRROR || '',
    desktopResolution: process.env.CSA_DESKTOP_RESOLUTION || '1280x800',
  },
};

if (!config.mysql.user || !config.mysql.password) {
  throw new Error('MYSQL_USER and MYSQL_PASSWORD are required. Copy .env.example to .env and set local database credentials.');
}

if (config.agent.dshPlacement !== 'docker') {
  throw new Error('CSA_DSH_PLACEMENT must be docker. DSH inside a Cube microVM is disabled.');
}
