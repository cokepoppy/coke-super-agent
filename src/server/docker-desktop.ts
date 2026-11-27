import { createHash } from 'node:crypto';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import type { BrowserState, RunTraceEvent } from '../shared/types.ts';
import { config } from './config.ts';

const exec = promisify(execFile);
const runtimeRoot = '/var/lib/csa-agent-runtime';
const desktopUid = '1000';
const agentUid = '1001';
const desktopVolumeSuffix = '-desktop';
const runtimeVolumeSuffix = '-runtime';
const tenantUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const runUuid = tenantUuid;

export interface DockerDesktopTarget {
  hostname: '127.0.0.1';
  port: number;
  imageUpdated?: boolean;
}

export interface DockerDesktopProbe {
  ready: boolean;
  containerRunning: boolean;
  sessionReady: boolean;
  browserStatus: BrowserState;
  cdpReady: boolean;
  websockifyReady: boolean;
  cdpBrowser?: string;
}

export interface DockerAgentTaskInput {
  threadId: string;
  prompt: string;
  baseUrl: string;
  model: string;
  apiKey: string;
  terminalBridgeUrl: string;
  terminalBridgeToken: string;
}

export interface DockerAgentState {
  status?: 'working' | 'waiting_for_user' | 'done' | 'failed';
  stage?: string;
  errorName?: string;
  message?: string;
  pid?: number;
  updatedAt?: string;
  traces?: Array<RunTraceEvent & { sequence: number }>;
}

function tenantSuffix(tenantId: string): string {
  if (!tenantUuid.test(tenantId)) throw new Error('Tenant id is invalid for Docker runtime naming.');
  return createHash('sha256').update(tenantId).digest('hex').slice(0, 24);
}

export function tenantDockerContainerName(tenantId: string): string {
  return `csa-tenant-${tenantSuffix(tenantId)}`;
}

function volumeName(tenantId: string, suffix: string): string {
  return `${tenantDockerContainerName(tenantId)}${suffix}`;
}

function statePath(runId: string): string {
  if (!runUuid.test(runId)) throw new Error('Run id is invalid for Docker runtime paths.');
  return `${runtimeRoot}/.csa-super-agent/runs/${runId}`;
}

async function docker(args: string[], timeoutMs = 20_000, maxBuffer = 2 * 1024 * 1024): Promise<string> {
  const result = await exec(config.docker.executable, args, { timeout: timeoutMs, maxBuffer, encoding: 'utf8' });
  return String(result.stdout || '').trim();
}

async function dockerInput(args: string[], input: string, timeoutMs = 20_000): Promise<void> {
  await new Promise<void>((resolvePromise, rejectPromise) => {
    const child = spawn(config.docker.executable, args, { stdio: ['pipe', 'ignore', 'pipe'] });
    let stderr = '';
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk: string) => { stderr = (stderr + chunk).slice(-4_000); });
    const timer = setTimeout(() => child.kill('SIGKILL'), timeoutMs);
    child.once('error', error => {
      clearTimeout(timer);
      rejectPromise(error);
    });
    child.once('close', (code, signal) => {
      clearTimeout(timer);
      if (code === 0) resolvePromise();
      else rejectPromise(new Error(`Docker command failed (exit=${code ?? 'none'}, signal=${signal || 'none'}): ${stderr.trim().slice(-1200)}`));
    });
    child.stdin.end(input);
  });
}

async function containerExists(name: string): Promise<boolean> {
  try {
    await docker(['container', 'inspect', '--format', '{{.Id}}', name]);
    return true;
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    if (/no such object|no such container|not found/i.test(detail)) return false;
    throw error;
  }
}

async function volumeExists(name: string): Promise<boolean> {
  try {
    await docker(['volume', 'inspect', '--format', '{{.Name}}', name]);
    return true;
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    if (/no such volume|not found/i.test(detail)) return false;
    throw error;
  }
}

async function ensureTenantVolumes(tenantId: string): Promise<void> {
  for (const name of [volumeName(tenantId, desktopVolumeSuffix), volumeName(tenantId, runtimeVolumeSuffix)]) {
    if (!await volumeExists(name)) await docker(['volume', 'create', name]);
  }
}

