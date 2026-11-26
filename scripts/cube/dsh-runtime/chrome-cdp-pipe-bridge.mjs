import { randomUUID } from 'node:crypto';
import { readFileSync, readlinkSync } from 'node:fs';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { WebSocket, WebSocketServer } from 'ws';

const host = '127.0.0.1';
const port = Number(process.env.CSA_CHROME_CDP_PORT || '9222');
const browserId = randomUUID().replaceAll('-', '');
const chromeArgsStart = process.argv.indexOf('--') + 1;
const chromeCommand = chromeArgsStart > 0 ? process.argv[chromeArgsStart] : '';
const chromeBin = chromeCommand || process.env.COKE_DESKTOP_CHROME_BIN || '/opt/google/chrome/chrome';
const chromeArgs = chromeArgsStart > 0 ? process.argv.slice(chromeArgsStart + 1) : [];
const startupCommandTimeoutMs = Number(process.env.CSA_CHROME_PIPE_STARTUP_COMMAND_TIMEOUT_MS || '330000');
const commandTimeoutMs = Number(process.env.CSA_CHROME_PIPE_COMMAND_TIMEOUT_MS || '120000');
const startedAt = Date.now();
const pending = new Map();
const targets = new Map();
const pageSessions = new Map();
const targetSessions = new Map();
const targetAttachPromises = new Map();
const browserClients = new Set();
const stderrTail = [];
let nextPipeCommandId = 0;
let pipeOutputChunkCount = 0;
let pipeInput;
let pipeOutput;
let chromeProcess;
let browserVersion;
let targetListReady = false;
let stopping = false;

if (process.env.CSA_CHROME_CDP_PIPE_IMPORT_SMOKE === '1') {
  process.stdout.write('chrome_cdp_pipe_bridge_import_smoke_ok\n');
  process.exit(0);
}

const server = createServer((request, response) => {
  void handleHttpRequest(request, response).catch(error => {
    log('http.request.failed', {
      method: request.method || 'unknown',
      path: safePath(request.url),
      errorName: error instanceof Error ? error.name : 'Error',
      errorMessage: error instanceof Error ? error.message.slice(0, 240) : 'HTTP request failed.',
    });
    writeJson(response, 500, { error: 'Chrome debugging bridge failed.' });
  });
});

const sockets = new WebSocketServer({
  noServer: true,
  clientTracking: true,
  perMessageDeflate: false,
  maxPayload: 16 * 1024 * 1024,
});

function log(stage, fields = {}) {
  process.stdout.write(JSON.stringify({
    timestamp: new Date().toISOString(),
    elapsedMs: Date.now() - startedAt,
    component: 'chrome-cdp-pipe-bridge',
    stage,
    ...fields,
  }) + '\n');
}

function safePath(value) {
  if (typeof value !== 'string') return '/';
  try {
    const parsed = new URL(value, 'http://127.0.0.1');
    return parsed.pathname.slice(0, 200) || '/';
  } catch {
    return '/invalid';
  }
}

function pipeFdInfo(stream) {
  const publicFd = stream?.fd;
  const internalFd = stream?._handle?.fd;
  const fd = Number.isSafeInteger(publicFd) ? publicFd : Number.isSafeInteger(internalFd) ? internalFd : -1;
  if (fd < 0) return { fd: 'unavailable', target: 'unavailable' };
  try {
    return {
      fd,
      fdSource: Number.isSafeInteger(publicFd) ? 'stream.fd' : 'stream._handle.fd',
      target: readlinkSync('/proc/' + process.pid + '/fd/' + fd),
      streamType: stream?.constructor?.name || 'unknown',
    };
  } catch {
    return { fd, fdSource: Number.isSafeInteger(publicFd) ? 'stream.fd' : 'stream._handle.fd', target: 'unavailable', streamType: stream?.constructor?.name || 'unknown' };
  }
}

