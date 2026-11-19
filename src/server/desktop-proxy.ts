import { request as httpRequest, type IncomingMessage, type ServerResponse } from 'node:http';
import type { Duplex } from 'node:stream';
import { request as httpsRequest } from 'node:https';
import { Sandbox } from '@cubesandbox/sdk';
import { config } from './config.ts';
import { cubeConfig, DesktopNotReadyError, getTenantDesktopCredential } from './computer.ts';

const routePrefix = '/api/computer/desktop/';
const sandboxHosts = new Map<string, Promise<string>>();
const allowedRequestHeaders = new Set([
  'accept', 'accept-encoding', 'accept-language', 'cache-control', 'if-modified-since', 'if-none-match',
  'pragma', 'range', 'user-agent', 'sec-websocket-key', 'sec-websocket-version', 'sec-websocket-protocol',
  'sec-websocket-extensions', 'connection', 'upgrade',
]);

function pathForUpstream(pathname: string, search: string): string {
  if (!pathname.startsWith(routePrefix)) throw new Error('Desktop route is invalid.');
  const relative = pathname.slice(routePrefix.length);
  let decoded: string;
  try { decoded = decodeURIComponent(relative); }
  catch { throw new Error('Desktop route encoding is invalid.'); }
  if (decoded.includes('\0') || decoded.includes('\\') || decoded.split('/').some(part => part === '..' || part === '.')) {
    throw new Error('Desktop route path is invalid.');
  }
  return '/' + relative + search;
}

async function hostForSandbox(sandboxId: string): Promise<string> {
  if (!/^[A-Za-z0-9_-]{1,96}$/.test(sandboxId)) throw new Error('CubeSandbox returned an invalid sandbox ID.');
  let pending = sandboxHosts.get(sandboxId);
  if (!pending) {
    pending = Sandbox.connect(sandboxId, { config: cubeConfig() }).then(sandbox => {
      try { return sandbox.getHost(6080); }
      finally { sandbox.close(); }
    }).catch(error => {
      sandboxHosts.delete(sandboxId);
      throw error;
    });
    sandboxHosts.set(sandboxId, pending);
  }
  return pending;
}

async function desktopTarget(tenantId: string): Promise<{ hostname: string; hostHeader: string; port: number; protocol: 'http:' | 'https:'; trafficToken: string }> {
  const { sandboxId, trafficToken } = await getTenantDesktopCredential(tenantId);
  const hostHeader = await hostForSandbox(sandboxId);
  const protocol = config.cube.proxyScheme === 'https' ? 'https:' : 'http:';
  const hostname = config.cube.proxyNodeIp;
  if (!hostname) throw new Error('CubeProxy is not configured.');
  return { hostname, hostHeader, port: config.cube.proxyPort, protocol, trafficToken };
}

function forwardedHeaders(req: IncomingMessage, hostHeader: string, trafficToken: string, websocket = false): Record<string, string | string[]> {
  const headers: Record<string, string | string[]> = {
    host: hostHeader,
    'e2b-traffic-access-token': trafficToken,
    'cube-traffic-access-token': trafficToken,
  };
  for (const [name, value] of Object.entries(req.headers)) {
    if (typeof value === 'undefined' || name === 'host' || name === 'cookie' || name === 'authorization' || name === 'origin') continue;
    if (!allowedRequestHeaders.has(name)) continue;
    if (websocket || (name !== 'connection' && name !== 'upgrade' && !name.startsWith('sec-websocket-'))) headers[name] = value;
  }
  if (websocket) {
    headers.connection = 'Upgrade';
    headers.upgrade = 'websocket';
  }
  return headers;
}

function sendProxyError(res: ServerResponse, status: number, message: string): void {
  if (res.destroyed || res.writableEnded) return;
  const body = Buffer.from(JSON.stringify({ error: message }));
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'content-length': body.length, 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' });
  res.end(body);
}

