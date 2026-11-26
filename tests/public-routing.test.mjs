import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const vite = readFileSync(new URL('../vite.config.ts', import.meta.url), 'utf8');
const web = readFileSync(new URL('../src/web/main.tsx', import.meta.url), 'utf8');
const nginx = readFileSync(new URL('../deploy/vps/super-agent.locations.conf', import.meta.url), 'utf8');
const nginxLog = readFileSync(new URL('../deploy/vps/super-agent.log-format.conf', import.meta.url), 'utf8');
const tunnel = readFileSync(new URL('../scripts/vps/super-agent-reverse-tunnel.sh', import.meta.url), 'utf8');
const launchdTunnel = readFileSync(new URL('../deploy/macos/com.coke.super-agent.public-tunnel.plist', import.meta.url), 'utf8');

test('frontend base path proxies API, noVNC and health to the local TypeScript server', () => {
  assert.match(vite, /base,\s*plugins:/);
  assert.match(vite, /preview:\s*\{[\s\S]*?proxy,/);
  assert.match(vite, /allowedHosts:\s*\['codex\.cokeagent\.com'\]/);
  assert.match(vite, /\[\`\$\{prefix\}\/api\`\]: apiProxy/);
  assert.match(vite, /\[\`\$\{prefix\}\/novnc\`\]: apiProxy/);
  assert.match(vite, /rewrite: stripPrefix/);
  assert.match(web, /function appPath\(path: string\)/);
  assert.match(web, /new EventSource\(appPath\(/);
  assert.match(web, /appPath\('\/novnc\/vnc\.html/);
});

test('VPS Nginx fragment preserves SSE and WebSocket traffic on the dedicated loopback tunnel', () => {
  assert.match(nginx, /location \^~ \/super-agent\//);
  assert.match(nginx, /proxy_pass http:\/\/127\.0\.0\.1:14331;/);
  assert.match(nginx, /proxy_set_header Upgrade \$http_upgrade;/);
  assert.match(nginx, /proxy_set_header Connection "upgrade";/);
  assert.match(nginx, /proxy_buffering off;/);
  assert.match(nginx, /proxy_request_buffering off;/);
  assert.match(nginx, /X-Forwarded-Prefix \/super-agent/);
  assert.match(nginx, /access_log \/var\/log\/nginx\/coke-super-agent\.access\.log super_agent;/);
  assert.match(nginx, /X-Csa-Edge-Request-Id \$request_id/);
  assert.match(nginxLog, /log_format super_agent escape=json/);
  assert.match(nginxLog, /"uri":"\$uri"/);
  assert.doesNotMatch(nginxLog, /\$request\b|\$args\b/);
  assert.doesNotMatch(nginx, /proxy_pass http:\/\/0\.0\.0\.0/);
});

test('Mac tunnel binds only the VPS loopback and forwards one local frontend port', () => {
  assert.match(tunnel, /-R "127\.0\.0\.1:\$\{remote_port\}:127\.0\.0\.1:\$\{local_port\}"/);
  assert.match(tunnel, /ExitOnForwardFailure=yes/);
  assert.match(tunnel, /ServerAliveInterval=30/);
  assert.doesNotMatch(tunnel, /-R "0\.0\.0\.0:/);
  assert.match(launchdTunnel, /127\.0\.0\.1:14331:127\.0\.0\.1:5174/);
  assert.match(launchdTunnel, /StrictHostKeyChecking=yes/);
});