function childPipeSnapshot(pid) {
  const descriptors = {};
  for (const fd of [3, 4]) {
    try {
      descriptors[fd] = readlinkSync(`/proc/${pid}/fd/${fd}`);
    } catch (error) {
      descriptors[fd] = error && typeof error === 'object' && 'code' in error ? String(error.code) : 'unavailable';
    }
  }
  const status = {};
  try {
    for (const line of readFileSync(`/proc/${pid}/status`, 'utf8').split('\n')) {
      const match = /^(State|Threads|VmRSS|voluntary_ctxt_switches|nonvoluntary_ctxt_switches):\s*(.*)$/.exec(line);
      if (match) status[match[1]] = match[2];
    }
  } catch {
    status.read = 'unavailable';
  }
  return { pid, descriptors, status };
}

function writeJson(response, statusCode, value) {
  const body = Buffer.from(JSON.stringify(value));
  response.writeHead(statusCode, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': String(body.byteLength),
    'cache-control': 'no-store',
    'x-csa-chrome-transport': 'pipe',
    connection: 'close',
  });
  response.end(body);
}

function websocketUrl(path) {
  return 'ws://' + host + ':' + port + path;
}

function targetForClient(info) {
  const page = info.type === 'page';
  return {
    ...info,
    id: info.targetId,
    webSocketDebuggerUrl: page ? websocketUrl('/devtools/page/' + encodeURIComponent(info.targetId)) : undefined,
  };
}

function browserVersionForClient() {
  if (!browserVersion) return undefined;
  return {
    Browser: browserVersion.product,
    'Protocol-Version': browserVersion.protocolVersion,
    'User-Agent': browserVersion.userAgent,
    'V8-Version': browserVersion.jsVersion,
    webSocketDebuggerUrl: websocketUrl('/devtools/browser/' + browserId),
  };
}

function rejectPipeRequests(error) {
  for (const request of pending.values()) {
    clearTimeout(request.timer);
    request.reject(error);
  }
  pending.clear();
}

function requestChrome(method, params = {}, sessionId, timeoutMs = commandTimeoutMs) {
  if (!pipeInput || pipeInput.destroyed || !chromeProcess || chromeProcess.exitCode !== null) {
    return Promise.reject(new Error('Chrome debugging pipe is not available.'));
  }
  const id = ++nextPipeCommandId;
  const started = Date.now();
  const message = { id, method };
  if (params && Object.keys(params).length > 0) message.params = params;
  if (sessionId) message.sessionId = sessionId;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(id);
      log('cdp.command.timeout', { method, commandId: id, timeoutMs, durationMs: Date.now() - started });
      reject(new Error('Chrome CDP command timed out: ' + method));
    }, timeoutMs);
    pending.set(id, {
      method,
      started,
      timer,
      resolve: result => {
        clearTimeout(timer);
        log('cdp.command.complete', { method, commandId: id, durationMs: Date.now() - started });
        resolve(result);
      },
      reject: error => {
        clearTimeout(timer);
        reject(error);
      },
    });
    const frame = JSON.stringify(message) + '\0';
    const pipeInputInfo = pipeFdInfo(pipeInput);
    const writeStartedAt = Date.now();
    log('cdp.command.write.start', {
      method,
      commandId: id,
      frameBytes: Buffer.byteLength(frame),
      pipeFd: pipeInputInfo.fd,
      pipeTarget: pipeInputInfo.target,
    });
    try {
      const writeAccepted = pipeInput.write(frame, error => {
        if (!error) {
          log('cdp.command.write.complete', { method, commandId: id, frameBytes: Buffer.byteLength(frame), durationMs: Date.now() - writeStartedAt });
          return;
        }
        const entry = pending.get(id);
        log('cdp.command.write.failed', {
          method,
          commandId: id,
          durationMs: Date.now() - writeStartedAt,
          errorName: error.name || 'Error',
          errorMessage: String(error.message || error).slice(0, 240),
        });
        if (!entry) return;
        pending.delete(id);
        clearTimeout(timer);
        entry.reject(error);
      });
      log('cdp.command.write.queued', {
        method,
        commandId: id,
        frameBytes: Buffer.byteLength(frame),
        accepted: writeAccepted,
        writableLength: pipeInput.writableLength,
        pipeFd: pipeFdInfo(pipeInput).fd,
      });
    } catch (error) {
      const value = error instanceof Error ? error : new Error(String(error));
      const entry = pending.get(id);
      log('cdp.command.write.failed', {
        method,
        commandId: id,
        durationMs: Date.now() - writeStartedAt,
        errorName: value.name,
        errorMessage: value.message.slice(0, 240),
      });
      if (entry) {
        pending.delete(id);
        clearTimeout(timer);
        entry.reject(value);
      }
    }
    log('cdp.command.start', { method, commandId: id, timeoutMs });
  });
}

