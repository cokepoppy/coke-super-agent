import { createReadStream } from 'node:fs';
import { access, stat } from 'node:fs/promises';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { extname, posix, resolve, sep } from 'node:path';
import { randomUUID } from 'node:crypto';
import { verifyAgentBridgeToken } from './agent-bridge-token.ts';
import { clearSessionCookie, login, logout, sessionFromRequest, setSessionCookie } from './auth.ts';
import { pool } from './db.ts';
import { config } from './config.ts';
import { runGuestPty, type GuestPtyStageEvent } from './runtime-bundle.ts';
import { createQueuedReplyRun, createQueuedRun, getRunDetail, listEventsAfter, listRecentActivity, listRuns, runExists } from './task-store.ts';
import { ComputerNotConfiguredError, ComputerNotReadyError, ComputerOperationError, ComputerRecoveryRequiredError, DesktopNotReadyError, connectTenantSandbox, getTenantBrowserState, getTenantComputer, retryTenantBrowser, startTenantComputer } from './computer.ts';
import { proxyDesktopHttp, proxyDesktopUpgrade } from './desktop-proxy.ts';
import { scheduleAgentRun } from './agent-runtime.ts';
import { listTaskArtifacts, taskArtifactAbsolutePath } from './artifacts.ts';
import type { SessionView } from '../shared/types.ts';

const bodyLimit = 32 * 1024;
const eventId = /^[1-9][0-9]*$/;

function writeHttpLog(stage: string, level: 'info' | 'warning' | 'error', details: Record<string, unknown>): void {
  process.stdout.write(JSON.stringify({ timestamp: new Date().toISOString(), logger: 'coke-super-agent.http', stage, level, ...details }) + '\n');
}

