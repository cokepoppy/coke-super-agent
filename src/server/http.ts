import { createReadStream } from 'node:fs';
import { access, stat } from 'node:fs/promises';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { extname, resolve, sep } from 'node:path';
import { clearSessionCookie, login, logout, sessionFromRequest, setSessionCookie } from './auth.ts';
import { pool } from './db.ts';
import { config } from './config.ts';
import { createQueuedRun, getRunDetail, listEventsAfter, listRuns, runExists } from './task-store.ts';
import { ComputerNotConfiguredError, ComputerOperationError, DesktopNotReadyError, getTenantComputer, startTenantComputer } from './computer.ts';
import { proxyDesktopHttp, proxyDesktopUpgrade } from './desktop-proxy.ts';
import type { SessionView } from '../shared/types.ts';

const bodyLimit = 32 * 1024;
const eventId = /^[1-9][0-9]*$/;

function json(res: ServerResponse, status: number, payload: unknown): void {
  const body = Buffer.from(JSON.stringify(payload));
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': body.byteLength,
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
    'referrer-policy': 'same-origin',
  });
  res.end(body);
}

async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of req) {
    const value = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += value.byteLength;
    if (total > bodyLimit) throw new HttpError(413, '请求内容过大');
    chunks.push(value);
  }
  if (total === 0) return {};
  let value: unknown;
  try { value = JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { throw new HttpError(400, 'JSON 格式无效'); }
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new HttpError(400, '请求内容必须是 JSON 对象');
  return value as Record<string, unknown>;
}

class HttpError extends Error {
  constructor(public readonly status: number, message: string) { super(message); }
}

function requestIsSameOrigin(req: IncomingMessage): boolean {
  const origin = req.headers.origin;
  if (typeof origin !== 'string') return false;
  const forwardedHost = req.headers['x-forwarded-host'];
  const forwardedProto = req.headers['x-forwarded-proto'];
  const host = (Array.isArray(forwardedHost) ? forwardedHost[0] : forwardedHost) || req.headers.host;
  const proto = (Array.isArray(forwardedProto) ? forwardedProto[0] : forwardedProto) || 'http';
  if (!host || !['http', 'https'].includes(proto)) return false;
  try { return new URL(origin).origin === proto + '://' + host.split(',')[0].trim(); }
  catch { return false; }
}

function requireSameOrigin(req: IncomingMessage): void {
  if (!requestIsSameOrigin(req)) throw new HttpError(403, '请求来源无效');
}

function requireSession(session: SessionView | null): SessionView {
  if (!session) throw new HttpError(401, '请先登录');
  return session;
}

function routeRunId(pathname: string, suffix = ''): string | null {
  const expression = new RegExp('^/api/tasks/([^/]+)' + suffix + '$');
  const match = pathname.match(expression);
  if (!match) return null;
  try { return decodeURIComponent(match[1]); }
  catch { return null; }
}

function streamEvents(req: IncomingMessage, res: ServerResponse, session: SessionView, runId: string, after: number): void {
  res.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-cache, no-transform',
    connection: 'keep-alive',
    'x-accel-buffering': 'no',
    'x-content-type-options': 'nosniff',
  });
  res.write('retry: 1500\n\n');
  let cursor = after;
  let polling = false;
  const poll = async () => {
    if (polling || res.destroyed || res.writableEnded) return;
    polling = true;
    try {
      const events = await listEventsAfter(session.tenant.id, runId, cursor);
      for (const event of events) {
        cursor = event.id;
        res.write('id: ' + event.id + '\nevent: run_event\ndata: ' + JSON.stringify(event) + '\n\n');
      }
      if (events.length === 0) res.write(': ping\n\n');
    } catch {
      res.write('event: stream_error\ndata: {"error":"事件暂时无法读取"}\n\n');
      res.end();
      clearInterval(interval);
      clearTimeout(lifetime);
    } finally { polling = false; }
  };
  const interval = setInterval(() => void poll(), 1000);
  const lifetime = setTimeout(() => res.end(), 15 * 60 * 1000);
  res.on('close', () => { clearInterval(interval); clearTimeout(lifetime); });
  req.on('aborted', () => { clearInterval(interval); clearTimeout(lifetime); });
  void poll();
}

function contentType(pathname: string): string {
  const extension = extname(pathname).toLowerCase();
  const types: Record<string, string> = {
    '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
    '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.woff2': 'font/woff2', '.json': 'application/json; charset=utf-8',
  };
  return types[extension] || 'application/octet-stream';
}

async function serveStatic(pathname: string, res: ServerResponse): Promise<boolean> {
  const root = resolve(process.cwd(), 'dist');
  const requested = pathname === '/' ? '/index.html' : pathname;
  let file = resolve(root, '.' + requested);
  if (file !== root && !file.startsWith(root + sep)) return false;
  try { await access(file); }
  catch {
    file = resolve(root, 'index.html');
    try { await access(file); } catch { return false; }
  }
  const info = await stat(file);
  if (!info.isFile()) return false;
  res.writeHead(200, { 'content-type': contentType(file), 'content-length': info.size, 'cache-control': file.endsWith('index.html') ? 'no-cache' : 'public, max-age=31536000, immutable', 'x-content-type-options': 'nosniff' });
  createReadStream(file).pipe(res);
  return true;
}