function handlePipeMessage(message) {
  if (Number.isSafeInteger(message.id)) {
    const request = pending.get(message.id);
    if (!request) return;
    pending.delete(message.id);
    log('cdp.command.response.received', {
      method: request.method,
      commandId: message.id,
      frameBytes: Buffer.byteLength(JSON.stringify(message)),
      hasError: Boolean(message.error),
      resultKeys: Object.keys(message.result || {}).slice(0, 20),
    });
    request.resolve(message);
    return;
  }
  if (typeof message.method !== 'string') return;
  const params = message.params && typeof message.params === 'object' ? message.params : {};
  if (message.method === 'Target.targetCreated' && params.targetInfo?.targetId) {
    targets.set(params.targetInfo.targetId, params.targetInfo);
  } else if (message.method === 'Target.targetInfoChanged' && params.targetInfo?.targetId) {
    targets.set(params.targetInfo.targetId, params.targetInfo);
  } else if (message.method === 'Target.targetDestroyed' && params.targetId) {
    targets.delete(params.targetId);
    const targetSession = targetSessions.get(params.targetId);
    if (targetSession) {
      targetSessions.delete(params.targetId);
      pageSessions.delete(targetSession.sessionId);
      if (targetSession.socket?.readyState === WebSocket.OPEN) targetSession.socket.close(1001, 'Chrome page closed.');
    }
  }

  if (message.sessionId) {
    const pageSession = pageSessions.get(message.sessionId);
    if (pageSession?.socket?.readyState === WebSocket.OPEN) {
      sendWebSocket(pageSession.socket, { method: message.method, params });
    }
    return;
  }
  for (const socket of browserClients) {
    if (socket.readyState === WebSocket.OPEN) sendWebSocket(socket, message);
  }
}

function handlePipeData(chunk) {
  pipeOutputChunkCount += 1;
  if (pipeOutputChunkCount <= 12 || pipeOutputChunkCount % 100 === 0) {
    log('cdp.pipe.output.chunk', {
      chunkIndex: pipeOutputChunkCount,
      chunkBytes: Buffer.byteLength(chunk),
      bufferedBytesBefore: pipeOutput.buffer.length,
      pendingCommandCount: pending.size,
    });
  }
  pipeOutput.buffer = Buffer.concat([pipeOutput.buffer, Buffer.from(chunk)]);
  for (;;) {
    const separator = pipeOutput.buffer.indexOf(0);
    if (separator < 0) break;
    const frame = pipeOutput.buffer.subarray(0, separator);
    pipeOutput.buffer = pipeOutput.buffer.subarray(separator + 1);
    if (frame.length === 0) continue;
    let message;
    try {
      message = JSON.parse(frame.toString('utf8'));
    } catch {
      log('cdp.pipe.invalid-json', { frameBytes: frame.length });
      continue;
    }
    handlePipeMessage(message);
  }
  if (pipeOutput.buffer.length > 64 * 1024 * 1024) {
    failBridge(new Error('Chrome debugging pipe frame exceeded 64 MiB.'));
  }
}

function sendWebSocket(socket, message) {
  try {
    socket.send(JSON.stringify(message), error => {
      if (error) log('websocket.send.failed', { errorName: error.name });
    });
  } catch (error) {
    log('websocket.send.failed', { errorName: error instanceof Error ? error.name : 'Error' });
  }
}

function sendProtocolError(socket, id, code, message, browserSocket = false) {
  const payload = { id, error: { code, message } };
  sendWebSocket(socket, payload);
}

async function prewarmPageTarget(targetSession) {
  const started = Date.now();
  log('page-target.prewarm.start', { targetId: targetSession.targetId });
  for (const method of ['Page.enable', 'Runtime.enable', 'Page.getFrameTree']) {
    const response = await requestChrome(method, {}, targetSession.sessionId);
    if (response.error) throw new Error(response.error.message || 'Chrome page initialization failed: ' + method);
    targetSession.initialResults.set(method, response);
  }
  targetSession.ready = true;
  log('page-target.prewarm.complete', {
    targetId: targetSession.targetId,
    cachedMethods: targetSession.initialResults.size,
    durationMs: Date.now() - started,
  });
}

