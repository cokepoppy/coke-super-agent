import { execFileSync, spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, lstatSync, readFileSync, readdirSync, readlinkSync, rmSync, unlinkSync } from 'node:fs';
import { setTimeout as delay } from 'node:timers/promises';

const runId = process.env.CSA_RUN_ID || randomUUID();
if (!/^[A-Za-z0-9_-]{1,80}$/.test(runId)) throw new Error('CSA_RUN_ID must contain only letters, numbers, underscores, or hyphens.');
const timeoutMs = Number(process.env.CSA_CHROME_PIPE_TIMEOUT_MS || '300000');
const guiMode = process.env.CSA_CHROME_PIPE_GUI === '1';
const stracePath = process.env.CSA_CHROME_PIPE_STRACE_PATH || '';
const straceWindowMs = Number(process.env.CSA_CHROME_PIPE_STRACE_WINDOW_MS || '15000');
const straceMode = process.env.CSA_CHROME_PIPE_STRACE_MODE || 'pipe';
const traceStartup = process.env.CSA_CHROME_PIPE_TRACE_STARTUP === '1';
const chrome = '/opt/google/chrome/chrome';
const desktopHome = '/workspace/.desktop-home';
const display = process.env.DISPLAY || ':1';
const requestedProfileRoot = process.env.CSA_CHROME_PIPE_PROFILE_ROOT || '';
const profileRoot = requestedProfileRoot === '/tmp' ? '/tmp' : desktopHome + '/.config/chromium';
const profile = guiMode
  ? profileRoot + '/csa-pipe-' + runId
  : '/tmp/csa-chrome-pipe-' + runId;
const startedAt = Date.now();
let deadlineAt = 0;
const straceLogPath = '/tmp/csa-chrome-pipe-strace-' + runId + '.log';
const startupTracePath = '/tmp/csa-chrome-startup-' + runId + '.json';
let nextMessageId = 1;
let pendingBytes = Buffer.alloc(0);
const pending = new Map();
const stderrTail = [];
let child;
let xvfb;
let xfce;
let straceProcess;
let straceTimer;
let straceFinishPromise;
let straceTargetPids = [];
let straceThreadIds = [];
let straceFdTargets = {};
let straceThreadSnapshotsAtAttach = [];
const straceStderrTail = [];
let straceStderrBuffer = '';

function collectStraceStderr(chunk) {
  straceStderrBuffer += Buffer.from(chunk).toString('utf8');
  const lines = straceStderrBuffer.split(/\r?\n/);
  straceStderrBuffer = lines.pop() || '';
  for (const line of lines) {
    const value = line.replace(/[\r\n]+/g, ' ').trim();
    if (value) straceStderrTail.push(value.slice(0, 320));
  }
  if (straceStderrTail.length > 160) straceStderrTail.splice(0, straceStderrTail.length - 160);
}

function flushStraceStderr() {
  const value = straceStderrBuffer.replace(/[\r\n]+/g, ' ').trim();
  straceStderrBuffer = '';
  if (value) straceStderrTail.push(value.slice(0, 320));
}

function summarizeSyscallTrace(traceLines) {
  const calls = [];
  const counts = {};
  let previousTimestamp = null;
  const syscallGaps = [];
  for (const line of traceLines) {
    const match = line.match(/\b([A-Za-z0-9_]+)\((.*)\)\s+=\s+(.+?)\s+<([0-9.]+)>$/);
    if (!match) continue;
    const [, syscall, args, result, seconds] = match;
    const durationMs = Number(seconds) * 1000;
    const timestamp = Number(line.match(/^\s*(\d+\.\d+)\s+/)?.[1]);
    const row = { syscall, durationMs: Number.isFinite(durationMs) ? durationMs : null, result: result.slice(0, 120), line: line.slice(0, 700) };
    if (Number.isFinite(timestamp) && previousTimestamp !== null) {
      const gapMs = (timestamp - previousTimestamp) * 1000;
      if (gapMs >= 100) syscallGaps.push({ gapMs, previousSyscall: calls.at(-1)?.syscall || 'unknown', nextSyscall: syscall });
    }
    if (Number.isFinite(timestamp)) previousTimestamp = timestamp;
    calls.push(row);
    if (!counts[syscall]) counts[syscall] = { syscall, calls: 0, errors: 0, totalDurationMs: 0, maxDurationMs: 0 };
    counts[syscall].calls++;
    if (result.trim().startsWith('-1')) counts[syscall].errors++;
    if (Number.isFinite(durationMs)) {
      counts[syscall].totalDurationMs += durationMs;
      counts[syscall].maxDurationMs = Math.max(counts[syscall].maxDurationMs, durationMs);
    }
    row.args = args.slice(0, 320);
  }
  return {
    totalCalls: calls.length,
    topSyscalls: Object.values(counts).sort((a, b) => b.totalDurationMs - a.totalDurationMs).slice(0, 20),
    slowCalls: [...calls].sort((a, b) => (b.durationMs || 0) - (a.durationMs || 0)).slice(0, 16),
    syscallGaps: syscallGaps.sort((a, b) => b.gapMs - a.gapMs).slice(0, 16),
    pollCalls: calls.filter(call => ['poll', 'ppoll', 'epoll_wait', 'epoll_pwait', 'select', 'pselect6'].includes(call.syscall)).slice(-16),
    fileErrors: calls.filter(call => ['open', 'openat', 'faccessat', 'newfstatat', 'readlinkat'].includes(call.syscall) && call.result.startsWith('-1')).slice(-16),
  };
}

function log(stage, fields = {}) {
  try {
    process.stdout.write(JSON.stringify({
      timestamp: new Date().toISOString(),
      runId,
      elapsedMs: Date.now() - startedAt,
      stage,
      ...fields,
    }) + '\n');
  } catch {}
}

function logTextChunks(stage, value, chunkSize = 700) {
  const text = String(value || '');
  const total = Math.ceil(text.length / chunkSize);
  log(stage + '.start', { bytes: Buffer.byteLength(text), chunks: total });
  for (let index = 0; index < total; index++) {
    log(stage + '.chunk', { index: index + 1, total, text: text.slice(index * chunkSize, (index + 1) * chunkSize) });
  }
}

process.stdout.on('error', () => {
  process.exitCode = 1;
});

function rejectPending(error) {
  for (const waiter of pending.values()) waiter.reject(error);
  pending.clear();
}