async function hostPort(name: string): Promise<number> {
  const mapping = await docker(['port', name, '6080/tcp']);
  const match = mapping.match(/(?:127\.0\.0\.1|localhost):([0-9]+)$/m);
  const port = Number(match?.[1]);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Docker desktop did not publish its loopback noVNC port.');
  return port;
}

export async function ensureTenantDockerDesktop(tenantId: string): Promise<DockerDesktopTarget> {
  const name = tenantDockerContainerName(tenantId);
  const exists = await containerExists(name);
  if (exists) {
    const image = await docker(['container', 'inspect', '--format', '{{.Config.Image}}', name]);
    if (image !== config.docker.desktopImage) {
      const role = await docker(['container', 'inspect', '--format', '{{index .Config.Labels "com.coke-super-agent.role"}}', name]);
      const tenantLabel = await docker(['container', 'inspect', '--format', '{{index .Config.Labels "com.coke-super-agent.tenant"}}', name]);
      const mounts = await docker(['container', 'inspect', '--format', '{{range .Mounts}}{{println .Name .Destination}}{{end}}', name]);
      const desktopVolume = volumeName(tenantId, desktopVolumeSuffix);
      const runtimeVolume = volumeName(tenantId, runtimeVolumeSuffix);
      if (role !== 'tenant-desktop-dsh' || tenantLabel !== tenantSuffix(tenantId)
        || !mounts.split(/\r?\n/).some(line => line.trim() === `${desktopVolume} /workspace`)
        || !mounts.split(/\r?\n/).some(line => line.trim() === `${runtimeVolume} ${runtimeRoot}`)) {
        throw new Error(`Tenant Docker desktop image mismatch (found=${image}, expected=${config.docker.desktopImage}); container identity or persistent volumes do not match, so it was preserved.`);
      }
      const running = await docker(['container', 'inspect', '--format', '{{.State.Running}}', name]);
      if (running === 'true') {
        const activePids = await docker(['exec', name, '/usr/bin/pgrep', '-f', 'run-task.bundle.mjs'], 10_000)
          .then(value => value.split(/\s+/).filter(pid => /^\d+$/.test(pid)))
          .catch(error => {
            if (String((error as NodeJS.ErrnoException).code) === '1') return [];
            throw error;
          });
        for (const pid of activePids) {
          const commandLine = await docker(['exec', name, '/usr/bin/cat', `/proc/${pid}/cmdline`], 5_000).catch(() => '');
          if (commandLine.replace(/\0/g, ' ').includes('run-task.bundle.mjs')) {
            throw new Error(`Tenant Docker desktop image update is deferred because DSH PID ${pid} is still running.`);
          }
        }
        await docker(['stop', '--time', '20', name], 60_000);
      }
      await docker(['container', 'rm', name], 60_000);
      const target = await createTenantDockerDesktopContainer(tenantId, name);
      return { ...target, imageUpdated: true };
    }
    const running = await docker(['container', 'inspect', '--format', '{{.State.Running}}', name]);
    if (running !== 'true') await docker(['start', name], 60_000);
    return { hostname: '127.0.0.1', port: await hostPort(name) };
  }

  return createTenantDockerDesktopContainer(tenantId, name);
}