async function attachPageTarget(targetId) {
  const existing = targetSessions.get(targetId);
  if (existing) return existing;
  let pendingAttach = targetAttachPromises.get(targetId);
  if (!pendingAttach) {
    pendingAttach = (async () => {
      const started = Date.now();
      log('page-target.attach.start', { targetId });
      const response = await requestChrome('Target.attachToTarget', { targetId, flatten: true });
      const sessionId = response.result?.sessionId;
      if (response.error || typeof sessionId !== 'string') {
        throw new Error(response.error?.message || 'Chrome did not return a target session.');
      }
      const targetSession = {
        targetId,
        sessionId,
        socket: undefined,
        initialResults: new Map(),
        ready: false,
        prewarmPromise: undefined,
      };
      targetSessions.set(targetId, targetSession);
      pageSessions.set(sessionId, targetSession);
      targetSession.prewarmPromise = prewarmPageTarget(targetSession).catch(error => {
        log('page-target.prewarm.failed', {
          targetId,
          errorName: error instanceof Error ? error.name : 'Error',
          errorMessage: error instanceof Error ? error.message.slice(0, 240) : 'Chrome page initialization failed.',
        });
        throw error;
      });
      targetSession.prewarmPromise.catch(() => undefined);
      log('page-target.attach.complete', { targetId, durationMs: Date.now() - started });
      return targetSession;
    })().finally(() => targetAttachPromises.delete(targetId));
    targetAttachPromises.set(targetId, pendingAttach);
  }
  return pendingAttach;
}

function forwardClientCommand(context, request) {
  if (!Number.isSafeInteger(request.id) || typeof request.method !== 'string') return;
  const sessionId = context.kind === 'page' ? context.sessionId : request.sessionId;
  if (context.kind === 'page' && !sessionId) {
    context.queue.push(request);
    return;
  }
  const execute = async () => {
    const targetSession = context.kind === 'page' ? context.targetSession : undefined;
    if (targetSession?.prewarmPromise) await targetSession.prewarmPromise;
    if (targetSession?.initialResults.has(request.method)) {
      const response = targetSession.initialResults.get(request.method);
      targetSession.initialResults.delete(request.method);
      log('page-target.prewarm.cache-hit', { targetId: targetSession.targetId, method: request.method });
      return response;
    }
    return requestChrome(request.method, request.params || {}, sessionId);
  };
  void execute().then(response => {
    const payload = { id: request.id };
    if (response.result !== undefined) payload.result = response.result;
    if (response.error !== undefined) payload.error = response.error;
    if (context.kind === 'browser' && response.sessionId) payload.sessionId = response.sessionId;
    sendWebSocket(context.socket, payload);
  }).catch(error => {
    sendProtocolError(context.socket, request.id, -32000, error instanceof Error ? error.message : 'Chrome CDP command failed.');
  });
}

function attachClientMessageHandler(context) {
  context.socket.on('message', data => {
    let request;
    try {
      request = JSON.parse(data.toString());
    } catch {
      sendProtocolError(context.socket, null, -32700, 'Invalid JSON request.');
      return;
    }
    if (!request || typeof request !== 'object' || typeof request.method !== 'string') {
      sendProtocolError(context.socket, request?.id ?? null, -32600, 'Invalid CDP request.');
      return;
    }
    if (context.kind === 'page' && !context.sessionId) context.queue.push(request);
    else forwardClientCommand(context, request);
  });
  context.socket.on('close', () => {
    if (context.kind === 'browser') browserClients.delete(context.socket);
    if (context.kind === 'page' && context.sessionId) {
      const targetSession = context.targetSession;
      if (targetSession?.socket === context.socket) targetSession.socket = undefined;
    }
  });
  context.socket.on('error', error => {
    log('websocket.client.error', { kind: context.kind, errorName: error.name });
  });
}