function summarizeResponse(message) {
  if (message.error) {
    return { id: message.id, errorCode: message.error.code, errorMessage: message.error.message };
  }
  if (message.id === 1) {
    return {
      id: message.id,
      product: message.result && message.result.product,
      protocolVersion: message.result && message.result.protocolVersion,
      revisionPresent: Boolean(message.result && message.result.revision),
      userAgentPresent: Boolean(message.result && message.result.userAgent),
    };
  }
  if (message.id === 2) {
    const targets = Array.isArray(message.result && message.result.targetInfos) ? message.result.targetInfos : [];
    return {
      id: message.id,
      targetCount: targets.length,
      targetTypes: [...new Set(targets.map(target => String(target.type || 'unknown')))].sort(),
    };
  }
  if (message.id === 3) {
    return { id: message.id, targetIdPresent: Boolean(message.result && message.result.targetId) };
  }
  if (message.id === 4) {
    return { id: message.id, sessionIdPresent: Boolean(message.result && message.result.sessionId) };
  }
  if (message.id === 5) {
    const result = message.result && message.result.result;
    return {
      id: message.id,
      resultType: result && result.type,
      value: result && typeof result.value === 'string' ? result.value.slice(0, 500) : undefined,
      exceptionPresent: Boolean(message.result && message.result.exceptionDetails),
      exceptionText: message.result && message.result.exceptionDetails
        ? String(message.result.exceptionDetails.text || '').slice(0, 240)
        : undefined,
    };
  }
  if (message.id === 6) {
    return {
      id: message.id,
      screenshotBytes: message.result && typeof message.result.data === 'string'
        ? Buffer.byteLength(message.result.data, 'base64')
        : 0,
    };
  }
  return { id: message.id, method: message.method || 'event' };
}

function handlePipeData(chunk) {
  pendingBytes = Buffer.concat([pendingBytes, Buffer.from(chunk)]);
  for (;;) {
    const separator = pendingBytes.indexOf(0);
    if (separator < 0) break;
    const frame = pendingBytes.subarray(0, separator);
    pendingBytes = pendingBytes.subarray(separator + 1);
    if (frame.length === 0) continue;
    let message;
    try {
      message = JSON.parse(frame.toString('utf8'));
    } catch {
      log('pipe.message.invalid-json', { frameBytes: frame.length });
      continue;
    }
    const result = summarizeResponse(message);
    if (Number.isSafeInteger(message.id) && pending.has(message.id)) {
      const waiter = pending.get(message.id);
      pending.delete(message.id);
      log('pipe.response', result);
      waiter.resolve(message);
    } else if (message.method) {
      log('pipe.event', { method: message.method });
    }
  }
}

function sendCommand(input, method, params = {}, sessionId) {
  const id = nextMessageId++;
  return new Promise((resolve, reject) => {
    const remainingMs = Math.max(1, Math.min(timeoutMs, deadlineAt - Date.now()));
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error('No response to ' + method + ' before the pipe probe deadline.'));
    }, remainingMs);
    pending.set(id, {
      resolve: message => {
        clearTimeout(timer);
        resolve(message);
      },
      reject: error => {
        clearTimeout(timer);
        reject(error);
      },
    });
    const command = { id, method };
    if (Object.keys(params).length > 0) command.params = params;
    if (sessionId) command.sessionId = sessionId;
    input.write(JSON.stringify(command) + '\0', error => {
      if (!error) return;
      clearTimeout(timer);
      pending.delete(id);
      reject(error);
    });
    log('pipe.command.sent', { id, method });
  });
}

function runCommand(program, args, timeoutMs = 5_000) {
  execFileSync(program, args, { stdio: 'ignore', timeout: timeoutMs });
}

function systemBusResponds() {
  try {
    execFileSync('/usr/bin/dbus-send', [
      '--system', '--dest=org.freedesktop.DBus', '--type=method_call', '--print-reply',
      '/org/freedesktop/DBus', 'org.freedesktop.DBus.ListNames',
    ], { stdio: 'ignore', timeout: 5_000 });
    return true;
  } catch {
    return false;
  }
}

async function ensureSystemBus() {
  execFileSync('/usr/bin/dbus-uuidgen', ['--ensure=/etc/machine-id'], { stdio: 'ignore', timeout: 10_000 });
  if (systemBusResponds()) {
    log('system-dbus.ready', { source: 'responsive-existing-bus' });
    return;
  }
  const socketPath = '/run/dbus/system_bus_socket';
  if (existsSync(socketPath)) {
    const listeners = execFileSync('/usr/bin/ss', ['-xlpn'], { encoding: 'utf8', timeout: 5_000 });
    if (listeners.includes(socketPath)) {
      throw new Error('The system D-Bus socket has a listener but ListNames did not respond.');
    }
    unlinkSync(socketPath);
    log('system-dbus.stale-socket.removed', { socketPath });
  }
  runCommand('/usr/bin/install', ['-d', '-m', '0755', '/run/dbus']);
  const address = execFileSync('/usr/bin/dbus-daemon', [
    '--system', '--fork', '--nopidfile', '--print-address=1',
  ], { encoding: 'utf8', timeout: 10_000 }).trim();
  log('system-dbus.started', { addressPresent: Boolean(address) });
  for (let attempt = 1; attempt <= 25; attempt++) {
    if (systemBusResponds()) {
      log('system-dbus.ready', { attempt, source: 'newly-started-bus' });
      return;
    }
    await delay(200);
  }
  throw new Error('The system D-Bus ListNames call did not respond after startup.');
}