function safeHttpError(error: unknown): Record<string, string> {
  const value = error instanceof Error ? error : new Error(String(error));
  const secrets = [config.agent.apiKey, config.cube.apiKey].filter(Boolean);
  const redact = (text: string): string => secrets.reduce((result, secret) => result.split(secret).join('[redacted]'), text)
    .replace(/\b(Bearer|Basic)\s+[^\s"'`]+/gi, '$1 [redacted]')
    .replace(/\bsk-[A-Za-z0-9_-]{8,}\b/g, '[redacted-api-key]')
    .replace(/((?:api[_-]?key|token|password|secret|authorization)\s*[:=]\s*)[^\s,;]+/gi, '$1[redacted]')
    .replace(/(?:https?:\/\/)[^\s/@]+:[^\s/@]+@/gi, 'https://[redacted]@');
  const result: Record<string, string> = { errorName: value.name || 'Error', error: redact(value.message).slice(0, 1200) };
  if (value.stack) result.errorStack = redact(value.stack).slice(-4000);
  if (value.cause instanceof Error) {
    result.errorCause = redact(value.cause.message).slice(0, 1200);
    if (value.cause.stack) result.errorCauseStack = redact(value.cause.stack).slice(-2000);
  }
  return result;
}

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

async function readJson(req: IncomingMessage, maxBytes = bodyLimit): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of req) {
    const value = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += value.byteLength;
    if (total > maxBytes) throw new HttpError(413, '请求内容过大');
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

function requestIdFor(req: IncomingMessage): string {
  const edgeRequestId = req.headers['x-csa-edge-request-id'];
  return typeof edgeRequestId === 'string' && /^[a-f0-9]{32}$/i.test(edgeRequestId)
    ? edgeRequestId
    : randomUUID();
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
    '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
    '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.gif': 'image/gif',
    '.ico': 'image/x-icon', '.woff': 'font/woff', '.woff2': 'font/woff2', '.ttf': 'font/ttf', '.oga': 'audio/ogg', '.mp3': 'audio/mpeg', '.pdf': 'application/pdf', '.md': 'text/markdown; charset=utf-8',
    '.csv': 'text/csv; charset=utf-8', '.json': 'application/json; charset=utf-8',
  };
  return types[extension] || 'application/octet-stream';
}

function taskWorkspace(threadId: string): string {
  return posix.join('/workspace/tasks', threadId);
}

function attachmentDisposition(filename: string, disposition: 'attachment' | 'inline' = 'attachment'): string {
  const fallback = filename.replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 120) || 'download';
  const encoded = encodeURIComponent(filename).replace(/[!'()*]/g, character => '%' + character.charCodeAt(0).toString(16).toUpperCase());
  return `${disposition}; filename="${fallback}"; filename*=UTF-8''${encoded}`;
}

const maxArtifactDownloadBytes = 100 * 1024 * 1024;
const maxArtifactPreviewBytes = 25 * 1024 * 1024;

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
    const requestId = requestIdFor(req);
    let tenantId = '';
    res.setHeader('x-csa-request-id', requestId);
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

      if (method === 'POST' && url.pathname === '/api/internal/agent/terminal') {
        const authorization = req.headers.authorization || '';
        const tokenMatch = typeof authorization === 'string' ? authorization.match(/^Bearer ([A-Za-z0-9_.-]{40,2048})$/) : null;
        const claims = tokenMatch ? verifyAgentBridgeToken(tokenMatch[1]) : null;
        if (!claims) throw new HttpError(401, 'Agent bridge token 无效或已过期');
        const body = await readJson(req, 128 * 1024);
        const command = body.command;
        const cwd = body.cwd;
        const timeoutMs = body.timeoutMs;
        if (typeof command !== 'string' || !command.trim() || command.includes('\0') || Buffer.byteLength(command, 'utf8') > 64 * 1024) {
          throw new HttpError(400, '远端 Bash 命令无效');
        }
        if (typeof cwd !== 'string' || !cwd.startsWith('/') || cwd.includes('\0') || cwd.length > 4096) {
          throw new HttpError(400, '远端 Bash 工作目录无效');
        }
        if (!Number.isSafeInteger(timeoutMs) || Number(timeoutMs) < 60_000 || Number(timeoutMs) > 900_000) {
          throw new HttpError(400, '远端 Bash 超时参数无效');
        }
        const [runs] = await pool.execute<Array<{ tenant_id: string; status: string } & import('mysql2/promise').RowDataPacket>>(
          'SELECT tenant_id, status FROM runs WHERE id = ? LIMIT 1',
          [claims.runId],
        );
        if (!runs[0] || runs[0].tenant_id !== claims.tenantId) throw new HttpError(404, '任务不存在');
        if (runs[0].status !== 'working') throw new HttpError(409, '任务当前不接受终端操作');
        const startedAt = Date.now();
        let executionStage = 'cube.connect';
        let sandbox: Awaited<ReturnType<typeof connectTenantSandbox>> | undefined;
        writeHttpLog('agent.bridge.terminal.start', 'info', {
          requestId,
          tenantId: claims.tenantId,
          runId: claims.runId,
          transport: 'cube-pty',
          cwd,
          timeoutMs,
          commandBytes: Buffer.byteLength(command, 'utf8'),
        });
        try {
          sandbox = await connectTenantSandbox(claims.tenantId);
          const maxOutputBytes = 48 * 1024;
          executionStage = 'cube.pty.run';
          const logPtyStage = (event: GuestPtyStageEvent): void => {
            writeHttpLog(`agent.bridge.terminal.${event.stage}`, 'info', {
              requestId,
              tenantId: claims.tenantId,
              runId: claims.runId,
              transport: 'cube-pty',
              ...(event.details || {}),
            });
          };
          const result = await runGuestPty(sandbox, command, cwd, {}, undefined, Number(timeoutMs), maxOutputBytes, logPtyStage);
          const outputTruncated = result.outputTruncated;
          writeHttpLog('agent.bridge.terminal.complete', 'info', {
            requestId,
            tenantId: claims.tenantId,
            runId: claims.runId,
            transport: 'cube-pty',
            cwd,
            timeoutMs,
            commandBytes: Buffer.byteLength(command, 'utf8'),
            durationMs: Date.now() - startedAt,
            exitCode: result.exitCode,
            outputBytes: result.outputBytes,
            outputTruncated,
          });
          json(res, 200, {
            exitCode: result.exitCode,
            durationMs: Date.now() - startedAt,
            stdout: result.output,
            stderr: '',
            outputTruncated,
          });
        } catch (error) {
          writeHttpLog('agent.bridge.terminal.failed', 'error', {
            requestId,
            tenantId: claims.tenantId,
            runId: claims.runId,
            executionStage,
            transport: executionStage === 'cube.pty.run' ? 'cube-pty' : undefined,
            cwd,
            timeoutMs,
            commandBytes: Buffer.byteLength(command, 'utf8'),
            durationMs: Date.now() - startedAt,
            ...safeHttpError(error),
          });
          throw error;
        } finally { sandbox?.close(); }
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
      tenantId = session.tenant.id;
      if (method === 'GET' && url.pathname === '/api/computer') {
        json(res, 200, { computer: await getTenantComputer(session.tenant.id) });
        return;
      }

      if (method === 'GET' && url.pathname === '/api/computer/browser') {
        json(res, 200, { browserState: await getTenantBrowserState(session.tenant.id) });
        return;
      }

      if (method === 'POST' && url.pathname === '/api/computer/browser/retry') {
        requireSameOrigin(req);
        const queued = await retryTenantBrowser(session.tenant.id);
        writeHttpLog('computer.browser.retry', 'info', { requestId, tenantId, queued });
        json(res, queued ? 202 : 409, { queued });
        return;
      }

      if (method === 'POST' && url.pathname === '/api/computer/start') {
        requireSameOrigin(req);
        try {
          const computer = await startTenantComputer(session.tenant.id);
          writeHttpLog('computer.start.accepted', 'info', { requestId, tenantId, computerState: computer.state, desktopState: computer.desktopState });
          json(res, computer.state === 'creating' ? 202 : 200, { computer });
        } catch (error) {
          if (error instanceof ComputerNotConfiguredError) throw new HttpError(503, error.message);
          if (error instanceof ComputerRecoveryRequiredError) throw new HttpError(409, error.message);
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

      if (method === 'GET' && url.pathname === '/api/activity') {
        const rawLimit = url.searchParams.get('limit') || '50';
        if (!/^\d+$/.test(rawLimit)) throw new HttpError(400, '活动条数无效');
        const limit = Math.min(100, Math.max(1, Number(rawLimit)));
        const rawBefore = url.searchParams.get('before');
        let beforeId: number | null = null;
        if (rawBefore !== null) {
          if (!eventId.test(rawBefore) || !Number.isSafeInteger(Number(rawBefore))) throw new HttpError(400, '活动游标无效');
          beforeId = Number(rawBefore);
        }
        const rawDebug = url.searchParams.get('debug');
        if (rawDebug !== null && rawDebug !== '0' && rawDebug !== '1') throw new HttpError(400, '调试模式参数无效');
        const page = await listRecentActivity(session.tenant.id, beforeId, limit, rawDebug === '1');
        json(res, 200, page);
        return;
      }

      if (method === 'POST' && url.pathname === '/api/tasks') {
        requireSameOrigin(req);
        const body = await readJson(req);
        const task = await createQueuedRun(session.tenant.id, body.prompt);
        writeHttpLog('task.queued', 'info', { requestId, tenantId, runId: task.id, threadId: task.threadId });
        scheduleAgentRun(session.tenant.id);
        json(res, 201, { task });
        return;
      }

      const artifactListRunId = routeRunId(url.pathname, '/artifacts');
      if (method === 'GET' && artifactListRunId) {
        const task = await getRunDetail(session.tenant.id, artifactListRunId);
        if (!task) throw new HttpError(404, '任务不存在');
        const sandbox = await connectTenantSandbox(session.tenant.id);
        try {
          const root = taskWorkspace(task.threadId);
          const artifacts = await sandbox.files.exists(root) ? await listTaskArtifacts(sandbox.files, root) : [];
          json(res, 200, { artifacts });
        } finally { sandbox.close(); }
        return;
      }

      const artifactDownloadRunId = routeRunId(url.pathname, '/artifacts/download');
      if (method === 'GET' && artifactDownloadRunId) {
        const task = await getRunDetail(session.tenant.id, artifactDownloadRunId);
        if (!task) throw new HttpError(404, '任务不存在');
        const relativePath = url.searchParams.get('path') || '';
        const mode = url.searchParams.get('mode') || 'download';
        if (mode !== 'download' && mode !== 'preview') throw new HttpError(400, '文件访问模式无效');
        const root = taskWorkspace(task.threadId);
        const absolutePath = taskArtifactAbsolutePath(root, relativePath);
        if (!absolutePath) throw new HttpError(400, '文件路径无效');
        const sandbox = await connectTenantSandbox(session.tenant.id);
        try {
          const artifactListStartedAt = Date.now();
          const artifacts = await sandbox.files.exists(root) ? await listTaskArtifacts(sandbox.files, root) : [];
          const artifact = artifacts.find(item => item.path === relativePath);
          writeHttpLog('artifact.download.list.complete', 'info', {
            requestId, tenantId, runId: artifactDownloadRunId,
            artifactCount: artifacts.length, artifactFound: Boolean(artifact),
            durationMs: Date.now() - artifactListStartedAt,
          });
          if (!artifact) throw new HttpError(404, '任务文件不存在');
          if (mode === 'preview' && !artifact.previewable) throw new HttpError(415, '该文件暂不支持预览');
          const artifactStatStartedAt = Date.now();
          const metadata = await sandbox.files.stat(absolutePath);
          const fileType = String(metadata.type || '').toUpperCase();
          writeHttpLog('artifact.download.stat.complete', fileType === 'FILE_TYPE_FILE' ? 'info' : 'warning', {
            requestId, tenantId, runId: artifactDownloadRunId,
            fileType: fileType || 'unknown',
            durationMs: Date.now() - artifactStatStartedAt,
          });
          if (fileType !== 'FILE_TYPE_FILE') throw new HttpError(404, '任务文件不存在');
          const size = Number(metadata.size ?? artifact.sizeBytes);
          if (!Number.isSafeInteger(size) || size < 0) throw new HttpError(404, '任务文件不可读取');
          if (size > maxArtifactDownloadBytes) throw new HttpError(413, '文件超过 100 MiB，暂不支持直接下载');
          if (mode === 'preview' && size > maxArtifactPreviewBytes) throw new HttpError(413, '文件超过 25 MiB，暂不支持预览');
          if (String(metadata.type || '').toUpperCase().includes('DIRECTORY')) throw new HttpError(404, '任务文件不存在');
          const source = await sandbox.files.read(absolutePath, { format: 'stream' });
          const filename = posix.basename(relativePath);
          const headers: Record<string, string> = {
            'content-type': artifact.mediaType.startsWith('text/') || artifact.mediaType === 'application/json' ? `${artifact.mediaType}; charset=utf-8` : artifact.mediaType,
            'content-length': String(size),
            'content-disposition': attachmentDisposition(filename, mode === 'preview' ? 'inline' : 'attachment'),
            'cache-control': 'private, no-store',
            'x-content-type-options': 'nosniff',
          };
          if (mode === 'preview' && artifact.mediaType === 'text/html') {
            headers['content-security-policy'] = "sandbox allow-scripts; default-src 'none'; script-src 'unsafe-inline' blob: data:; style-src 'unsafe-inline' blob: data:; img-src data: blob:; font-src data: blob:; media-src data: blob:; connect-src 'none'; frame-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'";
          }
          writeHttpLog('artifact.download.read.start', 'info', {
            requestId, tenantId, runId: artifactDownloadRunId, mode, mediaType: artifact.mediaType, sizeBytes: size,
          });
          res.writeHead(200, {
            ...headers,
          });
          await pipeline(Readable.fromWeb(source as import('node:stream/web').ReadableStream<Uint8Array>), res);
          writeHttpLog('artifact.download.complete', 'info', {
            requestId, tenantId, runId: artifactDownloadRunId, mode, sizeBytes: size,
          });
        } finally { sandbox.close(); }
        return;
      }

      const replyRunId = routeRunId(url.pathname, '/reply');
      if (method === 'POST' && replyRunId) {
        requireSameOrigin(req);
        const body = await readJson(req);
        const task = await createQueuedReplyRun(session.tenant.id, replyRunId, body.prompt);
        writeHttpLog('task.reply.queued', 'info', { requestId, tenantId, runId: task.id, threadId: task.threadId, previousRunId: replyRunId });
        scheduleAgentRun(session.tenant.id);
        json(res, 201, { task });
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
      const errorInfo = safeHttpError(error);
      let failureStatus = error instanceof HttpError ? error.status
        : error instanceof ComputerNotReadyError ? 409
          : error instanceof ComputerNotConfiguredError ? 503
            : 500;
      const initialMessage = error instanceof Error ? error.message : String(error);
      if (initialMessage.startsWith('Task must contain')) failureStatus = 400;
      else if (initialMessage.startsWith('Task cannot be continued')) failureStatus = 409;
      writeHttpLog('request.failed', failureStatus >= 500 ? 'error' : 'warning', {
        requestId,
        tenantId: tenantId || undefined,
        method,
        path: url.pathname,
        status: failureStatus,
        responseStarted: res.headersSent,
        ...errorInfo,
      });
      if (res.headersSent) { res.end(); return; }
      if (error instanceof HttpError) { json(res, error.status, { error: error.message }); return; }
      if (error instanceof ComputerNotReadyError) { json(res, 409, { error: error.message }); return; }
      if (error instanceof ComputerNotConfiguredError) { json(res, 503, { error: error.message }); return; }
      const message = error instanceof Error ? error.message : String(error);
      if (message.startsWith('Task must contain')) { json(res, 400, { error: '请输入 1 到 10000 个字符的任务内容' }); return; }
      if (message.startsWith('Task cannot be continued')) { json(res, 409, { error: '该任务仍在运行，或已无法继续。请刷新任务状态后重试。' }); return; }
      json(res, 500, { error: '服务暂时不可用' });
    }
  });

  server.on('upgrade', (req, socket, head) => {
    const requestId = requestIdFor(req);
    let tenantId = '';
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
      tenantId = session.tenant.id;
      writeHttpLog('desktop.upgrade.start', 'info', { requestId, tenantId, path: url.pathname });
      await proxyDesktopUpgrade(req, socket, head, session.tenant.id, url.pathname, url.search);
    })().catch(error => {
      const status = error instanceof HttpError ? error.status : error instanceof DesktopNotReadyError ? 409 : 502;
      writeHttpLog('desktop.upgrade.failed', status >= 500 ? 'error' : 'warning', { requestId, tenantId: tenantId || undefined, status, ...safeHttpError(error) });
      const message = status === 401 ? 'Unauthorized' : status === 403 ? 'Forbidden' : status === 404 ? 'Not Found' : status === 409 ? 'Conflict' : 'Bad Gateway';
      if (!socket.destroyed) socket.end(`HTTP/1.1 ${status} ${message}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
    });
  });

  return server;
}

export function listen(): ReturnType<typeof createHttpServer> {
  const server = createHttpServer();
  server.listen(config.port, config.host, () => {
    writeHttpLog('server.listening', 'info', { host: config.host, port: config.port });
  });
  return server;
}