async function createTenantDockerDesktopContainer(tenantId: string, name: string): Promise<DockerDesktopTarget> {
  await ensureTenantVolumes(tenantId);
  await docker([
    'run', '--detach', '--name', name,
    '--restart', 'unless-stopped',
    '--label', 'com.coke-super-agent.role=tenant-desktop-dsh',
    '--label', `com.coke-super-agent.tenant=${tenantSuffix(tenantId)}`,
    '--cpus', config.docker.desktopCpus,
    '--memory', config.docker.desktopMemory,
    '--pids-limit', '512',
    '--shm-size', config.docker.desktopShmSize,
    '--security-opt', 'no-new-privileges',
    '--publish', '127.0.0.1::6080/tcp',
    '--mount', `type=volume,source=${volumeName(tenantId, desktopVolumeSuffix)},target=/workspace`,
    '--mount', `type=volume,source=${volumeName(tenantId, runtimeVolumeSuffix)},target=${runtimeRoot}`,
    '--env', `CSA_TENANT_ID=${tenantId}`,
    '--env', `CSA_DSH_STATE_ROOT=${runtimeRoot}`,
    '--env', `COKE_DESKTOP_RESOLUTION=${config.agent.desktopResolution}`,
    '--env', 'COKE_DESKTOP_CHROME_BIN=/opt/google/chrome/chrome',
    '--env', 'COKE_DESKTOP_CHROME_NO_SANDBOX=1',
    config.docker.desktopImage,
  ], 120_000);
  return { hostname: '127.0.0.1', port: await hostPort(name) };
}

export async function getTenantDockerDesktopTarget(tenantId: string): Promise<DockerDesktopTarget> {
  const name = tenantDockerContainerName(tenantId);
  const running = await docker(['container', 'inspect', '--format', '{{.State.Running}}', name]);
  if (running !== 'true') throw new Error('Tenant Docker desktop container is not running.');
  return { hostname: '127.0.0.1', port: await hostPort(name) };
}

async function execContainer(tenantId: string, args: string[], timeoutMs = 10_000, maxBuffer = 2 * 1024 * 1024): Promise<string> {
  const name = tenantDockerContainerName(tenantId);
  return docker(['exec', name, ...args], timeoutMs, maxBuffer);
}

async function readContainerFile(tenantId: string, path: string): Promise<string> {
  try { return await execContainer(tenantId, ['/usr/bin/cat', path]); }
  catch { return ''; }
}

async function probeHttpStatus(tenantId: string, url: string): Promise<{ status: number; body: string }> {
  try {
    const output = await execContainer(tenantId, [
      '/usr/bin/curl', '--silent', '--show-error', '--max-time', '3',
      '--output', '-', '--write-out', '\nCSA_HTTP_STATUS:%{http_code}', url,
    ], 5_000);
    const marker = output.lastIndexOf('\nCSA_HTTP_STATUS:');
    if (marker < 0) return { status: 0, body: '' };
    return { status: Number(output.slice(marker + 17).trim()), body: output.slice(0, marker) };
  } catch { return { status: 0, body: '' }; }
}

export async function probeTenantDockerDesktop(tenantId: string): Promise<DockerDesktopProbe> {
  let containerRunning = false;
  try { containerRunning = await docker(['container', 'inspect', '--format', '{{.State.Running}}', tenantDockerContainerName(tenantId)]) === 'true'; }
  catch { /* The caller reports a not-ready desktop. */ }
  if (!containerRunning) return { ready: false, containerRunning: false, sessionReady: false, browserStatus: 'unavailable', cdpReady: false, websockifyReady: false };

  const [pidText, readyText, statusText, cdp, websockify] = await Promise.all([
    readContainerFile(tenantId, '/run/csa-desktop/session.pid'),
    readContainerFile(tenantId, '/run/csa-desktop/session.ready'),
    readContainerFile(tenantId, '/run/csa-desktop/browser.status'),
    probeHttpStatus(tenantId, 'http://127.0.0.1:9222/json/version'),
    probeHttpStatus(tenantId, 'http://127.0.0.1:6080/websockify'),
  ]);
  const pid = Number(pidText.trim());
  const validPid = Number.isSafeInteger(pid) && pid > 1;
  const [cmdline, processStatus] = validPid
    ? await Promise.all([
      readContainerFile(tenantId, `/proc/${pid}/cmdline`),
      readContainerFile(tenantId, `/proc/${pid}/status`),
    ])
    : ['', ''];
  const sessionReady = validPid
    && readyText.split(/\r?\n/).some(line => line.trim() === `pid=${pid}`)
    && cmdline.includes('csa-desktop-session')
    && !/^State:\s+Z/m.test(processStatus);
  const cdpReady = cdp.status === 200 && /"Browser"\s*:\s*"Chrome\//.test(cdp.body);
  // websockify answers HTTP requests with 400/405 and only upgrades WebSocket clients.
  const websockifyReady = websockify.status === 400 || websockify.status === 405;
  const rawStatus = statusText.trim().slice(0, 16);
  const browserStatus: BrowserState = rawStatus === 'failed'
    ? 'failed'
    : cdpReady && rawStatus === 'ready' ? 'ready'
      : rawStatus === 'starting' || (sessionReady && !cdpReady) ? 'starting'
        : 'unknown';
  return {
    ready: Boolean(sessionReady && cdpReady && websockifyReady),
    containerRunning,
    sessionReady: Boolean(sessionReady),
    browserStatus,
    cdpReady,
    websockifyReady,
    ...(cdpReady ? { cdpBrowser: String((JSON.parse(cdp.body) as { Browser?: unknown }).Browser || '').slice(0, 80) } : {}),
  };
}