async function startGui() {
  await ensureSystemBus();
  log('display.start', { display, resolution: '1280x800x24' });
  xvfb = spawn('/usr/bin/Xvfb', [
    display,
    '-screen', '0', '1280x800x24',
    '-nolisten', 'tcp', '-ac', '+extension', 'GLX', '+render', '-noreset',
  ], { stdio: ['ignore', 'ignore', 'pipe'], detached: true });
  const xvfbStderr = [];
  xvfb.stderr && xvfb.stderr.on('data', chunk => {
    const value = Buffer.from(chunk).toString('utf8').replace(/[\r\n]+/g, ' ').trim();
    if (value) xvfbStderr.push(value.slice(0, 300));
  });
  const displayDeadline = Date.now() + 12_000;
  let displayReady = false;
  let attempt = 0;
  while (Date.now() < displayDeadline) {
    attempt++;
    if (xvfb.exitCode !== null) throw new Error('Xvfb exited before the display became ready: ' + xvfbStderr.join(' | '));
    try {
      runCommand('/usr/bin/xdpyinfo', ['-display', display], 2_000);
      log('display.ready', { display, attempts: attempt, elapsedMs: 12_000 - Math.max(0, displayDeadline - Date.now()) });
      displayReady = true;
      break;
    } catch {
      if (attempt % 3 === 1) {
        log('display.wait', {
          display,
          attempt,
          xvfbPid: xvfb.pid || 'unknown',
          xvfbState: xvfb.exitCode === null ? 'running' : xvfb.exitCode,
          socketPresent: existsSync('/tmp/.X11-unix/X' + display.replace(/^:/, '').split('.')[0]),
          lockPresent: existsSync('/tmp/.X' + display.replace(/^:/, '').split('.')[0] + '-lock'),
          stderrTail: xvfbStderr.slice(-3),
        });
      }
      if (Date.now() < displayDeadline) await delay(Math.min(200, displayDeadline - Date.now()));
    }
  }
  if (!displayReady) throw new Error('Xvfb display did not become ready within 12 seconds; last stderr: ' + xvfbStderr.slice(-5).join(' | '));

  const passwd = execFileSync('/usr/bin/getent', ['passwd', '1000'], { encoding: 'utf8', timeout: 5_000 }).trim().split(':');
  const desktopUid = Number(passwd[2]);
  const desktopGid = Number(passwd[3]);
  if (desktopUid !== 1000 || !Number.isSafeInteger(desktopGid)) {
    throw new Error('The template does not have a desktop user at UID 1000.');
  }
  xfce = spawn('/usr/bin/dbus-run-session', ['--', '/usr/bin/xfce4-session'], {
    env: { ...process.env, HOME: desktopHome, DISPLAY: display },
    uid: desktopUid,
    gid: desktopGid,
    stdio: ['ignore', 'ignore', 'pipe'],
    detached: true,
  });
  const xfceStderr = [];
  xfce.stderr && xfce.stderr.on('data', chunk => {
    const value = Buffer.from(chunk).toString('utf8').replace(/[\r\n]+/g, ' ').trim();
    if (value) xfceStderr.push(value.slice(0, 300));
  });
  log('xfce.started', { pid: xfce.pid || 'unknown', uid: desktopUid, display });
  await delay(5_000);
  if (xfce.exitCode !== null) throw new Error('XFCE exited during session startup: ' + xfceStderr.join(' | '));
  log('xfce.ready', { pid: xfce.pid || 'unknown', display });
  return { desktopUid, desktopGid };
}

function processHasExited(proc) {
  return (proc.exitCode !== null && proc.exitCode !== undefined)
    || (proc.signalCode !== null && proc.signalCode !== undefined);
}

function processGroupSnapshot(processGroupId) {
  const livePids = [];
  const zombiePids = [];
  let complete = true;
  for (const entry of readdirSync('/proc')) {
    if (!/^\d+$/.test(entry)) continue;
    try {
      const stat = readFileSync('/proc/' + entry + '/stat', 'utf8');
      const closeParen = stat.lastIndexOf(')');
      if (closeParen < 0) {
        complete = false;
        continue;
      }
      const fields = stat.slice(closeParen + 2).trim().split(/\s+/);
      const state = fields[0];
      const groupId = Number(fields[2]);
      if (groupId !== processGroupId) continue;
      if (state === 'Z' || state === 'X') zombiePids.push(Number(entry));
      else livePids.push(Number(entry));
    } catch (error) {
      if (!error || typeof error !== 'object' || !('code' in error) || !['ENOENT', 'ESRCH'].includes(error.code)) {
        complete = false;
      }
    }
  }
  return { livePids, zombiePids, complete };
}

function processGroupExists(pid) {
  if (!Number.isSafeInteger(pid) || pid < 2) return false;
  try {
    globalThis.process.kill(-pid, 0);
    return true;
  } catch (error) {
    return error && typeof error === 'object' && 'code' in error && error.code === 'ESRCH' ? false : true;
  }
}

function processGroupStopped(proc) {
  const pid = proc && Number.isSafeInteger(proc.pid) ? proc.pid : 0;
  if (pid < 2) return true;
  try {
    const snapshot = processGroupSnapshot(pid);
    if (snapshot.complete) {
      if (snapshot.livePids.length > 0) return false;
      if (snapshot.zombiePids.includes(pid)) return true;
      return processHasExited(proc) || !existsSync('/proc/' + pid);
    }
  } catch {}
  return processHasExited(proc) && !processGroupExists(pid);
}

async function waitForProcessGroup(proc, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (processGroupStopped(proc)) return true;
    await delay(50);
  }
  return processGroupStopped(proc);
}

async function stopProcessGroup(proc, label) {
  if (!proc || !proc.pid) return true;
  if (processHasExited(proc) && !processGroupExists(proc.pid)) return true;
  try {
    globalThis.process.kill(-proc.pid, 'SIGTERM');
  } catch {
    try { proc.kill('SIGTERM'); } catch {}
  }
  let stopped = await waitForProcessGroup(proc, 3_000);
  let forcedKill = false;
  if (!stopped) {
    forcedKill = true;
    try {
      globalThis.process.kill(-proc.pid, 'SIGKILL');
    } catch {
      try { proc.kill('SIGKILL'); } catch {}
    }
    stopped = await waitForProcessGroup(proc, 2_000);
  }
  const processGroup = Number.isSafeInteger(proc.pid)
    ? processGroupSnapshot(proc.pid)
    : { livePids: [], zombiePids: [], complete: false };
  log(label + '.cleanup', {
    stopped,
    forcedKill,
    exitCode: proc.exitCode === null ? 'none' : proc.exitCode,
    signalCode: proc.signalCode || 'none',
    processGroupEmpty: processGroup.complete ? processGroup.livePids.length === 0 : !processGroupExists(proc.pid),
    remainingLivePids: processGroup.livePids,
    remainingZombiePids: processGroup.zombiePids,
  });
  return stopped;
}

function processParentPid(pid) {
  try {
    const stat = readFileSync('/proc/' + pid + '/stat', 'utf8');
    const closeParen = stat.lastIndexOf(')');
    if (closeParen < 0) return 0;
    const fields = stat.slice(closeParen + 2).trim().split(/\s+/);
    const parentPid = Number(fields[1]);
    return Number.isSafeInteger(parentPid) && parentPid > 0 ? parentPid : 0;
  } catch {
    return 0;
  }
}

