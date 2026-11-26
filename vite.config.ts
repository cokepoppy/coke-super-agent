import 'dotenv/config';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

function publicBasePath(value: string | undefined): string {
  const raw = (value || '/').trim();
  const segments = raw.split('/').filter(Boolean);
  if (segments.some(segment => segment === '.' || segment === '..' || !/^[A-Za-z0-9._~-]+$/.test(segment))) {
    throw new Error('CSA_PUBLIC_BASE_PATH must be / or a URL path such as /super-agent/.');
  }
  return segments.length ? `/${segments.join('/')}/` : '/';
}

const base = publicBasePath(process.env.CSA_PUBLIC_BASE_PATH);
const prefix = base === '/' ? '' : base.slice(0, -1);
const stripPrefix = (path: string) => prefix && path.startsWith(prefix) ? path.slice(prefix.length) || '/' : path;
const apiProxy = {
  target: 'http://127.0.0.1:8080',
  changeOrigin: false,
  ws: true,
  rewrite: stripPrefix,
};
const proxy = prefix
  ? {
      [`${prefix}/api`]: apiProxy,
      [`${prefix}/novnc`]: apiProxy,
      [`${prefix}/health`]: apiProxy,
    }
  : {
      '/api': apiProxy,
      '/novnc': apiProxy,
      '/health': apiProxy,
    };

export default defineConfig({
  base,
  plugins: [react()],
  server: {
    host: '127.0.0.1',
    port: 5173,
    strictPort: true,
    proxy,
  },
  preview: {
    host: '127.0.0.1',
    port: 5173,
    strictPort: true,
    proxy,
    allowedHosts: ['codex.cokeagent.com'],
  },
});