export async function readTenantDockerBrowserState(tenantId: string): Promise<BrowserState> {
  const probe = await probeTenantDockerDesktop(tenantId);
  return probe.browserStatus;
}

export async function retryTenantDockerBrowser(tenantId: string): Promise<boolean> {
  const status = await readTenantDockerBrowserState(tenantId);
  if (status !== 'failed') return false;
  const name = tenantDockerContainerName(tenantId);
  await dockerInput(['exec', '--user', desktopUid, '-i', name, '/bin/sh', '-c', 'printf retry\\n > /run/csa-desktop/browser.retry'], '');
  return true;
}

export async function writeTenantDockerDshInput(tenantId: string, runId: string, input: DockerAgentTaskInput): Promise<void> {
  const directory = statePath(runId);
  const name = tenantDockerContainerName(tenantId);
  const task = JSON.stringify({ runId, ...input });
  if (Buffer.byteLength(task, 'utf8') > 256 * 1024) throw new Error('Docker DSH task input exceeds 256 KiB.');
  await docker(['exec', '--user', agentUid, name, '/usr/bin/mkdir', '-p', directory], 20_000);
  await dockerInput([
    'exec', '--user', agentUid, '-i', name,
    '/bin/sh', '-c', `umask 077; cat > ${directory}/input.json`,
  ], task, 20_000);
}

export async function tenantDockerDshLaunchIntentExists(tenantId: string, runId: string): Promise<boolean> {
  const path = `${statePath(runId)}/launch.intent`;
  try {
    await execContainer(tenantId, ['/usr/bin/test', '-f', path]);
    return true;
  } catch { return false; }
}

export async function createTenantDockerDshLaunchIntent(tenantId: string, runId: string): Promise<void> {
  const directory = statePath(runId);
  const path = `${directory}/launch.intent`;
  await dockerInput([
    'exec', '--user', agentUid, '-i', tenantDockerContainerName(tenantId),
    '/bin/sh', '-c', `umask 077; cat > ${path}`,
  ], `${new Date().toISOString()}\n`, 10_000);
}

export async function startTenantDockerDshTask(tenantId: string, runId: string, threadId: string): Promise<void> {
  if (!runUuid.test(runId) || !runUuid.test(threadId)) throw new Error('Docker DSH task identity is invalid.');
  const name = tenantDockerContainerName(tenantId);
  const taskDirectory = `${runtimeRoot}/tasks/${threadId}`;
  await docker(['exec', '--user', agentUid, name, '/usr/bin/mkdir', '-p', taskDirectory], 20_000);
  await docker([
    'exec', '--detach', '--user', agentUid,
    '--workdir', taskDirectory,
    '--env', `CSA_TENANT_ID=${tenantId}`,
    '--env', `CSA_RUN_ID=${runId}`,
    '--env', `CSA_DSH_STATE_ROOT=${runtimeRoot}`,
    '--env', `COKE_DESKTOP_RESOLUTION=${config.agent.desktopResolution}`,
    '--env', 'HOME=/var/lib/csa-agent-runtime/.csa-super-agent/dsh-home',
    '--env', 'DISPLAY=:1',
    '--env', 'PATH=/opt/csa-agent-runtime/bin:/opt/csa-agent-runtime:/usr/local/bin:/usr/bin:/bin',
    name,
    '/bin/sh', '-c',
    `exec /opt/csa-agent-runtime/bin/node /opt/csa-agent-runtime/dsh-sdk-client/dist/run-task.bundle.mjs ${runId} > ${statePath(runId)}/stdout.log 2>&1`,
  ], 20_000);
}