async function attachPageClient(context) {
  const target = targets.get(context.targetId);
  if (!target || target.type !== 'page') {
    context.socket.close(1008, 'Unknown page target.');
    return;
  }
  try {
    log('websocket.page.attach.start', { targetId: context.targetId });
    const targetSession = await attachPageTarget(context.targetId);
    context.targetSession = targetSession;
    context.sessionId = targetSession.sessionId;
    targetSession.socket = context.socket;
    log('websocket.page.attach.complete', { targetId: context.targetId, durationMs: Date.now() - context.startedAt });
    const queued = context.queue.splice(0);
    for (const request of queued) forwardClientCommand(context, request);
  } catch (error) {
    log('websocket.page.attach.failed', {
      targetId: context.targetId,
      durationMs: Date.now() - context.startedAt,
      errorName: error instanceof Error ? error.name : 'Error',
      errorMessage: error instanceof Error ? error.message.slice(0, 240) : 'Chrome target attach failed.',
    });
    context.socket.close(1011, 'Chrome target attach failed.');
  }
}

function targetUrl(id, kind) {
  return websocketUrl('/devtools/' + kind + '/' + encodeURIComponent(id));
}

function targetList() {
  return [...targets.values()].map(info => targetForClient(info));
}

function decodeTargetUrl(url) {
  const raw = url.search.startsWith('?') ? url.search.slice(1) : '';
  if (!raw) return 'about:blank';
  const value = raw.startsWith('url=') ? new URLSearchParams(raw).get('url') : raw;
  try { return decodeURIComponent(value || 'about:blank'); }
  catch { return value || 'about:blank'; }
}

async function waitForTarget(targetId, timeoutMs = 5_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const info = targets.get(targetId);
    if (info) return info;
    await delay(50);
  }
  return undefined;
}

async function handleHttpRequest(request, response) {
  const pathname = safePath(request.url);
  const method = request.method || 'GET';
  log('http.request', { method, path: pathname });
  if (method === 'GET' && pathname === '/json/version') {
    const value = browserVersionForClient();
    writeJson(response, value ? 200 : 503, value || { error: 'Chrome is starting.' });
    return;
  }
  if ((method === 'GET' || method === 'PUT') && (pathname === '/json/list' || pathname === '/json')) {
    writeJson(response, targetListReady ? 200 : 503, targetListReady ? targetList() : { error: 'Chrome targets are starting.' });
    return;
  }
  if ((method === 'GET' || method === 'PUT') && pathname === '/json/new') {
    if (!browserVersion) {
      writeJson(response, 503, { error: 'Chrome is starting.' });
      return;
    }
    const url = new URL(request.url || '/', 'http://127.0.0.1');
    const targetUrlValue = decodeTargetUrl(url);
    const result = await requestChrome('Target.createTarget', { url: targetUrlValue });
    const targetId = result.result?.targetId;
    if (result.error || typeof targetId !== 'string') {
      writeJson(response, 500, { error: result.error?.message || 'Chrome could not create the page.' });
      return;
    }
    let info = await waitForTarget(targetId);
    if (!info) {
      info = { targetId, type: 'page', title: '', url: targetUrlValue, attached: false };
      targets.set(targetId, info);
    }
    await attachPageTarget(targetId);
    writeJson(response, 200, targetForClient(info));
    return;
  }
  const activateMatch = pathname.match(/^\/json\/activate\/([A-Za-z0-9_-]+)$/);
  if (method === 'GET' && activateMatch) {
    const result = await requestChrome('Target.activateTarget', { targetId: activateMatch[1] });
    writeJson(response, result.error ? 500 : 200, result.error || { id: activateMatch[1], status: 'activated' });
    return;
  }
  const closeMatch = pathname.match(/^\/json\/close\/([A-Za-z0-9_-]+)$/);
  if (method === 'GET' && closeMatch) {
    const result = await requestChrome('Target.closeTarget', { targetId: closeMatch[1] });
    writeJson(response, result.error ? 500 : 200, result.error || { id: closeMatch[1], status: result.result?.success ? 'closed' : 'not closed' });
    return;
  }
  writeJson(response, 404, { error: 'Unknown debugging endpoint.' });
}

function listen() {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => {
      server.removeListener('error', reject);
      log('http.listen.ready', { host, port });
      resolve();
    });
  });
}

