import { appendFileSync, readFileSync, readdirSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { StringDecoder } from 'node:string_decoder';

const executable = process.env.CSA_DSH_RUNTIME_EXECUTABLE;
const logPath = process.env.CSA_DSH_LAUNCH_LOG || '';
const startedAt = Date.now();
const apiKey = process.env.DEEPSEEK_API_KEY || '';
const signalEscalationGraceMs = 8000;
const pendingRequests = new Map();
const frameBuffers = { request: '', response: '' };
const frameDecoders = { request: new StringDecoder('utf8'), response: new StringDecoder('utf8') };
const stderrDecoder = new StringDecoder('utf8');
let stderrBuffer = '';
let protocolEvents = 0;
let stderrEvents = 0;
let truncatedProtocolLog = false;
let truncatedStderrLog = false;
let childExited = false;
let childClosed = false;
let shutdownTimer;
let diagnosticsTimer;
let closeWatchdog;
let previousCpuTicks;

function redact(value) {
  let text = String(value ?? '');
  if (apiKey) text = text.split(apiKey).join('[REDACTED]');
  return text
    .replace(/\b(Bearer|Basic)\s+[^\s"'`]+/gi, '$1 [REDACTED]')
    .replace(/\bsk-[A-Za-z0-9_-]{12,}\b/g, '[REDACTED]')
    .replace(/([?&](?:api[_-]?key|token|password|secret)=)[^&\s"']+/gi, '$1[REDACTED]')
    .replace(/(api[_-]?key\s*[:=]\s*)[^,\s"']+/gi, '$1[REDACTED]');
}

function log(stage, level, message, details = {}, component = 'dsh-launcher') {
  const logger = component === 'computer-tool' ? 'coke-super-agent.computer-tool' : 'coke-super-agent.dsh-launcher';
  const line = JSON.stringify({
    timestamp: new Date().toISOString(),
    logger,
    component,
    stage,
    level,
    message: redact(message),
    details: JSON.parse(redact(JSON.stringify(details))),
  }) + '\n';
  if (logPath) {
    try { appendFileSync(logPath, line, { mode: 0o600 }); }
    catch (error) {
      process.stderr.write(JSON.stringify({
        timestamp: new Date().toISOString(),
        logger: 'coke-super-agent.dsh-launcher',
        component: 'dsh-launcher',
        stage: 'runtime.log.write.failed',
        level: 'error',
        message: '无法持久化 DSH runtime 启动日志。',
        details: { errorName: error instanceof Error ? error.name : 'Error' },
      }) + '\n');
    }
  }
  process.stderr.write(line);
}

function frameDetails(direction, line) {
  try {
    const value = JSON.parse(line);
    if (value && typeof value === 'object' && typeof value.method === 'string') {
      if (direction === 'request' && value.id !== undefined) pendingRequests.set(String(value.id), value.method);
      return {
        direction,
        kind: value.id === undefined ? 'notification' : 'request',
        ...(value.id === undefined ? {} : { id: value.id }),
        method: value.method,
        paramsKeys: value.params && typeof value.params === 'object' ? Object.keys(value.params).slice(0, 24) : [],
      };
    }
    if (value && typeof value === 'object' && value.id !== undefined) {
      const requestId = String(value.id);
      const method = pendingRequests.get(requestId);
      pendingRequests.delete(requestId);
      const error = value.error && typeof value.error === 'object' ? value.error : null;
      return {
        direction,
        kind: 'response',
        id: value.id,
        ...(method ? { method } : {}),
        ok: !error,
        ...(value.result && typeof value.result === 'object' ? { resultKeys: Object.keys(value.result).slice(0, 24) } : {}),
        ...(error ? { errorCode: error.code ?? null, errorMessage: redact(error.message || '').slice(0, 500) } : {}),
      };
    }
    return { direction, kind: 'json', keys: Object.keys(value || {}).slice(0, 24) };
  } catch {
    return { direction, kind: 'non-json', bytes: Buffer.byteLength(line) };
  }
}

function observeFrames(direction, chunk) {
  frameBuffers[direction] += frameDecoders[direction].write(chunk);
  let newline;
  while ((newline = frameBuffers[direction].indexOf('\n')) >= 0) {
    const line = frameBuffers[direction].slice(0, newline).trim();
    frameBuffers[direction] = frameBuffers[direction].slice(newline + 1);
    if (!line) continue;
    protocolEvents += 1;
    if (protocolEvents <= 500) {
      log('runtime.protocol.frame', 'info', 'DeepSeek Harness JSON-RPC 帧。', frameDetails(direction, line));
    } else if (!truncatedProtocolLog) {
      truncatedProtocolLog = true;
      log('runtime.protocol.log.truncated', 'warning', 'JSON-RPC 帧日志达到 500 条上限；数据仍原样传递。', { protocolEvents });
    }
  }
}

function observeStderr(chunk) {
  stderrBuffer += stderrDecoder.write(chunk);
  let newline;
  while ((newline = stderrBuffer.indexOf('\n')) >= 0) {
    const line = redact(stderrBuffer.slice(0, newline).replace(/\r$/, ''));
    stderrBuffer = stderrBuffer.slice(newline + 1);
    if (!line) continue;
    try {
      const structured = JSON.parse(line);
      if (structured?.logger === 'coke-super-agent.computer-tool'
        && structured.component === 'computer-tool'
        && typeof structured.stage === 'string'
        && /^[a-z0-9._-]{1,100}$/i.test(structured.stage)) {
        const level = structured.level === 'error' || structured.level === 'warning' ? structured.level : 'info';
        const details = structured.details && typeof structured.details === 'object' && !Array.isArray(structured.details)
          ? { ...structured.details }
          : {};
        if (typeof structured.timestamp === 'string') details.sourceTimestamp = structured.timestamp.slice(0, 40);
        log(structured.stage, level, 'Computer Use internal stage.', details, 'computer-tool');
        continue;
      }
    } catch { /* Preserve ordinary stderr handling for non-JSON output. */ }
    stderrEvents += 1;
    if (stderrEvents <= 120) {
      const recoverableCatalogFallback = /model\s+(?:listing|list|catalog)/i.test(line)
        && /(?:timed?\s*out|timeout|network|fetch)/i.test(line)
        && /(?:fallback|falling\s+back|using)/i.test(line)
        && /(?:bundled|built[ -]?in)\s+catalog/i.test(line);
      const level = recoverableCatalogFallback
        ? 'warning'
        : /\b(error|failed|exception|fatal)\b/i.test(line) ? 'error' : 'info';
      log('runtime.stderr', level, 'DeepSeek Harness runtime stderr。', { line: line.slice(0, 1600) });
    } else if (!truncatedStderrLog) {
      truncatedStderrLog = true;
      log('runtime.stderr.log.truncated', 'warning', 'runtime stderr 日志达到 120 行上限。', { stderrEvents });
    }
  }
}

function readRuntimeProcessSample(pid) {
  const procRoot = `/proc/${pid}`;
  const statText = readFileSync(`${procRoot}/stat`, 'utf8');
  const statFields = statText.slice(statText.lastIndexOf(')') + 2).trim().split(/\s+/);
  const statusText = readFileSync(`${procRoot}/status`, 'utf8');
  const readStatusNumber = (name) => {
    const match = statusText.match(new RegExp(`^${name}:\\s+(\\d+)`, 'm'));
    return match ? Number(match[1]) : null;
  };
  const ioText = readFileSync(`${procRoot}/io`, 'utf8');
  const readIoNumber = (name) => {
    const match = ioText.match(new RegExp(`^${name}:\\s+(\\d+)`, 'm'));
    return match ? Number(match[1]) : null;
  };
  const cpuTicks = Number(statFields[11] || 0) + Number(statFields[12] || 0);
  const cpuTicksDelta = previousCpuTicks === undefined ? null : Math.max(0, cpuTicks - previousCpuTicks);
  previousCpuTicks = cpuTicks;
  let childCount = null;
  try {
    const children = readFileSync(`${procRoot}/task/${pid}/children`, 'utf8').trim();
    childCount = children ? children.split(/\s+/).length : 0;
  } catch {}
  let fileDescriptorCount = null;
  try { fileDescriptorCount = readdirSync(`${procRoot}/fd`).length; } catch {}
  let waitChannel = null;
  try { waitChannel = readFileSync(`${procRoot}/wchan`, 'utf8').trim().slice(0, 100); } catch {}
  return {
    pid,
    state: statFields[0] || null,
    cpuTicks,
    cpuTicksDelta,
    rssKb: readStatusNumber('VmRSS'),
    threadCount: readStatusNumber('Threads'),
    childCount,
    fileDescriptorCount,
    waitChannel,
    readBytes: readIoNumber('read_bytes'),
    writeBytes: readIoNumber('write_bytes'),
  };
}

function sampleRuntimeProcess() {
  if (childExited || !child?.pid) return;
  try {
    log('runtime.process.sample', 'info', 'DeepSeek Harness runtime 进程状态采样。', readRuntimeProcessSample(child.pid));
  } catch (error) {
    const errorCode = error && typeof error === 'object' && 'code' in error ? error.code : null;
    log('runtime.process.sample.failed', 'warning', '暂时无法读取 runtime 进程状态。', { pid: child.pid, errorName: error instanceof Error ? error.name : 'Error', errorCode });
  }
}

function signalChild(signal) {
  if (childExited || !child.pid) return;
  try {
    if (process.platform !== 'win32') process.kill(-child.pid, signal);
    else child.kill(signal);
  } catch (error) {
    if (error && typeof error === 'object' && error.code !== 'ESRCH') {
      log('runtime.signal.failed', 'warning', '无法向 DSH runtime 进程组发送信号。', { signal, errorName: error.name || 'Error', errorCode: error.code || null });
    }
  }
}

if (!executable) {
  log('runtime.config.failed', 'error', 'CSA_DSH_RUNTIME_EXECUTABLE is not configured.');
  process.exit(127);
}

log('runtime.spawn.start', 'info', '启动 DeepSeek Harness runtime 子进程。', {
  executable,
  args: process.argv.slice(2),
  cwd: process.cwd(),
});
const child = spawn(executable, process.argv.slice(2), { stdio: ['pipe', 'pipe', 'pipe'], detached: process.platform !== 'win32' });
child.once('spawn', () => {
  log('runtime.spawn.ready', 'info', 'DeepSeek Harness runtime 子进程已启动。', { pid: child.pid ?? null });
  sampleRuntimeProcess();
  diagnosticsTimer = setInterval(sampleRuntimeProcess, 15_000);
  diagnosticsTimer.unref();
});
process.stdin.on('data', chunk => {
  observeFrames('request', chunk);
  if (!child.stdin.write(chunk)) {
    process.stdin.pause();
    child.stdin.once('drain', () => process.stdin.resume());
  }
});
process.stdin.once('end', () => child.stdin.end());
child.stdout.on('data', chunk => {
  observeFrames('response', chunk);
  if (!process.stdout.write(chunk)) {
    child.stdout.pause();
    process.stdout.once('drain', () => child.stdout.resume());
  }
});
child.stderr.on('data', chunk => {
  process.stderr.write(chunk);
  observeStderr(chunk);
});
child.stdin.on('error', error => {
  log('runtime.stdin.write.failed', 'warning', '向 DeepSeek Harness runtime 写入 JSON-RPC 输入失败。', { errorName: error.name, errorCode: error.code || null });
});
for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
  process.on(signal, () => {
    if (!childExited) {
      log('runtime.signal.forward', 'warning', '向 DeepSeek Harness runtime 转发关闭信号。', { signal });
      signalChild(signal);
      if (!shutdownTimer && signal !== 'SIGHUP') {
        shutdownTimer = setTimeout(() => {
          if (!childExited) {
            log('runtime.signal.escalate', 'warning', 'runtime 未在关闭宽限期内退出，向整个 DSH runtime 进程组发送 SIGKILL。', { graceMs: signalEscalationGraceMs });
            signalChild('SIGKILL');
          }
        }, signalEscalationGraceMs).unref();
      }
    }
  });
}
child.once('error', error => {
  log('runtime.spawn.failed', 'error', '无法启动 DeepSeek Harness runtime。', {
    errorName: error.name,
    errorCode: 'code' in error ? error.code || null : null,
  });
  process.exitCode = 127;
});
child.once('exit', (code, signal) => {
  childExited = true;
  if (diagnosticsTimer) clearInterval(diagnosticsTimer);
  if (shutdownTimer) clearTimeout(shutdownTimer);
  log('runtime.spawn.exit', Number.isInteger(code) && code === 0 ? 'info' : 'error', 'DeepSeek Harness runtime 子进程已退出。', {
    exitCode: Number.isInteger(code) ? code : null,
    signal: signal || null,
    durationMs: Date.now() - startedAt,
  });
  process.exitCode = Number.isInteger(code) ? code : signal ? 128 : 1;
  closeWatchdog = setTimeout(() => {
    if (childClosed) return;
    log('runtime.spawn.close-timeout', 'warning', 'DeepSeek Harness 已退出，但子进程的输出管道仍被其他进程占用；关闭残留管道以结束本次运行。', {
      graceMs: 5000,
      exitCode: Number.isInteger(code) ? code : null,
      signal: signal || null,
    });
    child.stdout.destroy();
    child.stderr.destroy();
    process.stdin.pause();
    process.stdin.destroy();
    if (!process.stdout.writableEnded) process.stdout.end();
  }, 5000);
});
child.once('close', (code, signal) => {
  childClosed = true;
  if (closeWatchdog) clearTimeout(closeWatchdog);
  const tail = redact(stderrBuffer + stderrDecoder.end()).trim();
  if (tail) observeStderr(Buffer.from(tail + '\n'));
  log('runtime.spawn.close', 'info', 'DeepSeek Harness 子进程输出管道已关闭。', {
    exitCode: Number.isInteger(code) ? code : null,
    signal: signal || null,
  });
  process.stdin.pause();
  process.stdin.destroy();
  if (!process.stdout.writableEnded) process.stdout.end();
});
process.once('exit', () => {
  if (!childExited) signalChild('SIGKILL');
});