export async function readTenantDockerDshState(tenantId: string, runId: string): Promise<DockerAgentState | null> {
  let raw: string;
  try { raw = await execContainer(tenantId, ['/usr/bin/cat', `${statePath(runId)}/state.json`]); }
  catch { return null; }
  try {
    const value: unknown = JSON.parse(raw);
    return value && typeof value === 'object' ? value as DockerAgentState : null;
  } catch { return null; }
}

export async function tenantDockerDshProcessIsAlive(tenantId: string, pid: number, runId: string): Promise<boolean> {
  if (!Number.isSafeInteger(pid) || pid <= 0 || !runUuid.test(runId)) return false;
  const cmdline = await readContainerFile(tenantId, `/proc/${pid}/cmdline`);
  return cmdline.includes('run-task.bundle.mjs') && cmdline.includes(runId);
}

export async function tenantDockerDshTaskProcessExists(tenantId: string, runId: string): Promise<boolean> {
  if (!runUuid.test(runId)) return false;
  let pids: string[];
  try {
    pids = (await execContainer(tenantId, ['/usr/bin/pgrep', '-f', 'run-task.bundle.mjs'], 5_000))
      .split(/\s+/).filter(value => /^\d+$/.test(value));
  } catch { return false; }
  for (const pid of pids.slice(0, 64)) {
    const cmdline = await readContainerFile(tenantId, `/proc/${pid}/cmdline`);
    if (cmdline.includes('run-task.bundle.mjs') && cmdline.includes(runId)) return true;
  }
  return false;
}

export async function readTenantDockerDshOutput(tenantId: string, runId: string): Promise<string> {
  try {
    return (await execContainer(tenantId, ['/usr/bin/tail', '-c', '8192', '--', `${statePath(runId)}/stdout.log`], 10_000))
      .replace(/\u0000/g, '').trim().slice(-2_400);
  } catch { return ''; }
}

export async function listTenantDockerDshSessionFiles(tenantId: string, threadId: string): Promise<string[]> {
  if (!runUuid.test(threadId)) return [];
  const directory = `${runtimeRoot}/.csa-super-agent/dsh-home/sessions/--workspace-tasks-${threadId}--/${threadId}`;
  try {
    const output = await execContainer(tenantId, ['/usr/bin/find', directory, '-maxdepth', '1', '-type', 'f', '-name', 'session*.jsonl', '-printf', '%f\\n'], 10_000);
    return output.split(/\r?\n/).filter(name => /^session(?:\.v\d+)?\.jsonl$/.test(name)).sort((a, b) => {
      const version = (name: string) => Number(name.match(/^session\.v(\d+)\.jsonl$/)?.[1] || 0);
      return version(b) - version(a);
    });
  } catch { return []; }
}

export async function readTenantDockerDshSession(tenantId: string, threadId: string, file: string, maxBytes = 8 * 1024 * 1024): Promise<string | null> {
  if (!runUuid.test(threadId) || !/^session(?:\.v\d+)?\.jsonl$/.test(file)) return null;
  const directory = `${runtimeRoot}/.csa-super-agent/dsh-home/sessions/--workspace-tasks-${threadId}--/${threadId}`;
  const path = `${directory}/${file}`;
  try {
    const size = Number(await execContainer(tenantId, ['/usr/bin/stat', '-c', '%s', path], 10_000));
    if (!Number.isFinite(size) || size < 0 || size > maxBytes) return null;
    return await execContainer(tenantId, ['/usr/bin/cat', path], 10_000, maxBytes + 64 * 1024);
  } catch { return null; }
}