function startChrome() {
  if (chromeArgs.some(argument => /^--remote-debugging-(?:port|address)(?:=|$)/.test(argument))) {
    throw new Error('Do not pass a remote-debugging-port or remote-debugging-address flag to the pipe bridge.');
  }
  if (!chromeArgs.includes('--remote-debugging-pipe')) chromeArgs.push('--remote-debugging-pipe');
  chromeProcess = spawn(chromeBin, chromeArgs, {
    stdio: ['ignore', 'ignore', 'pipe', 'pipe', 'pipe'],
    env: process.env,
  });
  pipeInput = chromeProcess.stdio[3];
  pipeOutput = chromeProcess.stdio[4];
  pipeOutput.buffer = Buffer.alloc(0);
  pipeInput.on('error', error => {
    log('cdp.pipe.input.error', {
      errorName: error.name || 'Error',
      errorMessage: String(error.message || error).slice(0, 240),
      stopping,
    });
    if (!stopping) void failBridge(error);
  });
  pipeOutput.on('data', handlePipeData);
  pipeOutput.on('end', () => {
    log('cdp.pipe.output.end', { pendingCommandCount: pending.size, bufferedBytes: pipeOutput.buffer.length });
    rejectPipeRequests(new Error('Chrome debugging pipe closed.'));
  });
  pipeOutput.on('error', error => {
    log('cdp.pipe.output.error', { errorName: error.name || 'Error', errorMessage: String(error.message || error).slice(0, 240) });
    rejectPipeRequests(error);
  });
  chromeProcess.stderr?.on('data', chunk => {
    for (const rawLine of Buffer.from(chunk).toString('utf8').split(/[\r\n]+/)) {
      const line = rawLine.trim();
      if (!line) continue;
      const safeLine = line
        .replace(/(https?:\/\/)[^/@\s]+:[^/@\s]+@/gi, '$1[redacted]@')
        .replace(/(DevTools listening on ws:\/\/)[^\s]+/g, '$1[redacted]')
        .replace(/(\/devtools\/browser\/)[A-Za-z0-9_-]+/g, '$1[redacted]')
        .slice(0, 500);
      stderrTail.push(safeLine);
      if (stderrTail.length > 12) stderrTail.shift();
      if (/\b(ERROR|FATAL)\b/.test(line)) log('chrome.stderr.error', { line: safeLine });
    }
  });
  chromeProcess.once('error', error => failBridge(error));
  chromeProcess.once('spawn', () => {
    const pid = chromeProcess.pid || -1;
    log('chrome.process.spawn.event', { pipe: childPipeSnapshot(pid) });
    setTimeout(() => {
      if (pid > 0) log('chrome.process.fd.snapshot', { pipe: childPipeSnapshot(pid) });
    }, 250);
  });
  chromeProcess.once('exit', (code, signal) => {
    log('chrome.process.exit', { code: code === null ? 'none' : code, signal: signal || 'none' });
    if (!stopping) void failBridge(new Error('Chrome exited before the desktop bridge stopped.'));
  });
  log('chrome.process.spawned', {
    pid: chromeProcess.pid || 'unknown',
    executable: chromeBin,
    argumentCount: chromeArgs.length,
    profileConfigured: chromeArgs.some(argument => argument.startsWith('--user-data-dir=')),
    debuggingTransport: 'pipe',
    pipeInput: pipeFdInfo(pipeInput),
    pipeOutput: pipeFdInfo(pipeOutput),
  });
}

async function initializeChrome() {
  const versionResponse = await requestChrome('Browser.getVersion', {}, undefined, startupCommandTimeoutMs);
  if (versionResponse.error || !versionResponse.result?.product) {
    throw new Error(versionResponse.error?.message || 'Chrome did not return browser version information.');
  }
  browserVersion = versionResponse.result;
  log('chrome.browser-version.ready', { product: browserVersion.product, protocolVersion: browserVersion.protocolVersion });
  const discovery = await requestChrome('Target.setDiscoverTargets', { discover: true }, undefined, 60_000);
  if (discovery.error) throw new Error(discovery.error.message || 'Chrome target discovery could not be enabled.');
  const result = await requestChrome('Target.getTargets', {}, undefined, 60_000);
  if (result.error || !Array.isArray(result.result?.targetInfos)) {
    throw new Error(result.error?.message || 'Chrome did not return its target list.');
  }
  for (const info of result.result.targetInfos) targets.set(info.targetId, info);
  targetListReady = true;
  log('chrome.targets.ready', {
    targetCount: targets.size,
    pageCount: [...targets.values()].filter(info => info.type === 'page').length,
  });
}