function isProcessDescendant(pid, ancestorPid) {
  let currentPid = pid;
  for (let depth = 0; depth < 16 && currentPid > 1; depth++) {
    if (currentPid === ancestorPid) return true;
    currentPid = processParentPid(currentPid);
  }
  return false;
}

function chromeMainProcess(launcherPid) {
  if (!Number.isSafeInteger(launcherPid) || launcherPid < 2) return { pid: 0, candidates: [] };
  const candidates = [];
  let fallback;
  for (const entry of readdirSync('/proc')) {
    if (!/^\d+$/.test(entry)) continue;
    try {
      const pid = Number(entry);
      if (!isProcessDescendant(pid, launcherPid)) continue;
      const executable = readlinkSync('/proc/' + entry + '/exe').replace(/ \(deleted\)$/, '');
      if (executable !== chrome) continue;
      const args = readFileSync('/proc/' + entry + '/cmdline').toString('utf8').split('\0').filter(Boolean);
      const typeArgument = args.find(argument => argument.startsWith('--type=')) || '';
      if (typeArgument && typeArgument !== '--type=browser') continue;
      const candidate = {
        pid,
        type: typeArgument || 'implicit-browser',
        fd3: descriptorTarget(pid, 3),
        fd4: descriptorTarget(pid, 4),
      };
      if (candidates.length < 8) candidates.push(candidate);
      if (typeArgument === '--type=browser') return { pid, candidate, candidates };
      if (candidate.fd3.startsWith('socket:') && candidate.fd4.startsWith('socket:')) {
        return { pid, candidate, candidates };
      }
      fallback ||= candidate;
    } catch {}
  }
  return { pid: fallback?.pid || 0, candidate: fallback || null, candidates };
}

function browserThreadIds(pid) {
  try {
    return readdirSync('/proc/' + pid + '/task').filter(tid => /^\d+$/.test(tid)).map(Number);
  } catch {
    return [];
  }
}

function descriptorTarget(pid, descriptor) {
  try {
    return readlinkSync('/proc/' + pid + '/fd/' + descriptor);
  } catch {
    return 'unavailable';
  }
}

function browserThreadSnapshot(pid) {
  const snapshots = [];
  for (const tid of browserThreadIds(pid)) {
    try {
      const base = '/proc/' + pid + '/task/' + tid;
      const stat = readFileSync(base + '/stat', 'utf8');
      const closeParen = stat.lastIndexOf(')');
      const fields = closeParen < 0 ? [] : stat.slice(closeParen + 2).trim().split(/\s+/);
      const status = readFileSync(base + '/status', 'utf8');
      const voluntary = status.match(/^voluntary_ctxt_switches:\s+(\d+)/m);
      const involuntary = status.match(/^nonvoluntary_ctxt_switches:\s+(\d+)/m);
      const userCpuTicks = Number(fields[11]);
      const systemCpuTicks = Number(fields[12]);
      let wchan = 'unavailable';
      try { wchan = readFileSync(base + '/wchan', 'utf8').trim() || 'empty'; } catch {}
      let syscall = 'unavailable';
      try { syscall = readFileSync(base + '/syscall', 'utf8').trim().slice(0, 320) || 'empty'; } catch (error) {
        syscall = 'unavailable:' + (error && typeof error === 'object' && 'code' in error ? error.code : 'unknown');
      }
      let comm = 'unknown';
      try { comm = readFileSync(base + '/comm', 'utf8').trim() || 'unknown'; } catch {}
      snapshots.push({
        tid,
        comm,
        state: fields[0] || 'unknown',
        wchan,
        syscall,
        userCpuTicks: Number.isFinite(userCpuTicks) ? userCpuTicks : null,
        systemCpuTicks: Number.isFinite(systemCpuTicks) ? systemCpuTicks : null,
        voluntaryContextSwitches: voluntary ? Number(voluntary[1]) : null,
        involuntaryContextSwitches: involuntary ? Number(involuntary[1]) : null,
      });
    } catch {}
  }
  return snapshots;
}

function logGuestPressureSnapshot(label) {
  const read = path => {
    try { return readFileSync(path, 'utf8').trim().replace(/[\r\n]+/g, ';').slice(0, 1200); }
    catch { return 'unavailable'; }
  };
  log('guest.resource.snapshot', {
    label,
    loadavg: read('/proc/loadavg'),
    cpuPressure: read('/proc/pressure/cpu'),
    memoryPressure: read('/proc/pressure/memory'),
    ioPressure: read('/proc/pressure/io'),
    cpuStat: read('/sys/fs/cgroup/cpu.stat'),
    memoryCurrent: read('/sys/fs/cgroup/memory.current'),
    memoryMax: read('/sys/fs/cgroup/memory.max'),
    memoryEvents: read('/sys/fs/cgroup/memory.events'),
  });
}

function logBrowserThreadSnapshot(label) {
  const wrapperPid = child && Number.isSafeInteger(child.pid) ? child.pid : 0;
  if (!wrapperPid || !existsSync('/proc/' + wrapperPid + '/task')) {
    log('chrome.thread.snapshot.skipped', { label, wrapperPid: wrapperPid || 'unknown', reason: 'process-task-directory-unavailable' });
    return;
  }
  const browserProcess = chromeMainProcess(wrapperPid);
  const pid = browserProcess.pid || wrapperPid;
  if (!existsSync('/proc/' + pid + '/task')) {
    log('chrome.thread.snapshot.skipped', { label, pid, wrapperPid, reason: 'browser-process-task-directory-unavailable' });
    return;
  }
  const snapshots = browserThreadSnapshot(pid);
  log('chrome.thread.snapshot.start', {
    label,
    pid,
    wrapperPid,
    browserPid: browserProcess.pid || 'unknown',
    pipeDescriptors: browserProcess.candidates,
    threadCount: snapshots.length,
  });
  logGuestPressureSnapshot(label);
  for (const snapshot of snapshots.slice(0, 24)) {
    log('chrome.thread.snapshot', { label, pid, wrapperPid, ...snapshot });
  }
  if (snapshots.length > 24) {
    log('chrome.thread.snapshot.truncated', { label, pid, wrapperPid, captured: 24, available: snapshots.length });
  }
}