export async function proxyDesktopHttp(req: IncomingMessage, res: ServerResponse, tenantId: string, pathname: string, search: string): Promise<void> {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    sendProxyError(res, 405, '桌面资源只接受 GET 请求');
    return;
  }

  let target: Awaited<ReturnType<typeof desktopTarget>>;
  let upstreamPath: string;
  try {
    target = await desktopTarget(tenantId);
    upstreamPath = pathForUpstream(pathname, search);
  } catch (error) {
    if (error instanceof DesktopNotReadyError) sendProxyError(res, 409, error.message);
    else sendProxyError(res, 502, '桌面连接暂时不可用');
    return;
  }

  await new Promise<void>(resolve => {
    const onResponse = (upstream: IncomingMessage) => {
      const headers = { ...upstream.headers };
      delete headers['set-cookie'];
      res.writeHead(upstream.statusCode || 502, headers);
      upstream.on('end', resolve);
      upstream.on('error', () => { if (!res.destroyed) res.destroy(); resolve(); });
      upstream.pipe(res);
    };
    const options = {
      hostname: target.hostname,
      port: target.port,
      method: req.method,
      path: upstreamPath,
      headers: forwardedHeaders(req, target.hostHeader, target.trafficToken),
      agent: false,
      timeout: 30_000,
    };
    const upstreamRequest = target.protocol === 'https:'
      ? httpsRequest({ ...options, servername: target.hostHeader }, onResponse)
      : httpRequest(options, onResponse);
    const finishWithError = () => {
      if (!res.headersSent) sendProxyError(res, 502, '桌面资源暂时不可用');
      else if (!res.destroyed) res.destroy();
      resolve();
    };
    upstreamRequest.on('error', finishWithError);
    upstreamRequest.on('timeout', () => upstreamRequest.destroy(new Error('CubeProxy request timed out.')));
    res.on('close', () => { if (!res.writableEnded) upstreamRequest.destroy(); resolve(); });
    upstreamRequest.end();
  });
}

export async function proxyDesktopUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer, tenantId: string, pathname: string, search: string): Promise<void> {
  const target = await desktopTarget(tenantId);
  const upstreamPath = pathForUpstream(pathname, search);
  const options = {
    hostname: target.hostname,
    port: target.port,
    method: 'GET',
    path: upstreamPath,
    headers: forwardedHeaders(req, target.hostHeader, target.trafficToken, true),
    agent: false,
    timeout: 30_000,
  };
  const upstreamRequest = target.protocol === 'https:'
    ? httpsRequest({ ...options, servername: target.hostHeader })
    : httpRequest(options);

  upstreamRequest.on('upgrade', (upstreamResponse, upstreamSocket, upstreamHead) => {
    const statusLine = `HTTP/1.1 ${upstreamResponse.statusCode || 101} ${upstreamResponse.statusMessage || 'Switching Protocols'}\r\n`;
    const headers = Array.from({ length: upstreamResponse.rawHeaders.length / 2 }, (_, index) =>
      `${upstreamResponse.rawHeaders[index * 2]}: ${upstreamResponse.rawHeaders[index * 2 + 1]}\r\n`).join('');
    socket.write(statusLine + headers + '\r\n');
    if (upstreamHead.length) socket.write(upstreamHead);
    if (head.length) upstreamSocket.write(head);
    socket.pipe(upstreamSocket);
    upstreamSocket.pipe(socket);
    socket.on('error', () => upstreamSocket.destroy());
    socket.on('close', () => upstreamSocket.destroy());
    upstreamSocket.on('error', () => socket.destroy());
  });
  upstreamRequest.on('response', upstreamResponse => {
    const body = Buffer.from('Desktop WebSocket upgrade failed.');
    socket.end(`HTTP/1.1 ${upstreamResponse.statusCode || 502} ${upstreamResponse.statusMessage || 'Bad Gateway'}\r\nConnection: close\r\nContent-Length: ${body.length}\r\nContent-Type: text/plain; charset=utf-8\r\n\r\n${body.toString()}`);
    upstreamResponse.resume();
  });
  upstreamRequest.on('error', () => {
    if (!socket.destroyed) socket.end('HTTP/1.1 502 Bad Gateway\r\nConnection: close\r\nContent-Length: 0\r\n\r\n');
  });
  upstreamRequest.on('timeout', () => upstreamRequest.destroy(new Error('CubeProxy WebSocket upgrade timed out.')));
  socket.on('close', () => upstreamRequest.destroy());
  upstreamRequest.end();
}