async function failBridge(error) {
  if (stopping) return;
  log('bridge.failed', {
    errorName: error instanceof Error ? error.name : 'Error',
    errorMessage: error instanceof Error ? error.message.slice(0, 300) : 'Chrome pipe bridge failed.',
    stderrTail,
  });
  await shutdown(1);
}

function sendUpgradeError(socket, status) {
  const message = status === 404 ? 'Not Found' : 'Service Unavailable';
  socket.end('HTTP/1.1 ' + status + ' ' + message + '\r\nConnection: close\r\nContent-Length: 0\r\n\r\n');
}

server.on('upgrade', (request, socket, head) => {
  const parsed = new URL(request.url || '/', 'http://127.0.0.1');
  const browserMatch = parsed.pathname === '/devtools/browser/' + browserId;
  const pageMatch = parsed.pathname.match(/^\/devtools\/page\/([A-Za-z0-9_-]+)$/);
  if (browserMatch && browserVersion) {
    sockets.handleUpgrade(request, socket, head, webSocket => {
      browserClients.add(webSocket);
      attachClientMessageHandler({ kind: 'browser', socket: webSocket });
      log('websocket.browser.connected');
    });
    return;
  }
  if (pageMatch && targets.get(pageMatch[1])?.type === 'page') {
    const targetId = pageMatch[1];
    sockets.handleUpgrade(request, socket, head, webSocket => {
      const context = { kind: 'page', socket: webSocket, targetId, sessionId: undefined, queue: [], startedAt: Date.now() };
      attachClientMessageHandler(context);
      log('websocket.page.connected', { targetId });
      void attachPageClient(context);
    });
    return;
  }
  sendUpgradeError(socket, browserVersion ? 404 : 503);
});

async function shutdown(exitCode = 0) {
  if (stopping) return;
  stopping = true;
  log('bridge.shutdown.start', { exitCode });
  for (const socket of sockets.clients) {
    try { socket.close(1001, 'Desktop session stopping.'); } catch {}
  }
  if (chromeProcess && chromeProcess.exitCode === null) {
    chromeProcess.kill('SIGTERM');
    const deadline = Date.now() + 2_000;
    while (chromeProcess.exitCode === null && Date.now() < deadline) await delay(50);
    if (chromeProcess.exitCode === null) chromeProcess.kill('SIGKILL');
  }
  rejectPipeRequests(new Error('Chrome pipe bridge is shutting down.'));
  await new Promise(resolve => server.close(() => resolve(undefined))).catch(() => undefined);
  sockets.close();
  log('bridge.shutdown.complete', { exitCode });
  process.exitCode = exitCode;
}

process.once('SIGTERM', () => { void shutdown(0).finally(() => process.exit(process.exitCode || 0)); });
process.once('SIGINT', () => { void shutdown(0).finally(() => process.exit(process.exitCode || 0)); });

if (!Number.isSafeInteger(port) || port < 1024 || port > 65535) throw new Error('CSA_CHROME_CDP_PORT must be between 1024 and 65535.');
if (!Number.isSafeInteger(startupCommandTimeoutMs) || startupCommandTimeoutMs < 30_000 || startupCommandTimeoutMs > 3_570_000) {
  throw new Error('CSA_CHROME_PIPE_STARTUP_COMMAND_TIMEOUT_MS must be between 30000 and 3570000.');
}
if (!Number.isSafeInteger(commandTimeoutMs) || commandTimeoutMs < 10_000 || commandTimeoutMs > 300_000) {
  throw new Error('CSA_CHROME_PIPE_COMMAND_TIMEOUT_MS must be between 10000 and 300000.');
}
if (chromeArgsStart <= 0 || !chromeCommand) throw new Error('Pass the Chrome executable and arguments after --.');

async function startBridge() {
  try {
    await listen();
    startChrome();
    await initializeChrome();
    log('bridge.ready', { host, port, targetCount: targets.size, browserWebSocketAvailable: true });
  } catch (error) {
    await failBridge(error instanceof Error ? error : new Error(String(error)));
    process.exit(process.exitCode || 1);
  }
}

void startBridge();