function logChromeStartupTrace() {
  if (!traceStartup) return;
  if (!existsSync(startupTracePath)) {
    log('chrome.startup-trace.missing', { path: startupTracePath });
    return;
  }
  try {
    const contents = readFileSync(startupTracePath);
    if (contents.byteLength > 32 * 1024 * 1024) {
      log('chrome.startup-trace.skipped', { path: startupTracePath, bytes: contents.byteLength, reason: 'trace-exceeds-32MiB-diagnostic-limit' });
      return;
    }
    const parsed = JSON.parse(contents.toString('utf8'));
    const events = Array.isArray(parsed.traceEvents) ? parsed.traceEvents : [];
    const wrapperPid = child && Number.isSafeInteger(child.pid) ? child.pid : 0;
    const browserProcess = wrapperPid ? chromeMainProcess(wrapperPid) : { pid: 0 };
    const browserPid = browserProcess.pid || wrapperPid;
    const browserEvents = events
      .filter(event => event && event.pid === browserPid && typeof event.name === 'string')
      .sort((left, right) => Number(left.ts || 0) - Number(right.ts || 0));
    const names = new Map();
    for (const event of browserEvents) names.set(event.name, (names.get(event.name) || 0) + 1);
    log('chrome.startup-trace.summary', {
      path: startupTracePath,
      bytes: contents.byteLength,
      browserPid: browserPid || 'unknown',
      wrapperPid: wrapperPid || 'unknown',
      traceEventCount: events.length,
      browserEventCount: browserEvents.length,
      eventNames: [...names.entries()].sort((left, right) => right[1] - left[1]).slice(0, 30).map(([name, count]) => ({ name, count })),
    });
    for (const event of browserEvents.slice(0, 60)) {
      log('chrome.startup-trace.event', {
        name: event.name.slice(0, 160),
        category: typeof event.cat === 'string' ? event.cat.slice(0, 160) : '',
        phase: typeof event.ph === 'string' ? event.ph : '',
        timestampUs: Number.isFinite(event.ts) ? event.ts : null,
        durationUs: Number.isFinite(event.dur) ? event.dur : null,
        threadId: Number.isSafeInteger(event.tid) ? event.tid : null,
      });
    }
  } catch (error) {
    log('chrome.startup-trace.parse-failed', { path: startupTracePath, error: error instanceof Error ? error.message : String(error) });
  }
}