export function createHttpServer() {
  const server = createServer(async (req, res) => {
    const method = req.method || 'GET';
    let url: URL;
    try { url = new URL(req.url || '/', 'http://localhost'); }
    catch { json(res, 400, { error: '请求路径无效' }); return; }

    try {
      if (method === 'GET' && url.pathname === '/health') {
        await pool.query('SELECT 1');
        json(res, 200, { status: 'ok', database: 'ok' });
        return;
      }

      if (method === 'POST' && url.pathname === '/api/auth/login') {
        requireSameOrigin(req);
        const body = await readJson(req);
        const result = await login(body.username, body.password);
        if (!result) throw new HttpError(401, '账号或密码不正确');
        setSessionCookie(res, result.token);
        json(res, 200, { session: result.session });
        return;
      }

      if (method === 'GET' && url.pathname === '/api/auth/session') {
        const session = await sessionFromRequest(req);
        if (!session) throw new HttpError(401, '请先登录');
        json(res, 200, { session });
        return;
      }

      if (method === 'POST' && url.pathname === '/api/auth/logout') {
        requireSameOrigin(req);
        await logout(req);
        clearSessionCookie(res);
        json(res, 200, { ok: true });
        return;
      }

      const session = requireSession(await sessionFromRequest(req));
      if (method === 'GET' && url.pathname === '/api/computer') {
        json(res, 200, { computer: await getTenantComputer(session.tenant.id) });
        return;
      }

      if (method === 'POST' && url.pathname === '/api/computer/start') {
        requireSameOrigin(req);
        try {
          const computer = await startTenantComputer(session.tenant.id);
          json(res, computer.state === 'creating' ? 202 : 200, { computer });
        } catch (error) {
          if (error instanceof ComputerNotConfiguredError) throw new HttpError(503, error.message);
          if (error instanceof ComputerOperationError) throw new HttpError(502, error.message);
          throw error;
        }
        return;
      }

      if (url.pathname.startsWith('/api/computer/desktop/')) {
        await proxyDesktopHttp(req, res, session.tenant.id, url.pathname, url.search);
        return;
      }

      if (method === 'GET' && url.pathname === '/api/tasks') {
        json(res, 200, { tasks: await listRuns(session.tenant.id) });
        return;
      }

      if (method === 'POST' && url.pathname === '/api/tasks') {
        requireSameOrigin(req);
        const body = await readJson(req);
        json(res, 201, { task: await createQueuedRun(session.tenant.id, body.prompt) });
        return;
      }

      const eventsRunId = routeRunId(url.pathname, '/events');
      if (method === 'GET' && eventsRunId) {
        if (!(await runExists(session.tenant.id, eventsRunId))) throw new HttpError(404, '任务不存在');
        const header = req.headers['last-event-id'];
        const queryAfter = url.searchParams.get('after');
        const rawAfter = typeof header === 'string' && eventId.test(header) ? header : queryAfter || '0';
        const after = eventId.test(rawAfter) ? Number(rawAfter) : 0;
        streamEvents(req, res, session, eventsRunId, Number.isSafeInteger(after) ? after : 0);
        return;
      }

      const runId = routeRunId(url.pathname);
      if (method === 'GET' && runId) {
        const task = await getRunDetail(session.tenant.id, runId);
        if (!task) throw new HttpError(404, '任务不存在');
        json(res, 200, { task });
        return;
      }

      if (url.pathname.startsWith('/api/')) throw new HttpError(404, '接口不存在');
      if (method === 'GET' && await serveStatic(url.pathname, res)) return;
      json(res, 404, { error: '页面不存在' });
    } catch (error) {
      if (res.headersSent) { res.end(); return; }
      if (error instanceof HttpError) { json(res, error.status, { error: error.message }); return; }
      const message = error instanceof Error ? error.message : String(error);
      if (message.startsWith('Task must contain')) { json(res, 400, { error: '请输入 1 到 10000 个字符的任务内容' }); return; }
      process.stderr.write('Request failed: ' + message.slice(0, 400) + '\n');
      json(res, 500, { error: '服务暂时不可用' });
    }
  });

  server.on('upgrade', (req, socket, head) => {
    void (async () => {
      let url: URL;
      try { url = new URL(req.url || '/', 'http://localhost'); }
      catch { socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\nContent-Length: 0\r\n\r\n'); return; }
      if (!url.pathname.startsWith('/api/computer/desktop/')) {
        socket.end('HTTP/1.1 404 Not Found\r\nConnection: close\r\nContent-Length: 0\r\n\r\n');
        return;
      }
      if (!requestIsSameOrigin(req)) {
        socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\nContent-Length: 0\r\n\r\n');
        return;
      }
      const session = requireSession(await sessionFromRequest(req));
      await proxyDesktopUpgrade(req, socket, head, session.tenant.id, url.pathname, url.search);
    })().catch(error => {
      const status = error instanceof HttpError ? error.status : error instanceof DesktopNotReadyError ? 409 : 502;
      const message = status === 401 ? 'Unauthorized' : status === 403 ? 'Forbidden' : status === 404 ? 'Not Found' : status === 409 ? 'Conflict' : 'Bad Gateway';
      if (!socket.destroyed) socket.end(`HTTP/1.1 ${status} ${message}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
    });
  });

  return server;
}

export function listen(): ReturnType<typeof createHttpServer> {
  const server = createHttpServer();
  server.listen(config.port, config.host, () => {
    process.stdout.write('Coke Super Agent listening on http://' + config.host + ':' + config.port + '\n');
  });
  return server;
}