async function finishPipeTrace(reason) {
  if (straceFinishPromise) return straceFinishPromise;
  if (!straceProcess) return;
  straceFinishPromise = (async () => {
    if (straceTimer) clearTimeout(straceTimer);
    straceTimer = undefined;
    const trace = straceProcess;
    straceProcess = undefined;
    const browserThreadSnapshotsAtTraceEnd = straceTargetPids.flatMap(browserThreadSnapshot);
    const traceEndByTid = new Map(browserThreadSnapshotsAtTraceEnd.map(thread => [thread.tid, thread]));
    const browserThreadCpuDeltas = straceThreadSnapshotsAtAttach.flatMap(start => {
      const end = traceEndByTid.get(start.tid);
      if (!end) return [];
      return [{
        tid: start.tid,
        comm: start.comm,
        stateAtAttach: start.state,
        stateAtTraceEnd: end.state,
        userCpuTickDelta: start.userCpuTicks === null || end.userCpuTicks === null ? null : end.userCpuTicks - start.userCpuTicks,
        systemCpuTickDelta: start.systemCpuTicks === null || end.systemCpuTicks === null ? null : end.systemCpuTicks - start.systemCpuTicks,
        voluntaryContextSwitchDelta: start.voluntaryContextSwitches === null || end.voluntaryContextSwitches === null
          ? null
          : end.voluntaryContextSwitches - start.voluntaryContextSwitches,
        involuntaryContextSwitchDelta: start.involuntaryContextSwitches === null || end.involuntaryContextSwitches === null
          ? null
          : end.involuntaryContextSwitches - start.involuntaryContextSwitches,
        wchanAtTraceEnd: end.wchan,
      }];
    });
    const stopped = await stopProcessGroup(trace, 'strace');
    flushStraceStderr();
    if (!existsSync(straceLogPath)) {
      log('pipe.strace.summary', {
        reason,
        stopped,
        mode: straceMode,
        targetPids: straceTargetPids,
        threadCountAtAttach: straceThreadSnapshotsAtAttach.length,
        threadCountAtTraceEnd: browserThreadSnapshotsAtTraceEnd.length,
        logPresent: false,
      });
      for (const line of straceStderrTail.slice(-40)) log('pipe.strace.stderr', { line });
      return;
    }
    const traceText = readFileSync(straceLogPath, 'utf8');
    const threadIds = new Set([...straceThreadIds, ...browserThreadSnapshotsAtTraceEnd.map(thread => thread.tid)]);
    const traceLines = traceText.split(/\r?\n/).filter(Boolean);
    const browserSyscallLines = straceMode === 'trace' ? traceLines : traceLines.filter(line => {
      const tracePid = Number(line.match(/^\s*(\d+)\s+/)?.[1]);
      return Number.isSafeInteger(tracePid) && threadIds.has(tracePid);
    });
    const pipeSyscallsCaptured = straceMode === 'pipe';
    const pipeLines = pipeSyscallsCaptured
      ? browserSyscallLines.filter(line => /\b(?:read|write|readv|writev)\([34],/.test(line))
      : [];
    const lines = pipeLines;
    const fd3Read = lines.filter(line => /\bread(?:v)?\(3,/.test(line)).length;
    const fd4Write = lines.filter(line => /\bwrite(?:v)?\(4,/.test(line)).length;
    const fd4Read = lines.filter(line => /\bread(?:v)?\(4,/.test(line)).length;
    const fd3Write = lines.filter(line => /\bwrite(?:v)?\(3,/.test(line)).length;
    const syscallCounts = {};
    for (const line of browserSyscallLines) {
      const syscall = line.match(/\b([a-zA-Z0-9_]+)\(/)?.[1];
      if (syscall) syscallCounts[syscall] = (syscallCounts[syscall] || 0) + 1;
    }
    const tracedPids = [...new Set(traceLines
      .map(line => Number(line.match(/^\s*(\d+)\s+/)?.[1]))
      .filter(Number.isSafeInteger))];
    const unrelatedTracePids = tracedPids.filter(pid => !threadIds.has(pid));
    log('pipe.strace.summary', {
      reason,
      stopped,
      mode: straceMode,
      targetPids: straceTargetPids,
      threadCountAtAttach: straceThreadSnapshotsAtAttach.length,
      threadCountAtTraceEnd: browserThreadSnapshotsAtTraceEnd.length,
      fd3Target: straceFdTargets.fd3 || 'unavailable',
      fd4Target: straceFdTargets.fd4 || 'unavailable',
      logBytes: Buffer.byteLength(traceText),
      browserSyscallCount: straceMode === 'summary' ? null : browserSyscallLines.length,
      browserSyscallCounts: straceMode === 'summary' ? null : syscallCounts,
      pipeSyscallsCaptured,
      browserPipeSyscallCount: pipeSyscallsCaptured ? lines.length : null,
      excludedTraceProcessCount: straceMode === 'summary' ? null : unrelatedTracePids.length,
      fd3Read: pipeSyscallsCaptured ? fd3Read : null,
      fd4Write: pipeSyscallsCaptured ? fd4Write : null,
      fd4Read: pipeSyscallsCaptured ? fd4Read : null,
      fd3Write: pipeSyscallsCaptured ? fd3Write : null,
    });
    for (const snapshot of straceThreadSnapshotsAtAttach) {
      log('pipe.strace.thread.snapshot', { point: 'attach', ...snapshot });
    }
    for (const snapshot of browserThreadSnapshotsAtTraceEnd) {
      log('pipe.strace.thread.snapshot', { point: 'trace-end', ...snapshot });
    }
    for (const delta of browserThreadCpuDeltas) log('pipe.strace.thread.cpu-delta', delta);
    for (const line of lines.slice(0, 24)) log('pipe.strace.pipe-sample', { line: line.slice(0, 420) });
    for (const line of browserSyscallLines
      .filter(line => /\b(?:futex|epoll_wait|epoll_pwait|poll|ppoll|select|pselect6)\(/.test(line))
      .slice(-24)) {
      log('pipe.strace.wait-sample', { line: line.slice(0, 300) });
    }
    if (straceMode === 'summary') logTextChunks('pipe.strace.syscall-summary', traceText.slice(0, 12_000));
    if (straceMode === 'trace') {
      const syscallTrace = summarizeSyscallTrace(traceLines);
      log('pipe.strace.call-summary', { totalCalls: syscallTrace.totalCalls, syscallKinds: syscallTrace.topSyscalls.length });
      for (const call of syscallTrace.topSyscalls) log('pipe.strace.call-stat', call);
      for (const call of syscallTrace.slowCalls) log('pipe.strace.slow-call', call);
      for (const gap of syscallTrace.syscallGaps) log('pipe.strace.syscall-gap', gap);
      for (const call of syscallTrace.pollCalls) log('pipe.strace.poll-call', call);
      for (const call of syscallTrace.fileErrors) log('pipe.strace.file-error', call);
    }
    for (const line of straceStderrTail.slice(-40)) log('pipe.strace.stderr', { line });
    if (stopped) {
      try {
        unlinkSync(straceLogPath);
        log('pipe.strace.cleanup.complete', { path: straceLogPath });
      } catch (error) {
        log('pipe.strace.cleanup.failed', { path: straceLogPath, error: error instanceof Error ? error.message : String(error) });
      }
    } else {
      log('pipe.strace.cleanup.skipped', { path: straceLogPath, reason: 'tracer-process-group-not-confirmed-stopped' });
    }
  })();
  return straceFinishPromise;
}

async function startPipeTrace() {
  if (!stracePath) return;
  const deadline = Date.now() + 10_000;
  const searchStartedAt = Date.now();
  log('pipe.strace.process-search.start', { launcherPid: child && child.pid || null, deadlineMs: 10_000, mode: straceMode });
  let found = { pid: 0, candidates: [] };
  while (Date.now() < deadline && !found.pid) {
    found = chromeMainProcess(child && child.pid);
    if (!found.pid) await delay(100);
  }
  if (!found.pid) {
    log('pipe.strace.skipped', {
      reason: 'chrome-main-process-not-found',
      searchElapsedMs: Date.now() - searchStartedAt,
      processCandidates: found.candidates,
    });
    return;
  }
  const pid = found.pid;
  log('pipe.strace.process-search.complete', { pid, searchElapsedMs: Date.now() - searchStartedAt, candidate: found.candidate });
  straceTargetPids = [pid];
  straceThreadIds = browserThreadIds(pid);
  straceThreadSnapshotsAtAttach = straceTargetPids.flatMap(browserThreadSnapshot);
  straceFdTargets = { fd3: descriptorTarget(pid, 3), fd4: descriptorTarget(pid, 4) };
  const args = straceMode === 'summary'
    ? ['-c', '-w', '-qq', '-o', straceLogPath, '-p', String(pid)]
    : straceMode === 'trace'
      ? [
        '-qq', '-ttt', '-T', '-s', '160',
        '-e', 'trace=clone,clone3,fork,vfork,mprotect,ppoll,openat,futex,close,gettid,mkdirat,faccessat,newfstatat,readlinkat,mmap,wait4,epoll_wait,epoll_pwait,poll,select,pselect6,connect,recvfrom,sendto,ioctl,clock_nanosleep,nanosleep,prctl,seccomp,memfd_create,socket,socketpair,bind,listen,accept4,fcntl,sched_yield',
        '-o', straceLogPath, '-p', String(pid),
      ]
      : [
      '-f', '-qq', '-ttt', '-T', '-s', '160',
      '-e', 'trace=read,write,readv,writev,futex,epoll_wait,epoll_pwait,poll,ppoll,select,pselect6,connect,recvfrom,sendto,recvmsg,sendmsg,ioctl',
      '-o', straceLogPath, '-p', String(pid),
    ];
  straceProcess = spawn(stracePath, args, { stdio: ['ignore', 'ignore', 'pipe'], detached: true });
  straceProcess.stderr && straceProcess.stderr.on('data', collectStraceStderr);
  straceProcess.once('error', error => {
    log('pipe.strace.spawn.error', { errorName: error.name, message: error.message.slice(0, 240) });
  });
  await delay(400);
  if (processHasExited(straceProcess)) {
    log('pipe.strace.attach.failed', {
      targetPids: straceTargetPids,
      exitCode: straceProcess.exitCode === null ? 'none' : straceProcess.exitCode,
      signalCode: straceProcess.signalCode || 'none',
      errorTail: straceStderrTail.slice(-6),
    });
    await finishPipeTrace('attach-process-exited');
    return;
  }
  log('pipe.strace.attach.started', {
    mode: straceMode,
    targetPids: straceTargetPids,
    browserThreadIdsAtAttach: straceThreadIds,
    browserThreadSnapshotsAtAttach: straceThreadSnapshotsAtAttach,
    fd3Target: straceFdTargets.fd3,
    fd4Target: straceFdTargets.fd4,
    straceWindowMs,
    logPath: straceLogPath,
  });
  straceTimer = setTimeout(() => { void finishPipeTrace('bounded-window-complete'); }, straceWindowMs);
}

function cleanupXvfbArtifacts(proc, stopped) {
  const displayMatch = display.match(/^:([0-9]+)$/);
  if (!proc?.pid || !stopped || !displayMatch) {
    log('display.cleanup.skipped', { reason: 'xvfb-or-display-identity-unconfirmed' });
    return;
  }
  const displayNumber = displayMatch[1];
  const lockPath = '/tmp/.X' + displayNumber + '-lock';
  const socketPath = '/tmp/.X11-unix/X' + displayNumber;
  if (!existsSync(lockPath)) {
    if (!existsSync(socketPath)) {
      log('display.cleanup.complete', { display, lockRemoved: true, socketRemoved: true, removedByXvfb: true });
    } else {
      log('display.cleanup.skipped', { reason: 'xvfb-lock-missing-socket-remains', display });
    }
    return;
  }
  const lockPid = Number(readFileSync(lockPath, 'utf8').trim());
  if (lockPid !== proc.pid || !processGroupStopped(proc.pid)) {
    log('display.cleanup.skipped', { reason: 'xvfb-lock-owner-not-confirmed', display, expectedPid: proc.pid, lockPid: Number.isSafeInteger(lockPid) ? lockPid : 'invalid' });
    return;
  }
  let socketRemoved = false;
  if (existsSync(socketPath)) {
    if (!lstatSync(socketPath).isSocket()) {
      log('display.cleanup.skipped', { reason: 'x11-path-is-not-a-socket', display });
      return;
    }
    unlinkSync(socketPath);
    socketRemoved = true;
  }
  unlinkSync(lockPath);
  log('display.cleanup.complete', { display, lockPid, socketRemoved, lockRemoved: true });
}

try {
  const minimumTimeoutMs = guiMode ? 30_000 : 5_000;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < minimumTimeoutMs || timeoutMs > 360_000) {
    throw new Error('CSA_CHROME_PIPE_TIMEOUT_MS must be between ' + minimumTimeoutMs + ' and 360000 for the selected GUI mode.');
  }
  if (stracePath && (!stracePath.startsWith('/') || stracePath.includes('\0'))) {
    throw new Error('CSA_CHROME_PIPE_STRACE_PATH must be an absolute guest path.');
  }
  if (!Number.isSafeInteger(straceWindowMs) || straceWindowMs < 1_000 || straceWindowMs > 30_000) {
    throw new Error('CSA_CHROME_PIPE_STRACE_WINDOW_MS must be between 1000 and 30000.');
  }
  if (!['none', 'pipe', 'summary', 'trace'].includes(straceMode)) {
    throw new Error('CSA_CHROME_PIPE_STRACE_MODE must be none, pipe, summary, or trace.');
  }
  if (process.env.CSA_CHROME_PIPE_TRACE_STARTUP && !['0', '1'].includes(process.env.CSA_CHROME_PIPE_TRACE_STARTUP)) {
    throw new Error('CSA_CHROME_PIPE_TRACE_STARTUP must be 0 or 1.');
  }
  if (requestedProfileRoot && requestedProfileRoot !== '/tmp') {
    throw new Error('CSA_CHROME_PIPE_PROFILE_ROOT, when set, must be /tmp.');
  }
  log('preflight.start', {
    chrome,
    transport: 'remote-debugging-pipe',
    timeoutMs,
    headless: !guiMode,
    guiMode,
    display: guiMode ? display : 'none',
    profileRoot,
  });
  const desktopIdentity = guiMode ? await startGui() : undefined;
  const chromeArgs = [
    '--no-sandbox',
    '--disable-dev-shm-usage',
    '--disable-gpu',
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-background-networking',
    '--remote-debugging-pipe',
    '--user-data-dir=' + profile,
    'about:blank',
  ];
  if (guiMode) chromeArgs.splice(0, 0, '--start-maximized');
  else chromeArgs.splice(0, 0, '--headless=new');
  if (traceStartup) {
    chromeArgs.splice(chromeArgs.length - 1, 0,
      '--trace-startup=-*,toplevel,disabled-by-default-sequence_manager',
      '--trace-startup-file=' + startupTracePath,
      '--trace-startup-duration=10');
    log('chrome.startup-trace.enabled', { path: startupTracePath, durationSeconds: 10, categories: 'toplevel,disabled-by-default-sequence_manager' });
  }
  const chromeEnv = guiMode
    ? { ...process.env, HOME: desktopHome, DISPLAY: display }
    : { ...process.env, HOME: desktopHome };
  const chromeProgram = guiMode ? '/usr/bin/dbus-run-session' : chrome;
  const chromeProgramArgs = guiMode ? ['--', chrome, ...chromeArgs] : chromeArgs;
  const chromeOptions = {
    stdio: ['ignore', 'ignore', 'pipe', 'pipe', 'pipe'],
    env: chromeEnv,
    detached: true,
  };
  if (desktopIdentity) {
    chromeOptions.uid = desktopIdentity.desktopUid;
    chromeOptions.gid = desktopIdentity.desktopGid;
  }
  child = spawn(chromeProgram, chromeProgramArgs, chromeOptions);
  child.once('exit', (code, signal) => {
    log('chrome.process.exit', { code: code === null ? 'none' : code, signal: signal || 'none' });
    rejectPending(new Error('Chrome exited before returning all pipe responses.'));
  });
  const input = child.stdio[3];
  const output = child.stdio[4];
  if (!input || typeof input.write !== 'function' || !output || typeof output.on !== 'function') {
    throw new Error('Node did not create the required Chrome pipe descriptors 3 and 4.');
  }
  output.on('data', handlePipeData);
  input.on('error', error => {
    log('pipe.input.error', { errorName: error.name, errorCode: error.code || 'unknown', message: error.message.slice(0, 240) });
    rejectPending(error);
  });
  output.on('error', error => {
    log('pipe.output.error', { errorName: error.name, errorCode: error.code || 'unknown', message: error.message.slice(0, 240) });
    rejectPending(error);
  });
  child.stderr && child.stderr.on('data', chunk => {
    const text = Buffer.from(chunk).toString('utf8').replace(/[\r\n]+/g, ' ').trim();
    if (!text) return;
    stderrTail.push(text.slice(0, 500));
    if (stderrTail.length > 8) stderrTail.shift();
  });
  child.once('error', error => {
    log('chrome.spawn.error', { error: error.message });
    rejectPending(error);
  });
  log('chrome.spawned', {
    pid: child.pid || 'unknown',
    profile,
    args: (guiMode ? 'gui' : 'headless') + ',no-sandbox,remote-debugging-pipe',
  });

  await startPipeTrace();
  deadlineAt = Date.now() + timeoutMs;
  log('pipe.command.deadline.start', { timeoutMs, deadlineFrom: 'Browser.getVersion' });
  const versionPromise = sendCommand(input, 'Browser.getVersion');
  const threadSnapshotTimers = [5_000, 20_000].map(delayMs => setTimeout(() => {
    try { logBrowserThreadSnapshot(`${delayMs / 1000}s-after-Browser.getVersion`); }
    catch (error) { log('chrome.thread.snapshot.error', { error: error instanceof Error ? error.message : String(error) }); }
  }, delayMs));
  let version;
  try {
    version = await versionPromise;
  } finally {
    for (const timer of threadSnapshotTimers) clearTimeout(timer);
  }
  if (version.error) throw new Error('Browser.getVersion failed: ' + (version.error.message || version.error.code));
  const targets = await sendCommand(input, 'Target.getTargets');
  if (targets.error) throw new Error('Target.getTargets failed: ' + (targets.error.message || targets.error.code));
  const created = await sendCommand(input, 'Target.createTarget', {
    url: 'about:blank',
    background: false,
  });
  if (created.error || !created.result || !created.result.targetId) {
    throw new Error('Target.createTarget failed: ' + (created.error && created.error.message || 'target id missing'));
  }
  const attached = await sendCommand(input, 'Target.attachToTarget', {
    targetId: created.result.targetId,
    flatten: true,
  });
  if (attached.error || !attached.result || !attached.result.sessionId) {
    throw new Error('Target.attachToTarget failed: ' + (attached.error && attached.error.message || 'session id missing'));
  }
  const evaluated = await sendCommand(input, 'Runtime.evaluate', {
    expression: '(()=>{document.title="CSA Desktop Pipe Probe";let b=document.body;if(!b){b=document.createElement("body");document.documentElement.append(b)}b.textContent="desktop pipe ok";return JSON.stringify({title:document.title,body:b.innerText,readyState:document.readyState})})()',
    returnByValue: true,
  }, attached.result.sessionId);
  if (evaluated.error || evaluated.result && evaluated.result.exceptionDetails) {
    throw new Error('Runtime.evaluate failed: ' + (evaluated.error && evaluated.error.message || 'renderer exception'));
  }
  const screenshot = await sendCommand(input, 'Page.captureScreenshot', {}, attached.result.sessionId);
  if (screenshot.error || !screenshot.result || typeof screenshot.result.data !== 'string') {
    throw new Error('Page.captureScreenshot failed: ' + (screenshot.error && screenshot.error.message || 'image missing'));
  }
  log('pipe.probe.complete', {
    browserVersionResponse: true,
    targetListResponse: true,
    pageCreated: true,
    runtimeEvaluation: true,
    screenshotBytes: Buffer.byteLength(screenshot.result.data, 'base64'),
    guiMode,
  });
  process.exitCode = 0;
} catch (error) {
  log('pipe.probe.failed', {
    error: error instanceof Error ? error.message : String(error),
    chromeExitCode: child && child.exitCode !== null ? child.exitCode : 'running-or-unknown',
    stderrTail,
  });
  try { logBrowserThreadSnapshot('pipe-probe-failed'); }
  catch (snapshotError) { log('chrome.thread.snapshot.error', { error: snapshotError instanceof Error ? snapshotError.message : String(snapshotError) }); }
  process.exitCode = 1;
} finally {
  rejectPending(new Error('Pipe probe ended before response.'));
  await finishPipeTrace('probe-cleanup').catch(error => log('pipe.strace.cleanup.error', { error: error instanceof Error ? error.message : String(error) }));
  const chromeStopped = await stopProcessGroup(child, 'chrome').catch(error => {
    log('chrome.cleanup.error', { error: String(error) });
    return false;
  });
  await stopProcessGroup(xfce, 'xfce').catch(error => log('xfce.cleanup.error', { error: String(error) }));
  const xvfbStopped = await stopProcessGroup(xvfb, 'xvfb').catch(error => {
    log('xvfb.cleanup.error', { error: String(error) });
    return false;
  });
  cleanupXvfbArtifacts(xvfb, xvfbStopped);
  if (chromeStopped) {
    logChromeStartupTrace();
    try {
      rmSync(profile, { recursive: true, force: true, maxRetries: 2, retryDelay: 100 });
      log('profile.cleanup.complete', { path: profile, recursive: true });
    } catch (error) {
      log('profile.cleanup.failed', { path: profile, error: error instanceof Error ? error.message : String(error) });
    }
  } else {
    log('profile.cleanup.skipped', { reason: 'chrome-process-group-not-confirmed-stopped', path: profile });
  }
  if (chromeStopped && traceStartup) {
    try {
      rmSync(startupTracePath, { force: true, maxRetries: 2, retryDelay: 100 });
      log('chrome.startup-trace.cleanup.complete', { path: startupTracePath });
    } catch (error) {
      log('chrome.startup-trace.cleanup.failed', { path: startupTracePath, error: error instanceof Error ? error.message : String(error) });
    }
  }
  log('chrome.cleanup.complete', {
    exitCode: child && child.exitCode !== null ? child.exitCode : 'unknown',
    signalCode: child ? child.signalCode || 'none' : 'none',
  });
}

const finalExitCode = process.exitCode === undefined ? 0 : process.exitCode;
await Promise.race([
  new Promise(resolve => process.stdout.write('', resolve)),
  delay(1_000),
]);
process.exit(finalExitCode);
