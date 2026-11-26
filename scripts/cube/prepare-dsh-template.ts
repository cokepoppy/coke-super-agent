import { config as loadDotEnv } from 'dotenv';
import { Config, NEVER_TIMEOUT, Sandbox, SandboxNotFoundError, Template, type PtyHandle } from '@cubesandbox/sdk';
import { createHash, randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { appendFileSync, createReadStream, mkdirSync, writeFileSync } from 'node:fs';
import { readFile, stat, statfs } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { getGlobalDispatcher } from 'undici';
import type { RuntimeBundle } from '../../src/server/runtime-bundle.ts';
import { runGuestPty, stageRuntimeBundle, startGuestPty } from '../../src/server/runtime-bundle.ts';
import { hasSupportedPiRuntimeContract } from '../../src/shared/pi-runtime-contract.ts';
import { createPiRuntimeKey } from '../../src/shared/pi-runtime-key.ts';

const buildStartedAt = Date.now();
const buildRunId = randomUUID();
const buildLogDirectory = resolve(process.env.CSA_BUILD_LOG_DIR?.trim() || join(homedir(), '.local/share/csa-cube-node/build-logs'));
const buildLogTimestamp = new Date(buildStartedAt).toISOString().replaceAll(':', '-');
const buildLogPath = join(buildLogDirectory, `template-build-${buildLogTimestamp}-${buildRunId.slice(0, 8)}.jsonl`);
let config = {} as typeof import('../../src/server/config.ts')['config'];
const templateCreateTimeoutCandidate = Number(process.env.CSA_CUBE_TEMPLATE_CREATE_TIMEOUT_MS);
const templateCreateTimeoutMs = Number.isSafeInteger(templateCreateTimeoutCandidate) && templateCreateTimeoutCandidate > 0
  ? templateCreateTimeoutCandidate
  : 180_000;
let buildLogSequence = 0;
let buildLogWriteWarningReported = false;
let activeBuildPhase: { name: string; startedAt: number } | undefined;
const buildPhaseTimeline: Array<{ name: string; durationMs: number; result: 'complete' | 'failed' }> = [];
const sandboxLifecycleCheckAt = new WeakMap<Sandbox, number>();
const sandboxDataPlaneFailureAt = new WeakMap<Sandbox, number>();
const sandboxLifecycleCheckIntervalMs = 15_000;
const sandboxDataPlaneFailureLimitMs = 120_000;
mkdirSync(buildLogDirectory, { recursive: true, mode: 0o700 });
writeFileSync(buildLogPath, '', { flag: 'wx', mode: 0o600 });

function redactBuildText(value: string): string {
  let text = value;
  for (const secret of [config?.cube?.apiKey, config?.agent?.apiKey]) {
    if (secret) text = text.split(secret).join('[REDACTED]');
  }
  return text
    .replace(/https?:\/\/[^\s/@]+:[^\s/@]+@/gi, 'https://[redacted]@')
    .replace(/\b(Bearer|Basic)\s+[^\s"'`]+/gi, '$1 [REDACTED]')
    .replace(/\bsk-[A-Za-z0-9_-]{12,}\b/g, '[REDACTED]')
    .replace(/([?&](?:api[_-]?key|token|password|secret)=)[^&\s"']+/gi, '$1[REDACTED]')
    .replace(/((?:["'`])?[\w.-]*(?:api[_-]?key|password|token|secret|credential|authorization|cookie)[\w.-]*(?:["'`])?\s*[:=]\s*(?:["'`])?)[^"'`\s,;}]+/gi, '$1[REDACTED]');
}

function safeBuildValue(value: unknown, depth = 0): unknown {
  if (typeof value === 'string') return redactBuildText(value).slice(0, 2400);
  if (Array.isArray(value)) return value.slice(0, 80).map(item => safeBuildValue(item, depth + 1));
  if (!value || typeof value !== 'object') return value;
  if (depth >= 5) return '[truncated]';
  const sensitiveField = /(?:api.?key|password|token|secret|credential|authorization|cookie|headers?)/i;
  return Object.fromEntries(Object.entries(value).slice(0, 80).map(([key, item]) => [
    key,
    sensitiveField.test(key) ? '[REDACTED]' : safeBuildValue(item, depth + 1),
  ]));
}

function buildLog(stage: string, level: 'info' | 'warning' | 'error' = 'info', details: Record<string, unknown> = {}): void {
  const event = {
    timestamp: new Date().toISOString(),
    logger: 'coke-super-agent.template',
    runId: buildRunId,
    sequence: ++buildLogSequence,
    elapsedMs: Date.now() - buildStartedAt,
    ...(activeBuildPhase ? { phase: activeBuildPhase.name, phaseElapsedMs: Date.now() - activeBuildPhase.startedAt } : {}),
    logFile: buildLogPath,
    stage,
    level,
    ...safeBuildValue(details) as Record<string, unknown>,
  };
  const line = JSON.stringify(event) + '\n';
  try {
    appendFileSync(buildLogPath, line, { mode: 0o600 });
  } catch (error) {
    if (!buildLogWriteWarningReported) {
      buildLogWriteWarningReported = true;
      process.stderr.write(`Unable to persist template build log (${error instanceof Error ? error.name : 'Error'}).\n`);
    }
  }
  process.stdout.write(line);
}

function finishBuildPhase(result: 'complete' | 'failed' = 'complete', details: Record<string, unknown> = {}): void {
  if (!activeBuildPhase) return;
  const phase = activeBuildPhase;
  const durationMs = Date.now() - phase.startedAt;
  buildLog(result === 'complete' ? 'build.phase.complete' : 'build.phase.failed', result === 'complete' ? 'info' : 'error', {
    phaseName: phase.name,
    phaseDurationMs: durationMs,
    ...details,
  });
  buildPhaseTimeline.push({ name: phase.name, durationMs, result });
  activeBuildPhase = undefined;
}

function beginBuildPhase(name: string, details: Record<string, unknown> = {}): void {
  finishBuildPhase();
  activeBuildPhase = { name, startedAt: Date.now() };
  buildLog('build.phase.start', 'info', { phaseName: name, ...details });
}

beginBuildPhase('process-bootstrap');
const envFilePath = resolve(process.env.DOTENV_CONFIG_PATH?.trim() || '.env');
const envLoad = loadDotEnv({ path: envFilePath });
buildLog('process-bootstrap.environment.loaded', envLoad.error ? 'warning' : 'info', {
  envFilePath,
  envFileLoaded: !envLoad.error,
  variableNames: Object.keys(envLoad.parsed || {}).sort(),
  errorName: envLoad.error instanceof Error ? envLoad.error.name : undefined,
});
try {
  config = (await import('../../src/server/config.ts')).config;
  buildLog('process-bootstrap.config.loaded', 'info', {
    mysqlConfigured: Boolean(config.mysql.user && config.mysql.password),
    cubeApiUrlConfigured: Boolean(config.cube.apiUrl),
    cubeApiKeyConfigured: Boolean(config.cube.apiKey),
    cubeTemplateConfigured: Boolean(config.cube.templateId),
    deepseekApiConfigured: Boolean(config.agent.apiKey),
    deepseekModelConfigured: Boolean(config.agent.model),
  });
  finishBuildPhase();
} catch (error) {
  buildLog('process-bootstrap.config.failed', 'error', {
    error: safeBuildError(error),
    errorDetails: safeBuildErrorDetails(error),
  });
  finishBuildPhase('failed', { error: safeBuildError(error) });
  throw error;
}

async function logBuildStorage(stage: string, locations: Record<string, string>): Promise<void> {
  const filesystems = await Promise.all(Object.entries(locations).map(async ([name, path]) => {
    try {
      const filesystem = await statfs(path);
      const blockSize = Number(filesystem.bsize);
      const totalBytes = Number(filesystem.blocks) * blockSize;
      const freeBytes = Number(filesystem.bfree) * blockSize;
      const availableBytes = Number(filesystem.bavail) * blockSize;
      return { name, path, totalBytes, usedBytes: Math.max(0, totalBytes - freeBytes), availableBytes };
    } catch (error) {
      return { name, path, errorName: error instanceof Error ? error.name : 'Error' };
    }
  }));
  buildLog(stage, 'info', { filesystems });
}

async function withBuildStep<T>(stage: string, details: Record<string, unknown>, operation: () => Promise<T>): Promise<T> {
  const startedAt = Date.now();
  buildLog(stage + '.start', 'info', details);
  const heartbeat = setInterval(() => {
    buildLog(stage + '.heartbeat', 'info', { ...details, stepElapsedMs: Date.now() - startedAt });
  }, 30_000);
  heartbeat.unref();
  try {
    const result = await operation();
    buildLog(stage + '.complete', 'info', { ...details, durationMs: Date.now() - startedAt });
    return result;
  } catch (error) {
    const statusCode = error && typeof error === 'object' && 'statusCode' in error
      ? Number((error as { statusCode?: unknown }).statusCode)
      : undefined;
    const errorMessage = safeBuildError(error);
    const cubeRequestId = errorMessage.match(/request\s*id"?\s*[:=]\s*"?([a-f0-9-]{16,36})/i)?.[1];
    const failedContainerId = errorMessage.match(/failed to run container\s+([a-f0-9]{32})/i)?.[1];
    buildLog(stage + '.failed', 'error', {
      ...details,
      durationMs: Date.now() - startedAt,
      error: errorMessage,
      cubeRequestId,
      failedContainerId,
      errorDetails: safeBuildErrorDetails(error),
    });
    if (stage === 'sandbox.create') {
      const level = statusCode === 408 ? 'warning' : 'error';
      const hint = statusCode === 408
        ? 'CubeSandbox returned HTTP 408 while admitting or starting the microVM. Correlate this run timestamp with Cube request logs and check running VM allocations, Cubelet quota, host pressure, and CubeMaster create deadlines.'
        : statusCode === 500
          ? 'CubeMaster returned HTTP 500 during microVM creation. Correlate the response request ID with CubeMaster, Cubelet, CubeShim, and VMM logs; inspect guest-agent reconnect and vsock timeouts before retrying.'
          : 'Sandbox.create failed before the builder handle was returned. Correlate the response request ID with CubeMaster, Cubelet, CubeShim, and VMM logs, then check VM allocations and host pressure.';
      buildLog('sandbox.create.failure.diagnosis', level, {
        statusCode,
        cubeRequestId,
        failedContainerId,
        cubeLogCorrelation: {
          buildRunId,
          masterQuery: `sudo grep -a -n -F '${failedContainerId || buildRunId}' /data/log/CubeMaster/cubemaster-req.log*`,
          ...(failedContainerId ? {
            cubeletQuery: `sudo grep -a -n -F '${failedContainerId}' /data/log/Cubelet/Cubelet-req.log*`,
            shimAndVmmQuery: `sudo grep -a -n -F '${failedContainerId}' /data/log/CubeShim/cube-shim-req.log* /data/log/CubeVmm/vmm.log*`,
          } : {}),
          nextStep: failedContainerId
            ? 'Join CubeMaster and Cubelet by ContainerId and RequestId; compare CubeShim CONNECT/OK handshake, reset_guest RPC, and agent-ready markers with VMM local-init/established timing for the same container.'
            : 'Find this buildRunId in CubeMaster first, then use its RequestId and sandbox ID to search Cubelet, CubeShim, and VMM logs.',
        },
        hint,
        cubeMasterConfigPath: '/usr/local/services/cubetoolbox/CubeMaster/conf.yaml',
        cubeRuntimeLogPaths: [
          '/data/log/CubeAPI/cube-api-YYYY-MM-DD.log',
          '/data/log/CubeMaster/cubemaster-req.log',
          '/data/log/Cubelet/Cubelet-req.log',
          '/data/log/CubeShim/cube-shim-req.log',
          '/data/log/CubeVmm/vmm.log',
        ],
        readOnlyChecks: [
          'Sandbox.list CPU/memory totals after the failed create',
          'Cubelet dynamicconf host.quota',
          'CubeMaster cubelet_conf.create_timeout_insec and app_snapshot_timeout_insec',
          'CubeMaster/Cubelet/CubeShim request logs under /data/log (not only journalctl)',
          'top -b -n 2 -d 1 | grep kswapd',
          'vmstat 1 5',
          'cat /proc/pressure/cpu /proc/pressure/memory /proc/pressure/io',
        ],
      });
      if (failedContainerId) {
        try {
          await collectCubeSandboxDiagnosticLogs(failedContainerId, {
            includeGuestStdout: false,
            source: 'sandbox-create-failure',
          });
        } catch (diagnosticLogError) {
          buildLog('cube.diagnostic.logs.failed', 'warning', {
            sandboxId: failedContainerId,
            buildRunId,
            source: 'sandbox-create-failure',
            error: safeBuildError(diagnosticLogError),
          });
        }
      }
      await logCubeSandboxCapacity('sandbox.capacity.after-create-failure');
      await logBuildStorage('host-storage.after-create-failure', {
        repository: process.cwd(),
        buildLogs: buildLogDirectory,
        runtimeCache: join(homedir(), '.local/share/csa-cube-node/runtime-cache'),
      });
    }
    throw error;
  } finally {
    clearInterval(heartbeat);
  }
}

async function runBuildGuestCommand(
  stage: string,
  sandbox: Sandbox,
  command: string,
  cwd: string,
  envs: Record<string, string> = {},
  maxDurationMs = 0,
): Promise<{ exitCode: number; output: string }> {
  const startedAt = Date.now();
  const commandSha256 = createHash('sha256').update(command).digest('hex');
  const details = {
    sandboxId: sandbox.sandboxId,
    transport: 'cube-pty-stream',
    cwd,
    command: safeBuildError(command).slice(0, 1800),
    commandBytes: Buffer.byteLength(command),
    commandSha256,
    envNames: Object.keys(envs).sort(),
    maxDurationMs,
  };
  let outputBytes = 0;
  let lastOutputAt: number | undefined;
  let outputTail = '';
  buildLog(stage + '.command.start', 'info', details);
  const heartbeat = setInterval(() => {
    buildLog(stage + '.command.heartbeat', 'info', {
      ...details,
      durationMs: Date.now() - startedAt,
      outputBytes,
      silentForMs: lastOutputAt === undefined ? Date.now() - startedAt : Date.now() - lastOutputAt,
    });
  }, 30_000);
  heartbeat.unref();
  try {
    const result = await runGuestPty(sandbox, command, cwd, envs, line => {
      lastOutputAt = Date.now();
      outputBytes += Buffer.byteLength(line) + 1;
      outputTail = (outputTail + line + '\n').slice(-2400);
      buildLog(stage + '.command.output', classifyBuilderOutput(line), {
        sandboxId: sandbox.sandboxId,
        line: safeBuildError(line).slice(0, 1600),
      });
    }, maxDurationMs);
    const durationMs = Date.now() - startedAt;
    buildLog(stage + '.command.complete', result.exitCode === 0 ? 'info' : 'error', {
      ...details,
      exitCode: result.exitCode,
      durationMs,
      outputBytes: Buffer.byteLength(result.output),
      outputTail: safeBuildError(result.output).trim().slice(-1600),
    });
    return result;
  } catch (error) {
    buildLog(stage + '.command.failed', 'error', {
      ...details,
      durationMs: Date.now() - startedAt,
      outputBytes,
      lastOutputAt: lastOutputAt ? new Date(lastOutputAt).toISOString() : undefined,
      outputTail: safeBuildError(outputTail).trim().slice(-1600),
      error: safeBuildError(error),
    });
    throw error;
  } finally {
    clearInterval(heartbeat);
  }
}

async function runBuildGuestCommandApi(
  stage: string,
  sandbox: Sandbox,
  command: string,
  cwd: string,
  envs: Record<string, string> = {},
  timeoutMs = 30_000,
): Promise<{ exitCode: number; output: string }> {
  const startedAt = Date.now();
  const details = {
    sandboxId: sandbox.sandboxId,
    transport: 'cube-command-api',
    cwd,
    command: safeBuildError(command).slice(0, 1800),
    commandBytes: Buffer.byteLength(command),
    commandSha256: createHash('sha256').update(command).digest('hex'),
    envNames: Object.keys(envs).sort(),
    timeoutMs,
  };
  buildLog(stage + '.command.start', 'info', details);
  const heartbeat = setInterval(() => {
    buildLog(stage + '.command.heartbeat', 'info', { ...details, durationMs: Date.now() - startedAt });
  }, 30_000);
  heartbeat.unref();
  try {
    const result = await sandbox.commands.run(command, { cwd, envs, timeoutMs });
    const output = [result.stdout, result.stderr].filter(Boolean).join('\n');
    for (const line of output.split(/\r?\n/).filter(line => line.trim())) {
      buildLog(stage + '.command.output', classifyBuilderOutput(line), {
        sandboxId: sandbox.sandboxId,
        line: safeBuildError(line).slice(0, 1600),
      });
    }
    buildLog(stage + '.command.complete', result.exitCode === 0 ? 'info' : 'error', {
      ...details,
      exitCode: result.exitCode,
      durationMs: Date.now() - startedAt,
      stdoutBytes: Buffer.byteLength(result.stdout || ''),
      stderrBytes: Buffer.byteLength(result.stderr || ''),
      outputTail: safeBuildError(output).trim().slice(-1600),
    });
    return { exitCode: result.exitCode, output };
  } catch (error) {
    buildLog(stage + '.command.failed', 'error', {
      ...details,
      durationMs: Date.now() - startedAt,
      error: safeBuildError(error),
      errorDetails: safeBuildErrorDetails(error),
    });
    throw error;
  } finally {
    clearInterval(heartbeat);
  }
}

async function collectCubeSandboxDiagnosticLogs(
  sandboxId: string,
  options: { includeGuestStdout?: boolean; source?: string } = {},
): Promise<void> {
  const includeGuestStdout = options.includeGuestStdout ?? true;
  const source = options.source || 'builder-cleanup';
  if (!/^[a-zA-Z0-9_-]{1,80}$/.test(sandboxId)) {
    buildLog('cube.diagnostic.logs.skipped', 'error', { sandboxId: '[invalid]', reason: 'sandbox ID failed local validation' });
    return;
  }
  const cubeLabHome = process.env.CSA_CUBE_LAB_HOME?.trim() || join(homedir(), '.local/share/csa-cube-node');
  const limaHome = process.env.LIMA_HOME?.trim() || join(cubeLabHome, 'lima');
  const sshConfigPath = process.env.CSA_CUBE_SSH_CONFIG?.trim() || join(limaHome, 'cube-node/ssh.config');
  try {
    await stat(sshConfigPath);
  } catch {
    buildLog('cube.diagnostic.logs.skipped', 'warning', {
      sandboxId,
      buildRunId,
      reason: 'Cube node SSH config is not available on the host',
      sshConfigPath,
    });
    return;
  }

  const remoteScript = `set +e
sandbox_id="$1"
build_run_id="$2"
collect_guest_stdout="$3"
printf 'cube.diagnostic.remote.start sandbox_id=%s build_run_id=%s guest_stdout=%s\\n' "$sandbox_id" "$build_run_id" "$collect_guest_stdout"
if [ "$collect_guest_stdout" = "1" ]; then
  printf 'cube.diagnostic.guest.stdout.begin\\n'
  timeout --kill-after=1s 30s /usr/local/bin/cubecli logs --tail 80 "$sandbox_id" 2>&1
  guest_log_status=$?
  printf 'cube.diagnostic.guest.stdout.end status=%s\\n' "$guest_log_status"
else
  printf 'cube.diagnostic.guest.stdout.skipped reason=create-failed-before-sandbox-handle\\n'
fi
printf 'cube.diagnostic.component.records.begin\\n'
python3 - "$sandbox_id" "$build_run_id" <<'PY'
import glob
import json
import os
import re
import sys

target_id, build_run_id = sys.argv[1:3]
sources = [
    ('CubeMaster', '/data/log/CubeMaster/cubemaster-req.log*', [target_id, build_run_id]),
    ('Cubelet', '/data/log/Cubelet/Cubelet-req.log*', [target_id]),
    ('CubeShim', '/data/log/CubeShim/cube-shim-req.log*', [target_id]),
    ('CubeVmm', '/data/log/CubeVmm/vmm.log*', [target_id]),
]
safe_keys = {
    'requestid', 'reqid', 'sandboxid', 'containerid', 'runid',
    'csatemplatebuildrun', 'timestamp', 'time', 'level', 'severity',
    'component', 'operation', 'method', 'status', 'statuscode',
    'errorcode', 'errcode', 'phase', 'event', 'action', 'functiontype',
}
request_id_re = re.compile(r'(?i)(?:cube)?request[_-]?id"?\\s*[:=]\\s*"?([a-f0-9-]{16,36})')
guest_console_patterns = {
    'kernel-banner': r'linux version',
    'kernel-panic': r'kernel panic|not syncing|oops:',
    'rootfs-mount-error': r'unable to mount root|vfs: cannot open root|no working init',
    'guest-init-started': r'run /sbin/init|starting init|init process',
    'virtio-vsock': r'virtio.?vsock|virtio_vsock',
    'virtio-pmem': r'virtio.?pmem|virtio_pmem',
    'guest-agent-ready': r'vsockserverready|agent is ready',
    'guest-agent-timeout': r'agent reconnect exceeded|receive event timeout|deadline exceeded',
}
agent_reconnect_patterns = {
    'agent-ready': r'agent is ready',
    'reconnect-deadline': r'agent reconnect exceeded the deadline',
    'connect-agent-timeout': r'connect agent timed out after',
    'connect-handshake-eof': r'recv len invalid:0',
    'connect-handshake-rejected': r'connect failed rsp:',
    'connect-handshake-read-error': r'recv connect rsp failed:',
    'connect-command-write-error': r'send connect cmd failed:',
    'agent-socket-connect-error': r'connect agent failed at',
    'reset-guest-time-rpc-error': r'reset guest time failed:',
    'reset-random-rpc-error': r'reset reseed random dev failed:',
    'agent-ttrpc-timeout': r'ttrpc err: receive packet timeout|ttrpc.*deadline exceeded',
    'reconnect-attempt-retried': r'reconnect attempt \\d+/\\d+ failed:.*retrying',
}
vmm_patterns = {
    'vm-started': r'vm has been (?:started|restored|resumed)|starting vcpus|vmm started',
    'kernel-panic': r'kernel panic|not syncing|oops:',
    'guest-kernel-banner': r'linux version',
    'guest-agent-ready': r'agent is ready|agent ready|vsockserverready',
    'guest-shutdown': r'vmshutdown|vm has been shut down|guest shutdown',
    'vsock-local-init': r'local-init connection',
    'vsock-established': r'\\bestablished\\b',
    'vsock-removed': r'vsock remove connection|remove connection',
    'timeout': r'timeout|deadline exceeded',
    'failure': r'error|failed|panic',
}
vmm_timing_re = re.compile(r'\\b(restore|resumed?|established|cost|rst|elapsed)\\b[^0-9\\n]{0,24}(\\d+(?:\\.\\d+)?)\\s*(us|µs|ms|s)\\b', re.IGNORECASE)

def classify_patterns(text, patterns):
    lowered = text.lower()
    return sorted(name for name, pattern in patterns.items() if re.search(pattern, lowered))

def safe_vmm_timings(text):
    found = []
    seen = set()
    for match in vmm_timing_re.finditer(text):
        item = (match.group(1).lower(), match.group(2), match.group(3).lower())
        if item in seen:
            continue
        seen.add(item)
        found.append({'operation': item[0], 'value': item[1], 'unit': item[2]})
        if len(found) >= 8:
            break
    return found

def find_log_content_markers(value, depth=0):
    found = set()
    if depth > 6:
        return found
    if isinstance(value, dict):
        for key, child in list(value.items())[:120]:
            if re.sub(r'[^a-z0-9]', '', str(key).lower()) == 'logcontent' and isinstance(child, str):
                lowered = child.lower()
                found.update(name for name, pattern in guest_console_patterns.items() if re.search(pattern, lowered))
            elif isinstance(child, (dict, list)):
                found.update(find_log_content_markers(child, depth + 1))
    elif isinstance(value, list):
        for child in value[:40]:
            found.update(find_log_content_markers(child, depth + 1))
    return sorted(found)

def safe_fields(value, depth=0):
    result = {}
    if depth > 6:
        return result
    if isinstance(value, dict):
        for key, child in list(value.items())[:120]:
            normalized = re.sub(r'[^a-z0-9]', '', str(key).lower())
            if normalized in safe_keys and isinstance(child, (str, int, float, bool)):
                text = str(child)
                if normalized in {'requestid', 'reqid'}:
                    if re.fullmatch(r'[a-fA-F0-9-]{16,36}', text):
                        result[str(key)] = text
                elif len(text) <= 240:
                    result[str(key)] = text
            elif isinstance(child, (dict, list)):
                nested = safe_fields(child, depth + 1)
                if nested:
                    result[str(key)] = nested
    elif isinstance(value, list):
        for index, child in enumerate(value[:40]):
            nested = safe_fields(child, depth + 1)
            if nested:
                result[str(index)] = nested
    return result

for component, pattern, needles in sources:
    paths = sorted(glob.glob(pattern), key=lambda path: os.path.getmtime(path), reverse=True)[:2]
    for path in paths:
        try:
            with open(path, 'rb') as stream:
                size = os.fstat(stream.fileno()).st_size
                start = max(0, size - 2 * 1024 * 1024)
                stream.seek(start)
                if start:
                    stream.readline()
                tail = stream.readlines()[-1200:]
        except Exception as error:
            print(json.dumps({'component': component, 'file': os.path.basename(path), 'readError': type(error).__name__}))
            continue
        matched = 0
        for index, raw in enumerate(tail):
            if not any(needle and needle.encode() in raw for needle in needles):
                continue
            text = raw.decode('utf-8', 'replace')
            request_ids = sorted(set(request_id_re.findall(text)))
            safe = {}
            console_markers = []
            agent_markers = []
            try:
                decoded = json.loads(text)
                safe = safe_fields(decoded)
                console_markers = find_log_content_markers(decoded)
                if component == 'CubeShim' and isinstance(decoded, dict):
                    log_content = decoded.get('LogContent')
                    if isinstance(log_content, str):
                        agent_markers = classify_patterns(log_content, agent_reconnect_patterns)
            except Exception:
                pass
            if component == 'CubeVmm' and not safe:
                vmm_markers = classify_patterns(text, vmm_patterns)
                vmm_timings = safe_vmm_timings(text)
            else:
                vmm_markers = []
                vmm_timings = []
            record = {
                'component': component,
                'file': os.path.basename(path),
                'tailIndex': index,
                'requestIds': request_ids,
                'safeFields': safe,
                **({'guestConsoleMarkers': console_markers} if console_markers else {}),
                **({'agentReconnectMarkers': agent_markers} if agent_markers else {}),
                **({'vmmMarkers': vmm_markers} if vmm_markers else {}),
                **({'vmmTimingObservations': vmm_timings} if vmm_timings else {}),
            }
            print(json.dumps(record, ensure_ascii=False, separators=(',', ':')))
            matched += 1
            if matched >= 12:
                break
        if matched == 0:
            print(json.dumps({'component': component, 'file': os.path.basename(path), 'matchedRecords': 0}))
PY
printf 'cube.diagnostic.remote.complete\\n'
exit 0
`;
  const timeoutMs = includeGuestStdout ? 90_000 : 45_000;
  const remoteCommand = `sudo -n /bin/bash -s -- ${shellQuote(sandboxId)} ${shellQuote(buildRunId)} ${includeGuestStdout ? '1' : '0'}`;
  const startedAt = Date.now();
  buildLog('cube.diagnostic.logs.start', 'info', {
    sandboxId,
    buildRunId,
    source,
    includeGuestStdout,
    transport: 'lima-ssh-to-compute-node',
    sshConfigPath,
    timeoutMs,
    redaction: 'raw Cube guest/VMM text is not emitted; request records include safe IDs/status plus classified guest-console, agent-reconnect, and VMM timing markers',
  });
  await new Promise<void>(resolveCollection => {
    let pending = { stdout: '', stderr: '' };
    let bytes = 0;
    let lines = 0;
    let truncated = false;
    let settled = false;
    const child = spawn(process.env.CSA_CUBE_SSH?.trim() || 'ssh', [
      '-F', sshConfigPath,
      '-o', 'ConnectTimeout=8',
      '-o', 'ServerAliveInterval=5',
      '-o', 'ServerAliveCountMax=2',
      'lima-cube-node',
      remoteCommand,
    ], { stdio: ['pipe', 'pipe', 'pipe'] });
    const flush = (streamName: 'stdout' | 'stderr', final = false): void => {
      const buffer = pending[streamName];
      const parts = buffer.split(/\r?\n/);
      pending[streamName] = final ? '' : (parts.pop() || '');
      for (const rawLine of (final ? parts.concat(pending[streamName]) : parts)) {
        if (!rawLine.trim()) continue;
        bytes += Buffer.byteLength(rawLine);
        lines += 1;
        if (bytes > 300_000 || lines > 300) {
          truncated = true;
          continue;
        }
        buildLog('cube.diagnostic.logs.output', streamName === 'stderr' ? 'warning' : 'info', {
          sandboxId,
          stream: streamName,
          lineSequence: lines,
          line: safeBuildError(rawLine).slice(0, 1400),
        });
      }
    };
    const stop = (timedOut: boolean, code: number | null, signal: NodeJS.Signals | null, error?: Error): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      flush('stdout', true);
      flush('stderr', true);
      buildLog(timedOut ? 'cube.diagnostic.logs.timeout' : error ? 'cube.diagnostic.logs.failed' : 'cube.diagnostic.logs.complete', timedOut || error || code !== 0 ? 'warning' : 'info', {
        sandboxId,
        buildRunId,
        source,
        durationMs: Date.now() - startedAt,
        exitCode: code,
        signal: signal || undefined,
        timedOut,
        error: error ? safeBuildError(error) : undefined,
        stdoutBytes: bytes,
        lines,
        outputTruncated: truncated,
      });
      resolveCollection();
    };
    const timer = setTimeout(() => {
      child.kill('SIGTERM');
      setTimeout(() => child.kill('SIGKILL'), 1000).unref();
      stop(true, null, 'SIGTERM');
    }, timeoutMs);
    child.stdout.on('data', (chunk: Buffer) => {
      pending.stdout += chunk.toString('utf8');
      flush('stdout');
    });
    child.stderr.on('data', (chunk: Buffer) => {
      pending.stderr += chunk.toString('utf8');
      flush('stderr');
    });
    child.on('error', error => stop(false, null, null, error));
    child.on('close', (code, signal) => stop(false, code, signal));
    child.stdin.end(remoteScript);
  });
}

async function writeGuestTextFile(sandbox: Sandbox, path: string, contents: string): Promise<void> {
  await withBuildStep('runtime.files.write', { sandboxId: sandbox.sandboxId, path, bytes: Buffer.byteLength(contents) }, () => sandbox.files.write(path, contents));
}

async function sha256File(path: string): Promise<string> {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest('hex');
}

const templateId = process.env.CUBE_TEMPLATE_ID || '';
const seedSnapshotId = process.env.CSA_DSH_TEMPLATE_SEED_SNAPSHOT_ID?.trim() || '';
const useBaseTemplateForProbes = process.env.CSA_DSH_TEMPLATE_USE_BASE_TEMPLATE?.trim() === '1';
const desktopProbeOnly = process.env.CSA_DESKTOP_PROBE_ONLY?.trim() === '1';
const chromiumDiagnosticOnly = process.env.CSA_CHROMIUM_DIAGNOSTIC_ONLY?.trim() === '1';
const chromiumDiagnosticFlagsMode = process.env.CSA_CHROMIUM_DIAGNOSTIC_FLAGS_MODE?.trim().toLowerCase() || 'desktop';
const chromiumDiagnosticNoStartupWindow = process.env.CSA_CHROMIUM_DIAGNOSTIC_NO_STARTUP_WINDOW?.trim() === '1';
const chromiumDiagnosticStraceMain = process.env.CSA_CHROMIUM_DIAGNOSTIC_STRACE_MAIN?.trim() === '1';
const chromiumDiagnosticInstallStrace = process.env.CSA_CHROMIUM_DIAGNOSTIC_INSTALL_STRACE?.trim() === '1';
const chromiumDiagnosticTraceStartup = process.env.CSA_CHROMIUM_DIAGNOSTIC_TRACE_STARTUP?.trim() === '1';
const chromiumDiagnosticPerf = process.env.CSA_CHROMIUM_DIAGNOSTIC_PERF?.trim() === '1';
const chromiumDiagnosticPerfSymbols = chromiumDiagnosticPerf && process.env.CSA_CHROMIUM_DIAGNOSTIC_PERF_SYMBOLS?.trim() !== '0';
const chromiumDiagnosticPerfAfterRaw = process.env.CSA_CHROMIUM_DIAGNOSTIC_PERF_AFTER_SECONDS?.trim() || '';
const chromiumDiagnosticPerfAfterCandidate = Number(process.env.CSA_CHROMIUM_DIAGNOSTIC_PERF_AFTER_SECONDS);
const chromiumDiagnosticPerfAfterSeconds = Number.isSafeInteger(chromiumDiagnosticPerfAfterCandidate)
  && chromiumDiagnosticPerfAfterCandidate >= 15
  && chromiumDiagnosticPerfAfterCandidate <= 240
  ? chromiumDiagnosticPerfAfterCandidate
  : 90;
if (chromiumDiagnosticPerf && chromiumDiagnosticPerfAfterRaw
  && (!Number.isSafeInteger(chromiumDiagnosticPerfAfterCandidate)
    || chromiumDiagnosticPerfAfterCandidate < 15
    || chromiumDiagnosticPerfAfterCandidate > 240)) {
  throw new Error('CSA_CHROMIUM_DIAGNOSTIC_PERF_AFTER_SECONDS must be an integer from 15 to 240.');
}
const chromiumDiagnosticStracePackagePath = process.env.CSA_CHROMIUM_DIAGNOSTIC_STRACE_DEB?.trim()
  || join(homedir(), '.local/share/csa-cube-node/runtime-cache/strace_6.1-0.1_arm64.deb');
const chromiumDiagnosticPerfBundlePath = process.env.CSA_CHROMIUM_DIAGNOSTIC_PERF_BUNDLE?.trim()
  || join(homedir(), '.local/share/csa-cube-node/runtime-cache/linux-perf-rootfs-minimal-bookworm-arm64.tar.gz');
const chromiumDiagnosticPerfBundleExpectedSha256 = 'aafb31b32042acb4ae6533f222f3553d8735b6789807088750e95418799136de';
const chromiumDiagnosticPerfSymbolsFilePath = process.env.CSA_CHROMIUM_DIAGNOSTIC_PERF_SYMBOLS_FILE?.trim()
  || join(homedir(), '.local/share/csa-cube-node/runtime-cache/chromium-dbgsym_156.0.8078.79-1~deb12u1_arm64.debug');
const chromiumDiagnosticPerfSymbolsExpectedSha256 = 'c5dd8698a7f76a7665a4840bb10fe93d141b13531e61ea76d4bcda330b6e80ff';
const chromiumDiagnosticWaitCandidate = Number(process.env.CSA_CHROMIUM_CDP_WAIT_SECONDS);
const chromiumDiagnosticWaitRequestedSeconds = Number.isSafeInteger(chromiumDiagnosticWaitCandidate)
  && chromiumDiagnosticWaitCandidate > 0
  && chromiumDiagnosticWaitCandidate <= 360
  ? chromiumDiagnosticWaitCandidate
  : 210;
const chromiumDiagnosticWaitSeconds = chromiumDiagnosticPerf
  ? Math.max(chromiumDiagnosticWaitRequestedSeconds, Math.min(360, chromiumDiagnosticPerfAfterSeconds + 60))
  : chromiumDiagnosticWaitRequestedSeconds;
const chromiumSessionDiagnosticOnly = process.env.CSA_CHROMIUM_SESSION_DIAGNOSTIC_ONLY?.trim() === '1';
const chromiumSessionDiagnosticBrowser = process.env.CSA_CHROMIUM_SESSION_BROWSER?.trim() || 'wrapper';
const chromiumSessionDiagnosticMaxAttempts = process.env.CSA_CHROMIUM_SESSION_MAX_ATTEMPTS?.trim() || '4';
const chromiumSessionDiagnosticCftArchive = process.env.CSA_CHROME_FOR_TESTING_ARCHIVE?.trim()
  || join(homedir(), '.local/share/csa-cube-node/runtime-cache/chrome-for-testing-157.0.8103.50-linux-arm64.zip');
const websockifyDiagnosticOnly = process.env.CSA_WEBSOCKIFY_DIAGNOSTIC_ONLY?.trim() === '1';
const websockifyDiagnosticLongOnly = process.env.CSA_WEBSOCKIFY_DIAGNOSTIC_LONG_ONLY?.trim() === '1';
const websockifyDiagnosticTimeoutMs = websockifyDiagnosticLongOnly ? 180_000 : 60_000;
const chromiumDiagnosticTimeoutMs = chromiumDiagnosticPerf
  ? (chromiumDiagnosticStraceMain ? 540_000 : 480_000)
  : 360_000;
const chromiumSessionDiagnosticTimeoutMs = 420_000;
const packageDirectory = resolve('scripts/cube/dsh-runtime');
const runtimeBundleBuilderPath = resolve('scripts/cube/prepare-dsh-runtime-linux-arm64.sh');
const runtimeBootstrapPath = resolve('scripts/cube/bootstrap-dsh-runtime.sh');
const runtimeBootstrapWrapperPath = resolve('scripts/cube/run-dsh-runtime-bootstrap.sh');
const piPackageDirectory = resolve('scripts/cube/pi-runtime');
const piRuntimeBundleBuilderPath = resolve('scripts/cube/prepare-pi-runtime-linux-arm64.sh');
const websockifyDiagnosticScriptPath = resolve(websockifyDiagnosticLongOnly
  ? 'scripts/cube/diagnose-websockify-long.sh'
  : 'scripts/cube/diagnose-websockify.sh');
const chromiumDiagnosticScriptPath = resolve('scripts/cube/diagnose-chromium.sh');
const chromiumSessionDiagnosticScriptPath = resolve('scripts/cube/diagnose-chromium-session.sh');
const runtimeRoot = '/opt/csa-agent-runtime';
const runtimeState = '/var/lib/csa-agent-runtime';
beginBuildPhase('preflight', { packageDirectory, runtimeBundleBuilderPath, templateIdConfigured: Boolean(templateId) });
buildLog('template.preflight.start', 'info', { packageDirectory, runtimeBundleBuilderPath, templateIdConfigured: Boolean(templateId) });
const [packageJson, packageLock, runtimeManifest, runtimeBundleBuilder, runtimeSource, computerPluginSource, chromePipeBridgeSource, runtimeLauncher, runtimeBootstrap, runtimeBootstrapWrapper, profileInitializeSmoke, piPackageJson, piPackageLock, piRuntimeManifest, piRuntimeBundleBuilder, piRuntimeSource] = await Promise.all([
  readFile(join(packageDirectory, 'package.json'), 'utf8'),
  readFile(join(packageDirectory, 'package-lock.json'), 'utf8'),
  readFile(join(packageDirectory, 'runtime-manifest.json'), 'utf8'),
  readFile(runtimeBundleBuilderPath, 'utf8'),
  readFile(join(packageDirectory, 'run-task.mjs'), 'utf8'),
  readFile(join(packageDirectory, 'computer-plugin.mjs'), 'utf8'),
  readFile(join(packageDirectory, 'chrome-cdp-pipe-bridge.mjs'), 'utf8'),
  readFile(join(packageDirectory, 'dsh-runtime-launcher.mjs'), 'utf8'),
  readFile(runtimeBootstrapPath, 'utf8'),
  readFile(runtimeBootstrapWrapperPath, 'utf8'),
  readFile(join(packageDirectory, 'profile-initialize-smoke.mjs'), 'utf8'),
  readFile(join(piPackageDirectory, 'package.json'), 'utf8'),
  readFile(join(piPackageDirectory, 'package-lock.json'), 'utf8'),
  readFile(join(piPackageDirectory, 'runtime-manifest.json'), 'utf8'),
  readFile(piRuntimeBundleBuilderPath, 'utf8'),
  readFile(join(piPackageDirectory, 'run-task.mjs'), 'utf8'),
]).catch(error => {
  buildLog('template.preflight.failed', 'error', { error: safeBuildError(error) });
  finishBuildPhase('failed', { error: safeBuildError(error) });
  throw error;
});
const lockHash = createHash('sha256').update(packageLock).digest('hex');
const runtimeKey = createHash('sha256').update(packageLock).update('\0').update(runtimeManifest).update('\0').update(runtimeBundleBuilder).update('\0').update(runtimeSource).update('\0').update(computerPluginSource).update('\0').update(chromePipeBridgeSource).update('\0').update(runtimeLauncher).update('\0').update(runtimeBootstrap).update('\0').update(runtimeBootstrapWrapper).digest('hex');
const piManifest = JSON.parse(piRuntimeManifest) as { package?: string; version?: string; apiProtocol?: string };
const piRuntimeKey = createPiRuntimeKey({
  packageJson: piPackageJson,
  packageLock: piPackageLock,
  runtimeManifest: piRuntimeManifest,
  bundleBuilder: piRuntimeBundleBuilder,
  runtimeSource: piRuntimeSource,
  computerPlugin: computerPluginSource,
});
const runtimeWheelSha256 = String(JSON.parse(runtimeManifest).runtimeWheelSha256 || '');
const runtimeVersion = String(JSON.parse(runtimeManifest).deepseekHarnessVersion || '');
if (!/^[a-f0-9]{64}$/.test(runtimeWheelSha256) || runtimeVersion !== '0.2.2-rc.2') {
  buildLog('template.preflight.manifest.failed', 'error', { runtimeVersion, wheelHashValid: /^[a-f0-9]{64}$/.test(runtimeWheelSha256) });
  finishBuildPhase('failed', { error: 'Pinned DeepSeek Harness manifest validation failed.' });
  throw new Error('DeepSeek Harness runtime manifest does not match the pinned SDK version.');
}
if (!hasSupportedPiRuntimeContract(piPackageJson, piRuntimeManifest)) {
  buildLog('template.preflight.pi-manifest.failed', 'error', { package: piManifest.package, version: piManifest.version, apiProtocol: piManifest.apiProtocol });
  finishBuildPhase('failed', { error: 'Pinned Pi runtime manifest validation failed.' });
  throw new Error('Pi runtime package and manifest do not match the Coke Dots/Grok Bot compatibility pin.');
}
buildLog('template.preflight.complete', 'info', {
  runtimeKey: runtimeKey.slice(0, 16),
  runtimeVersion,
  packageLockBytes: Buffer.byteLength(packageLock),
  runtimeWheelSha256,
  piRuntimeKey: piRuntimeKey.slice(0, 16),
  piPackage: piManifest.package,
  piVersion: piManifest.version,
  piProtocol: piManifest.apiProtocol,
  piPackageLockBytes: Buffer.byteLength(piPackageLock),
});
finishBuildPhase();
let builder: Sandbox | undefined;
let verifier: Sandbox | undefined;
interface DesktopSessionMonitor {
  handle: PtyHandle;
  state: { status: 'running' | 'exited' | 'error'; exitCode?: number; message?: string };
  desktopReady: boolean;
  chromePid?: number;
  outputBytes: number;
  outputLines: number;
  outputTail: string;
  startedAt: number;
  detached: boolean;
}

async function collectDesktopReadinessFailureDiagnostics(sandbox: Sandbox, monitor: DesktopSessionMonitor): Promise<void> {
  const chromePid = Number.isSafeInteger(monitor.chromePid) && Number(monitor.chromePid) > 1 ? Number(monitor.chromePid) : 0;
  const command = [
    'set +e',
    `chrome_pid=${chromePid}`,
    'desktop_user="$(getent passwd 1000 | cut -d: -f1)"',
    'printf "desktop.failure.diagnostics.begin chrome_pid=%s desktop_user=%s\\n" "$chrome_pid" "${desktop_user:-missing}"',
    'if [ "$chrome_pid" -gt 1 ] && [ -r "/proc/$chrome_pid/status" ]; then',
    '  awk \'/^(Name|State|Tgid|Pid|PPid|Uid|Gid|VmRSS|Threads):/ { gsub(/^[[:space:]]+/, "", $2); printf "desktop.failure.chrome.status %s=%s\\n", $1, $2 }\' "/proc/$chrome_pid/status"',
    '  printf "desktop.failure.chrome.wchan="; cat "/proc/$chrome_pid/wchan" 2>/dev/null; printf "\\n"',
    '  child_pids="$(cat "/proc/$chrome_pid/task/$chrome_pid/children" 2>/dev/null)"',
    '  printf "desktop.failure.chrome.children=%s\\n" "${child_pids:-none}"',
    '  process_ids="$chrome_pid"; child_count=0',
    '  for child_pid in $child_pids; do case "$child_pid" in (\'\'|*[!0-9]*) continue ;; esac; process_ids="$process_ids,$child_pid"; child_count=$((child_count + 1)); if [ "$child_count" -ge 8 ]; then break; fi; done',
    '  ps -p "$process_ids" -o pid=,ppid=,stat=,wchan=,etime=,pcpu=,rss=,nlwp=,comm= 2>&1 | tr "\\n" ";"; printf "\\n"',
    '  for inspect_pid in "$chrome_pid" $child_pids; do',
    '    case "$inspect_pid" in (\'\'|*[!0-9]*) continue ;; esac',
    '    [ -r "/proc/$inspect_pid/cmdline" ] || continue',
    '    chrome_exe="$(readlink "/proc/$inspect_pid/exe" 2>/dev/null || true)"',
    '    raw_cmdline="$(tr "\\000" " " <"/proc/$inspect_pid/cmdline" 2>/dev/null | cut -c1-1000 || true)"',
    '    printf "desktop.failure.chrome.cmdline pid=%s value=%s\\n" "$inspect_pid" "$(printf "%q" "$raw_cmdline")"',
    '    cmdline_flags="$(tr "\\000" "\\n" <"/proc/$inspect_pid/cmdline" 2>/dev/null | awk \'/^--remote-debugging-address=/ { address=substr($0,index($0,"=")+1) } /^--remote-debugging-port=/ { port=substr($0,index($0,"=")+1) } /^--user-data-dir=/ { profile="present" } /^--no-sandbox$/ { no_sandbox="yes" } /^--disable-dev-shm-usage$/ { disable_dev_shm="yes" } /^--headless/ { headless=$0 } END { printf "remote_debugging_address=%s remote_debugging_port=%s profile_arg=%s no_sandbox=%s disable_dev_shm=%s headless_flag=%s", address ? address : "missing", port ? port : "missing", profile ? profile : "missing", no_sandbox ? no_sandbox : "missing", disable_dev_shm ? disable_dev_shm : "missing", headless ? headless : "absent" }\' 2>/dev/null)"',
    '    printf "desktop.failure.chrome.argv pid=%s exe=%s %s\\n" "$inspect_pid" "$(basename "$chrome_exe" 2>/dev/null)" "${cmdline_flags:-unavailable}"',
    '  done',
    'else',
    '  printf "desktop.failure.chrome.status=unavailable\\n"',
    'fi',
    'for path in /workspace/.desktop-home /workspace/.desktop-home/.config/chromium "/workspace/.desktop-home/.config/chromium/Crash Reports" /workspace/.desktop-home/.config/chromium/Crashpad; do',
    '  if [ -e "$path" ]; then',
    '    stat -c "desktop.failure.path path=%n uid=%u gid=%g mode=%a type=%F" "$path" 2>&1',
    '    if [ -d "$path" ] && [ -n "${desktop_user:-}" ] && command -v runuser >/dev/null 2>&1; then probe="$path/.csa-failure-write-probe-$$"; if runuser -u "$desktop_user" -- sh -c \'umask 077; : >"$1" && rm -f "$1"\' sh "$probe" >/dev/null 2>&1; then printf "desktop.failure.path.write_probe path=%s result=passed\\n" "$path"; else printf "desktop.failure.path.write_probe path=%s result=failed\\n" "$path"; rm -f "$probe"; fi; fi',
    '  else printf "desktop.failure.path path=%s state=missing\\n" "$path"; fi',
    'done',
    'port_hex=2406; awk -v port="$port_hex" \'$4 == "0A" { split($2, endpoint, ":"); if (toupper(endpoint[2]) == port) print "desktop.failure.listener " FILENAME ":" $0 }\' /proc/net/tcp /proc/net/tcp6 2>/dev/null',
    'if [ -S /run/dbus/system_bus_socket ]; then printf "desktop.failure.system_bus_socket=present\\n"; else printf "desktop.failure.system_bus_socket=missing\\n"; fi',
    'printf "desktop.failure.dbus_processes="; ps -C dbus-daemon -o pid=,ppid=,stat=,comm= 2>/dev/null | tr "\\n" ";"; printf "\\n"',
    'cdp_result="$(timeout --kill-after=1s 4s curl --noproxy "*" --connect-timeout 1 --max-time 2 -sS -o /dev/null -w "http_code=%{http_code} total_seconds=%{time_total}" http://127.0.0.1:9222/json/version 2>&1)"; cdp_status=$?; printf "desktop.failure.cdp status=%s result=%s\\n" "$cdp_status" "$(printf %q "$cdp_result")"',
    'cgroup_dir="/sys/fs/cgroup$(awk -F: \'$1 == "0" { print $3; exit }\' /proc/self/cgroup 2>/dev/null)"; [ -d "$cgroup_dir" ] || cgroup_dir=/sys/fs/cgroup; for name in cpu.max cpu.stat memory.current memory.max; do if [ -r "$cgroup_dir/$name" ]; then printf "desktop.failure.cgroup %s=" "$name"; tr "\\n" ";" <"$cgroup_dir/$name"; printf "\\n"; fi; done',
    'if [ -r /tmp/csa-chromium.log ]; then tail -n 24 /tmp/csa-chromium.log; else printf "desktop.failure.chromium_log=missing\\n"; fi',
    'printf "desktop.failure.diagnostics.end\\n"',
  ].join('\n');
  const startedAt = Date.now();
  buildLog('desktop.session.failure.diagnostics.start', 'warning', {
    sandboxId: sandbox.sandboxId,
    ptyPid: monitor.handle.pid,
    chromePid: chromePid || undefined,
    transport: 'cube-command-api',
    timeoutMs: 180_000,
    purpose: 'capture guest state before terminating the desktop PTY',
  });
  try {
    const result = await runBuildGuestCommandApi('desktop.session.failure.diagnostics', sandbox, command, '/', {}, 180_000);
    buildLog('desktop.session.failure.diagnostics.result', result.exitCode === 0 ? 'warning' : 'error', {
      sandboxId: sandbox.sandboxId,
      ptyPid: monitor.handle.pid,
      chromePid: chromePid || undefined,
      exitCode: result.exitCode,
      durationMs: Date.now() - startedAt,
      outputBytes: Buffer.byteLength(result.output),
      endMarkerSeen: result.output.includes('desktop.failure.diagnostics.end'),
      outputTail: safeBuildError(result.output, 1800),
    });
  } catch (error) {
    buildLog('desktop.session.failure.diagnostics.failed', 'error', {
      sandboxId: sandbox.sandboxId,
      ptyPid: monitor.handle.pid,
      chromePid: chromePid || undefined,
      durationMs: Date.now() - startedAt,
      error: safeBuildError(error),
      errorDetails: safeBuildErrorDetails(error),
    });
  }
}
let desktopSession: DesktopSessionMonitor | undefined;
let createdSnapshotId = '';
let snapshotVerified = false;
let builderSandboxId = '';
let verifierCleanup = 'not-created';
let builderCleanup = 'not-created';
let snapshotCleanup = 'not-needed';

try {
  if (chromiumSessionDiagnosticOnly && !['wrapper', 'direct_elf', 'cft', 'cft_compare', 'both'].includes(chromiumSessionDiagnosticBrowser)) {
    buildLog('chromium.session.diagnostic.browser-mode.invalid', 'error', {
      browserMode: chromiumSessionDiagnosticBrowser,
      acceptedModes: ['wrapper', 'direct_elf', 'cft', 'cft_compare', 'both'],
    });
    throw new Error('CSA_CHROMIUM_SESSION_BROWSER must be wrapper, direct_elf, cft, cft_compare, or both.');
  }
  if (chromiumSessionDiagnosticOnly && (!/^[1-9][0-9]{0,2}$/.test(chromiumSessionDiagnosticMaxAttempts) || Number(chromiumSessionDiagnosticMaxAttempts) > 120)) {
    buildLog('chromium.session.diagnostic.max-attempts.invalid', 'error', {
      configuredValue: chromiumSessionDiagnosticMaxAttempts,
      expectedRange: '1..120',
    });
    throw new Error('CSA_CHROMIUM_SESSION_MAX_ATTEMPTS must be an integer from 1 through 120.');
  }
  const probeOnly = desktopProbeOnly || chromiumDiagnosticOnly || chromiumSessionDiagnosticOnly || websockifyDiagnosticOnly || websockifyDiagnosticLongOnly;
  if (seedSnapshotId && useBaseTemplateForProbes) {
    throw new Error('选择 seed snapshot 或干净 base template 进行 probe，不能同时设置两者。');
  }
  if (probeOnly && !seedSnapshotId && !useBaseTemplateForProbes) {
    const message = 'Probe-only 模式必须设置 CSA_DSH_TEMPLATE_SEED_SNAPSHOT_ID，或显式设置 CSA_DSH_TEMPLATE_USE_BASE_TEMPLATE=1。';
    buildLog('probe.seed.required.failed', 'error', {
      desktopProbeOnly,
      chromiumDiagnosticOnly,
      chromiumSessionDiagnosticOnly,
      websockifyDiagnosticOnly,
      websockifyDiagnosticLongOnly,
      expectedVariables: ['CSA_DSH_TEMPLATE_SEED_SNAPSHOT_ID', 'CSA_DSH_TEMPLATE_USE_BASE_TEMPLATE=1'],
    });
    throw new Error(message);
  }
  beginBuildPhase('base-template.inspect');
  buildLog('template.start', 'info', {
    buildLogPath,
    runtimeKey: runtimeKey.slice(0, 16),
    runtimeVersion,
    piRuntimeKey: piRuntimeKey.slice(0, 16),
    piVersion: piManifest.version,
    seedSnapshotConfigured: Boolean(seedSnapshotId),
    builderSource: seedSnapshotId ? 'seed-snapshot' : 'base-template',
    explicitBaseTemplateProbe: useBaseTemplateForProbes,
    desktopProbeOnly,
    chromiumDiagnosticOnly,
    chromiumSessionDiagnosticOnly,
    chromiumSessionDiagnosticBrowser,
    websockifyDiagnosticOnly,
    websockifyDiagnosticLongOnly,
    nodeVersion: process.version,
    platform: process.platform,
    architecture: process.arch,
    ...cubeControlPlaneSummary(),
  });
  if (!templateId) throw new Error('外部环境文件中没有设置 CUBE_TEMPLATE_ID。');
  buildLog('base-template.inspect', 'info', { templateId });
  const baseTemplate = await withBuildStep('base-template.get', { templateId }, () => Template.get(templateId, { config: cubeConfig() }));
  const baseTemplateAnnotations = baseTemplate.createRequest?.annotations ?? {};
  const provenanceAnnotationAllowlist = /^(?:cube\.master\.components\.[^.]+\.version|cube\.master\.appsnapshot\.(?:template\.(?:alias|id|version)|version)|cube\.master\.rootfs\.(?:artifact\.id|writable_layer_size)|cube\.master\.system_disk_size|cube\.master\.template\.spec_fingerprint)$/;
  const provenanceAnnotations = Object.fromEntries(Object.entries(baseTemplateAnnotations)
    .filter(([key]) => provenanceAnnotationAllowlist.test(key)));
  buildLog('base-template.provenance', 'info', {
    templateId: baseTemplate.templateId,
    status: baseTemplate.status,
    version: baseTemplate.version,
    imageInfoKeys: Object.keys(baseTemplate.imageInfo || {}).sort(),
    selectedAnnotations: provenanceAnnotations,
  });
  if (baseTemplate.status !== 'READY') throw new Error('当前基础模板尚未 READY，不能作为构建基底。');

  beginBuildPhase('runtime-bundle.prepare');
  await logBuildStorage('host-storage.before-runtime-bundle', {
    repository: process.cwd(),
    buildLogs: buildLogDirectory,
    runtimeCache: join(homedir(), '.local/share/csa-cube-node/runtime-cache'),
  });
  buildLog('runtime-bundle.prepare', 'info', { runtimeKey: runtimeKey.slice(0, 16) });
  const bundle = await withBuildStep('runtime-bundle.prepare', { runtimeKey: runtimeKey.slice(0, 16) }, () => prepareRuntimeBundle(runtimeKey));
  buildLog('runtime-bundle.ready', 'info', { bytes: bundle.size, sha256: bundle.archiveSha256, runtimeKey: runtimeKey.slice(0, 16) });
  beginBuildPhase('pi-runtime.bundle.prepare');
  buildLog('pi-runtime.bundle.prepare.start', 'info', {
    runtimeKey: piRuntimeKey.slice(0, 16),
    package: piManifest.package,
    version: piManifest.version,
    packageLockBytes: Buffer.byteLength(piPackageLock),
  });
  const piBundle = await withBuildStep('pi-runtime.bundle.prepare', {
    runtimeKey: piRuntimeKey.slice(0, 16),
    package: piManifest.package,
    version: piManifest.version,
  }, () => prepareRuntimeBundle(piRuntimeKey, piRuntimeBundleBuilderPath, 'Pi'));
  buildLog('pi-runtime.bundle.ready', 'info', {
    bytes: piBundle.size,
    sha256: piBundle.archiveSha256,
    runtimeKey: piRuntimeKey.slice(0, 16),
    package: piManifest.package,
    version: piManifest.version,
  });
  await logBuildStorage('host-storage.after-runtime-bundle', {
    repository: process.cwd(),
    buildLogs: buildLogDirectory,
    runtimeCache: join(homedir(), '.local/share/csa-cube-node/runtime-cache'),
  });
  beginBuildPhase('sandbox.create');
  await logCubeSandboxCapacity('sandbox.capacity.before-create');
  if (seedSnapshotId) {
    buildLog('sandbox.create.start', 'info', { source: 'seed-snapshot', idleTimeoutSeconds: NEVER_TIMEOUT });
    process.stdout.write('从已完成的 Linux 桌面 snapshot 创建模板构建 VM。\n');
    builder = await withBuildStep('sandbox.create', { source: 'seed-snapshot', snapshotId: seedSnapshotId, ...cubeControlPlaneSummary() }, () => Sandbox.create({
      config: cubeConfig(templateCreateTimeoutMs),
      template: seedSnapshotId,
      timeout: NEVER_TIMEOUT,
      allowInternetAccess: true,
      network: { allowPublicTraffic: false },
      extra: { restartPolicy: 'Never' },
      metadata: { csa_template_builder: 'true', csa_template_build_run: buildRunId, csa_template_runtime_lock: runtimeKey.slice(0, 16), csa_template_dsh_version: runtimeVersion, csa_template_pi_lock: piRuntimeKey.slice(0, 16), csa_template_pi_version: String(piManifest.version) },
    }));
    process.stdout.write('template_builder_created ' + builder.sandboxId + '\n');
  } else {
    buildLog('sandbox.create.start', 'info', { source: 'base-template', idleTimeoutSeconds: NEVER_TIMEOUT });
    process.stdout.write('准备独立的 Linux 桌面与 DSH 模板构建 VM。\n');
    builder = await withBuildStep('sandbox.create', { source: 'base-template', templateId, ...cubeControlPlaneSummary() }, () => Sandbox.create({
      config: cubeConfig(templateCreateTimeoutMs),
      template: templateId,
      timeout: NEVER_TIMEOUT,
      allowInternetAccess: true,
      network: { allowPublicTraffic: false },
      extra: { restartPolicy: 'Never' },
      metadata: { csa_template_builder: 'true', csa_template_build_run: buildRunId, csa_template_runtime_lock: runtimeKey.slice(0, 16), csa_template_dsh_version: runtimeVersion, csa_template_pi_lock: piRuntimeKey.slice(0, 16), csa_template_pi_version: String(piManifest.version) },
    }));
    process.stdout.write('template_builder_created ' + builder.sandboxId + '\n');
  }
  builderSandboxId = builder.sandboxId;
  buildLog('sandbox.create.ready', 'info', { sandboxId: builderSandboxId, templateId, idleTimeoutSeconds: NEVER_TIMEOUT });
  await waitUntilSandboxRuns(builder);
  buildLog('sandbox.running', 'info', { sandboxId: builderSandboxId });
  if (websockifyDiagnosticOnly) {
    beginBuildPhase('websockify.diagnostic');
    buildLog('websockify.diagnostic.start', 'info', { sandboxId: builder.sandboxId, scriptPath: websockifyDiagnosticScriptPath, desktopBootstrapSkipped: true, snapshotCreated: false, maxDurationMs: websockifyDiagnosticTimeoutMs });
    await withBuildStep('websockify.diagnostic.desktop-session.stop', { sandboxId: builder.sandboxId }, () => stopDesktopSession(builder!));
    const diagnosticCommand = await readFile(websockifyDiagnosticScriptPath, 'utf8');
    const diagnostic = await withBuildStep('websockify.diagnostic.inspect', { sandboxId: builder.sandboxId, transport: 'cube-pty-stream', maxDurationMs: websockifyDiagnosticTimeoutMs }, () => runBuildGuestCommand(
      'websockify.diagnostic.inspect',
      builder!,
      diagnosticCommand,
      '/',
      {},
      websockifyDiagnosticTimeoutMs,
    ));
    buildLog('websockify.diagnostic.complete', 'info', { sandboxId: builder.sandboxId, exitCode: diagnostic.exitCode, outputBytes: Buffer.byteLength(diagnostic.output), snapshotCreated: false });
    process.stdout.write('websockify_diagnostic_complete ' + builder.sandboxId + '\n');
    throw new Error('CSA_WEBSOCKIFY_DIAGNOSTIC_COMPLETE');
  }
  if (chromiumDiagnosticOnly) {
    if (chromiumDiagnosticFlagsMode !== 'desktop' && chromiumDiagnosticFlagsMode !== 'minimal') {
      throw new Error('CSA_CHROMIUM_DIAGNOSTIC_FLAGS_MODE must be desktop or minimal.');
    }
    beginBuildPhase('chromium.diagnostic');
    buildLog('chromium.diagnostic.start', 'info', { sandboxId: builder.sandboxId, scriptPath: chromiumDiagnosticScriptPath, desktopBootstrapSkipped: true, flagsMode: chromiumDiagnosticFlagsMode, cdpWaitSecondsRequested: chromiumDiagnosticWaitRequestedSeconds, cdpWaitSeconds: chromiumDiagnosticWaitSeconds, straceMain: chromiumDiagnosticStraceMain, perfSample: chromiumDiagnosticPerf, perfSampleAfterSecondsRequested: chromiumDiagnosticPerfAfterRaw || 'default', perfSampleAfterSeconds: chromiumDiagnosticPerfAfterSeconds, perfSymbols: chromiumDiagnosticPerfSymbols, installStraceInDisposableClone: chromiumDiagnosticInstallStrace, snapshotCreated: false, maxDurationMs: chromiumDiagnosticTimeoutMs });
    await withBuildStep('chromium.diagnostic.desktop-session.stop', { sandboxId: builder.sandboxId }, () => stopDesktopSession(builder!));
    const diagnosticCommand = await readFile(chromiumDiagnosticScriptPath, 'utf8');
    let guestStracePackagePath = '';
    if (chromiumDiagnosticStraceMain && !chromiumDiagnosticInstallStrace) {
      let stracePackageBytes: Buffer;
      try {
        stracePackageBytes = await readFile(chromiumDiagnosticStracePackagePath);
      } catch {
        throw new Error(`Pre-staged strace package not found at ${chromiumDiagnosticStracePackagePath}.`);
      }
      const stracePackageSha256 = createHash('sha256').update(stracePackageBytes).digest('hex');
      guestStracePackagePath = '/tmp/csa-chromium-strace_6.1-0.1_arm64.deb';
      await withBuildStep('chromium.diagnostic.strace.stage', { sandboxId: builder.sandboxId, bytes: stracePackageBytes.byteLength, sha256: stracePackageSha256 }, () => builder!.files.write(guestStracePackagePath, stracePackageBytes));
      buildLog('chromium.diagnostic.strace.stage.complete', 'info', { sandboxId: builder.sandboxId, bytes: stracePackageBytes.byteLength, sha256: stracePackageSha256, guestPath: guestStracePackagePath, snapshotCreated: false });
    }
    let guestPerfBundlePath = '';
    let guestPerfSymbolsFilePath = '';
    if (chromiumDiagnosticPerf) {
      let perfBundleBytes: Buffer;
      try {
        perfBundleBytes = await readFile(chromiumDiagnosticPerfBundlePath);
      } catch {
        throw new Error(`Pre-staged Chromium perf diagnostic bundle not found at ${chromiumDiagnosticPerfBundlePath}.`);
      }
      const perfBundleSha256 = createHash('sha256').update(perfBundleBytes).digest('hex');
      if (perfBundleSha256 !== chromiumDiagnosticPerfBundleExpectedSha256) {
        throw new Error(`Chromium perf diagnostic bundle SHA-256 mismatch: expected ${chromiumDiagnosticPerfBundleExpectedSha256}, got ${perfBundleSha256}.`);
      }
      guestPerfBundlePath = '/tmp/csa-linux-perf-rootfs-minimal-bookworm-arm64.tar.gz';
      await withBuildStep('chromium.diagnostic.perf.stage', { sandboxId: builder.sandboxId, bytes: perfBundleBytes.byteLength, sha256: perfBundleSha256 }, () => builder!.files.write(guestPerfBundlePath, perfBundleBytes));
      buildLog('chromium.diagnostic.perf.stage.complete', 'info', { sandboxId: builder.sandboxId, bytes: perfBundleBytes.byteLength, sha256: perfBundleSha256, guestPath: guestPerfBundlePath, sourcePackageCount: 52, bundleType: 'pre-extracted-arm64-rootfs', snapshotCreated: false });

      if (chromiumDiagnosticPerfSymbols) {
        let perfSymbolsFileBytes: Buffer;
        try {
          perfSymbolsFileBytes = await readFile(chromiumDiagnosticPerfSymbolsFilePath);
        } catch {
          throw new Error(`Pre-staged Chromium debug symbols file not found at ${chromiumDiagnosticPerfSymbolsFilePath}.`);
        }
        const perfSymbolsFileSha256 = createHash('sha256').update(perfSymbolsFileBytes).digest('hex');
        if (perfSymbolsFileSha256 !== chromiumDiagnosticPerfSymbolsExpectedSha256) {
          throw new Error(`Chromium debug symbols SHA-256 mismatch: expected ${chromiumDiagnosticPerfSymbolsExpectedSha256}, got ${perfSymbolsFileSha256}.`);
        }
        guestPerfSymbolsFilePath = '/tmp/csa-chromium-dbgsym_156.0.8078.79-1_deb12u1_arm64.debug';
        await withBuildStep('chromium.diagnostic.perf.symbols.stage', { sandboxId: builder.sandboxId, bytes: perfSymbolsFileBytes.byteLength, sha256: perfSymbolsFileSha256 }, () => builder!.files.write(guestPerfSymbolsFilePath, perfSymbolsFileBytes));
        buildLog('chromium.diagnostic.perf.symbols.stage.complete', 'info', { sandboxId: builder.sandboxId, bytes: perfSymbolsFileBytes.byteLength, sha256: perfSymbolsFileSha256, guestPath: guestPerfSymbolsFilePath, package: 'chromium-dbgsym', version: '156.0.8078.79-1~deb12u1', architecture: 'arm64', buildId: 'ebdba7517d4639a3afb9a4ffec8584b97fc384ba', extractedOnHost: true, snapshotCreated: false });
      } else {
        buildLog('chromium.diagnostic.perf.symbols.skip', 'info', { sandboxId: builder.sandboxId, reason: 'resolve-raw-profile-addresses-on-host', fileBytesAvoided: 222504784, buildId: 'ebdba7517d4639a3afb9a4ffec8584b97fc384ba' });
      }
    }
    let diagnostic: { exitCode: number; output: string };
    try {
      diagnostic = await withBuildStep('chromium.diagnostic.inspect', { sandboxId: builder.sandboxId, transport: 'cube-pty-stream', maxDurationMs: chromiumDiagnosticTimeoutMs }, () => runBuildGuestCommand(
        'chromium.diagnostic.inspect',
        builder!,
        diagnosticCommand,
        '/',
        {
          CSA_CHROMIUM_DIAGNOSTIC_FLAGS_MODE: chromiumDiagnosticFlagsMode,
          CSA_CHROMIUM_DIAGNOSTIC_NO_STARTUP_WINDOW: chromiumDiagnosticNoStartupWindow ? '1' : '0',
          CSA_CHROMIUM_CDP_WAIT_SECONDS: String(chromiumDiagnosticWaitSeconds),
          CSA_CHROMIUM_DIAGNOSTIC_STRACE_MAIN: chromiumDiagnosticStraceMain ? '1' : '0',
          CSA_CHROMIUM_DIAGNOSTIC_INSTALL_STRACE: chromiumDiagnosticInstallStrace ? '1' : '0',
          CSA_CHROMIUM_DIAGNOSTIC_STRACE_DEB: guestStracePackagePath,
          CSA_CHROMIUM_DIAGNOSTIC_TRACE_STARTUP: chromiumDiagnosticTraceStartup ? '1' : '0',
          CSA_CHROMIUM_DIAGNOSTIC_PERF: chromiumDiagnosticPerf ? '1' : '0',
          CSA_CHROMIUM_DIAGNOSTIC_PERF_AFTER_SECONDS: String(chromiumDiagnosticPerfAfterSeconds),
          CSA_CHROMIUM_DIAGNOSTIC_PERF_SYMBOLS: chromiumDiagnosticPerfSymbols ? '1' : '0',
          CSA_CHROMIUM_DIAGNOSTIC_PERF_BUNDLE: guestPerfBundlePath,
          CSA_CHROMIUM_DIAGNOSTIC_PERF_BUNDLE_SHA256: chromiumDiagnosticPerfBundleExpectedSha256,
          CSA_CHROMIUM_DIAGNOSTIC_PERF_SYMBOLS_FILE: guestPerfSymbolsFilePath,
          CSA_CHROMIUM_DIAGNOSTIC_PERF_SYMBOLS_SHA256: chromiumDiagnosticPerfSymbolsExpectedSha256,
          CSA_DESKTOP_APT_MIRROR: config.agent.desktopAptMirror,
        },
        chromiumDiagnosticTimeoutMs,
      ));
    } catch (diagnosticError) {
      const postTimeoutInspection = [
        'set +e',
        'desktop_user="$(getent passwd 1000 | cut -d: -f1)"',
        'original_home="$(getent passwd 1000 | cut -d: -f6)"',
        'diag_dir="$(find /tmp -maxdepth 1 -type d -name "csa-chromium-diagnostic-*" -printf "%T@ %p\\n" 2>/dev/null | sort -nr | head -n 1 | cut -d" " -f2-)"',
        'profile="$diag_dir/direct-elf-profile"',
        'chrome_log="$diag_dir/direct-elf.log"',
        'printf "chromium.post-timeout user=%s original_home=%s diagnostic_dir=%s\\n" "${desktop_user:-missing}" "${original_home:-missing}" "${diag_dir:-missing}"',
        'ps -eo pid=,ppid=,stat=,wchan=,etime=,%cpu=,rss=,comm=,args= 2>/dev/null | awk \'/chromium|runuser|Xvfb/ { print; count++; if (count >= 20) exit }\'',
        'if command -v ss >/dev/null 2>&1; then ss -lntp 2>/dev/null | awk "NR == 1 || /:19222([[:space:]]|$)/"; fi',
        'port_hex="$(printf "%04X" 19222)"; awk -v port="$port_hex" \'{ split($2, endpoint, ":"); if (toupper(endpoint[2]) == port) print FILENAME ":" $0 }\' /proc/net/tcp /proc/net/tcp6 2>/dev/null',
        'for path in "$original_home" /workspace /workspace/.desktop-home "$profile" "$profile/Crash Reports" "$profile/Crashpad" /usr/bin/chromium /usr/lib/chromium/chromium; do if [ -e "$path" ]; then stat -c "chromium.post-timeout.owner path=%n owner=%U:%G uid=%u gid=%g mode=%a type=%F" "$path" 2>&1; else printf "chromium.post-timeout.owner path=%s state=missing\\n" "$path"; fi; done',
        'if [ -n "$desktop_user" ]; then for path in "$original_home" /workspace/.desktop-home "$profile" "$profile/Crash Reports" "$profile/Crashpad"; do if [ -d "$path" ]; then probe="$path/.csa-post-timeout-write-probe-$$"; if runuser -u "$desktop_user" -- sh -c \'umask 077; : >"$1"\' _ "$probe" 2>/dev/null; then printf "chromium.post-timeout.write-probe path=%s status=ok\\n" "$path"; runuser -u "$desktop_user" -- unlink "$probe" 2>/dev/null || true; else printf "chromium.post-timeout.write-probe path=%s status=failed\\n" "$path"; fi; fi; done; fi',
        'if [ -n "$diag_dir" ]; then find "$diag_dir" -maxdepth 2 -type f -printf "chromium.post-timeout.file %p %s bytes\\n" 2>/dev/null | head -n 16; if [ -f "$chrome_log" ]; then tail -n 35 "$chrome_log" | sed "s/^/chromium.post-timeout.log /"; fi; fi',
        'printf "chromium.post-timeout.inspect.complete\\n"',
      ].join('\n');
      try {
        const inspection = await withBuildStep(
          'chromium.diagnostic.post-timeout.inspect',
          { sandboxId: builder.sandboxId, transport: 'cube-command-api', timeoutMs: 60_000 },
          () => runBuildGuestCommandApi('chromium.diagnostic.post-timeout.inspect', builder!, postTimeoutInspection, '/', {}, 60_000),
        );
        buildLog('chromium.diagnostic.post-timeout.inspect.complete', 'info', {
          sandboxId: builder.sandboxId,
          exitCode: inspection.exitCode,
          outputBytes: Buffer.byteLength(inspection.output),
          snapshotCreated: false,
        });
      } catch (inspectionError) {
        buildLog('chromium.diagnostic.post-timeout.inspect.failed', 'error', {
          sandboxId: builder.sandboxId,
          diagnosticError: safeBuildError(diagnosticError),
          inspectionError: safeBuildError(inspectionError),
          snapshotCreated: false,
        });
      }
      throw diagnosticError;
    }
    buildLog('chromium.diagnostic.complete', diagnostic.exitCode === 0 ? 'info' : 'error', { sandboxId: builder.sandboxId, exitCode: diagnostic.exitCode, outputBytes: Buffer.byteLength(diagnostic.output), snapshotCreated: false });
    process.stdout.write('chromium_diagnostic_complete ' + builder.sandboxId + '\n');
    throw new Error('CSA_CHROMIUM_DIAGNOSTIC_COMPLETE');
  }
  if (chromiumSessionDiagnosticOnly) {
    beginBuildPhase('chromium.session.diagnostic');
    buildLog('chromium.session.diagnostic.start', 'info', {
      sandboxId: builder.sandboxId,
      scriptPath: chromiumSessionDiagnosticScriptPath,
      desktopBootstrapSkipped: true,
      snapshotCreated: false,
      maxDurationMs: chromiumSessionDiagnosticTimeoutMs,
      browserMode: chromiumSessionDiagnosticBrowser,
      browserMaxAttempts: Number(chromiumSessionDiagnosticMaxAttempts),
      comparison: 'Select one browser per seed-only run; wrapper, direct ELF, and Chrome for Testing use identical flags, each run starts fresh Xvfb+D-Bus+XFCE',
    });
    await withBuildStep('chromium.session.diagnostic.desktop-session.stop', { sandboxId: builder.sandboxId }, () => stopDesktopSession(builder!));
    if (chromiumSessionDiagnosticBrowser === 'cft' || chromiumSessionDiagnosticBrowser === 'cft_compare') {
      const archiveStat = await withBuildStep('chromium.cft.archive.stat', { path: chromiumSessionDiagnosticCftArchive }, () => stat(chromiumSessionDiagnosticCftArchive));
      if (!archiveStat.isFile() || archiveStat.size < 50 * 1024 * 1024) {
        throw new Error(`Chrome for Testing archive is missing or too small: ${chromiumSessionDiagnosticCftArchive} (${archiveStat.size} bytes).`);
      }
      const archiveSha256 = await withBuildStep('chromium.cft.archive.sha256', { path: chromiumSessionDiagnosticCftArchive, bytes: archiveStat.size }, () => sha256File(chromiumSessionDiagnosticCftArchive));
      const chromeArchive = { archivePath: chromiumSessionDiagnosticCftArchive, archiveSha256, size: archiveStat.size };
      buildLog('chromium.cft.archive.verified', 'info', {
        archivePath: chromiumSessionDiagnosticCftArchive,
        bytes: archiveStat.size,
        sha256: archiveSha256,
        source: 'Google Chrome for Testing official linux-arm64 archive',
        templateSnapshotCreated: false,
      });
      const chromeRemoteArchive = '/tmp/csa-chrome-for-testing-linux-arm64.zip';
      await withBuildStep('chromium.cft.archive.transfer', {
        sandboxId: builder.sandboxId,
        archiveBytes: archiveStat.size,
        archiveSha256,
        destination: chromeRemoteArchive,
      }, () => stageRuntimeBundle(builder!, chromeArchive, async event => {
        buildLog('chromium.cft.archive.' + event.stage, event.level, {
          message: event.message,
          ...(event.durationMs === undefined ? {} : { durationMs: event.durationMs }),
          ...event.details,
        });
      }, 'Chrome for Testing', chromeRemoteArchive));
      const extractCommand = `set -Eeuo pipefail
archive=${JSON.stringify(chromeRemoteArchive)}
install_root=/opt/csa-chrome-for-testing-157.0.8103.50
printf 'chromium.cft.extract.start archive=%s bytes=%s\\n' "$archive" "$(wc -c < "$archive")"
install -d -m 0755 "$install_root"
python3 - "$archive" "$install_root" <<'PY'
import os
import pathlib
import stat
import sys
import zipfile

archive, root = sys.argv[1:3]
root_path = pathlib.Path(root).resolve()
with zipfile.ZipFile(archive) as bundle:
    entries = bundle.infolist()
    expected_bytes = sum(item.file_size for item in entries)
    print(f"chromium.cft.extract.progress.start files={len(entries)} uncompressed_bytes={expected_bytes}", flush=True)
    written_total = 0
    for index, item in enumerate(entries, 1):
        target = (root_path / item.filename).resolve()
        if not target.is_relative_to(root_path):
            raise RuntimeError(f"archive path escapes install root: {item.filename}")
        mode = (item.external_attr >> 16) & 0o777
        if item.is_dir():
            target.mkdir(parents=True, exist_ok=True)
            if mode:
                os.chmod(target, mode)
            continue
        target.parent.mkdir(parents=True, exist_ok=True)
        if stat.S_ISLNK((item.external_attr >> 16) & 0o170000):
            link_target = bundle.read(item)
            target.symlink_to(link_target.decode("utf-8"))
            written_total += len(link_target)
            continue
        file_written = 0
        next_report = 32 * 1024 * 1024
        with bundle.open(item) as source, target.open("wb") as output:
            while True:
                block = source.read(8 * 1024 * 1024)
                if not block:
                    break
                output.write(block)
                file_written += len(block)
                written_total += len(block)
                if file_written >= next_report:
                    print(f"chromium.cft.extract.progress file={index}/{len(entries)} path={item.filename} file_bytes={file_written} total_bytes={written_total}", flush=True)
                    next_report += 32 * 1024 * 1024
        if mode:
            os.chmod(target, mode)
        if index % 16 == 0 or index == len(entries):
            print(f"chromium.cft.extract.progress files={index}/{len(entries)} total_bytes={written_total}", flush=True)
    if written_total != expected_bytes:
        raise RuntimeError(f"extracted byte count mismatch: {written_total} != {expected_bytes}")
    print(f"chromium.cft.extract.progress.complete files={len(entries)} uncompressed_bytes={written_total}", flush=True)
PY
chrome="$install_root/chrome-linux-arm64/chrome"
test -x "$chrome"
printf 'chromium.cft.extract.binary path=%s bytes=%s\\n' "$chrome" "$(stat -c %s "$chrome")"
"$chrome" --version
printf 'chromium.cft.extract.complete install_root=%s\\n' "$install_root"
`;
      const extracted = await withBuildStep('chromium.cft.archive.extract', { sandboxId: builder.sandboxId, archiveBytes: archiveStat.size, archiveSha256, installRoot: '/opt/csa-chrome-for-testing-157.0.8103.50' }, () => runBuildGuestCommand(
        'chromium.cft.archive.extract',
        builder!,
        extractCommand,
        '/',
        {},
        600_000,
      ));
      if (extracted.exitCode !== 0 || !extracted.output.includes('chromium.cft.extract.complete')) {
        throw new Error('Chrome for Testing archive verification or extraction failed: ' + safeBuildError(extracted.output).slice(-1600));
      }
      buildLog('chromium.cft.archive.extract.complete', 'info', {
        sandboxId: builder.sandboxId,
        exitCode: extracted.exitCode,
        outputBytes: Buffer.byteLength(extracted.output),
        chromeVersion: '157.0.8103.50',
        installRoot: '/opt/csa-chrome-for-testing-157.0.8103.50',
      });
    }
    const diagnosticCommand = await readFile(chromiumSessionDiagnosticScriptPath, 'utf8');
    let diagnostic: { exitCode: number; output: string };
    try {
      diagnostic = await withBuildStep('chromium.session.diagnostic.inspect', {
        sandboxId: builder.sandboxId,
        transport: 'cube-pty-stream',
        maxDurationMs: chromiumSessionDiagnosticTimeoutMs,
        browserMode: chromiumSessionDiagnosticBrowser,
        scriptBytes: Buffer.byteLength(diagnosticCommand),
      }, () => runBuildGuestCommand(
        'chromium.session.diagnostic.inspect',
        builder!,
        diagnosticCommand,
        '/',
        {
          CSA_CHROMIUM_SESSION_BROWSER: chromiumSessionDiagnosticBrowser,
          CSA_CHROMIUM_SESSION_MAX_ATTEMPTS: chromiumSessionDiagnosticMaxAttempts,
          ...(chromiumSessionDiagnosticBrowser === 'cft' || chromiumSessionDiagnosticBrowser === 'cft_compare'
            ? { CSA_CHROMIUM_SESSION_CFT_BIN: '/opt/csa-chrome-for-testing-157.0.8103.50/chrome-linux-arm64/chrome' }
            : {}),
        },
        chromiumSessionDiagnosticTimeoutMs,
      ));
    } catch (diagnosticError) {
      const postTimeoutInspection = [
        'set +e',
        'diag_dir="$(find /tmp -maxdepth 1 -type d -name "csa-chromium-session-diagnostic-*" -printf "%T@ %p\\n" 2>/dev/null | sort -nr | head -n 1 | cut -d" " -f2-)"',
        'printf "chromium.session.post-timeout.start diagnostic_dir=%s\\n" "${diag_dir:-missing}"',
        'for port in 19222 19223 19224 19225 19226; do port_hex="$(printf "%04X" "$port")"; awk -v port="$port_hex" \'$4 == "0A" { split($2, endpoint, ":"); if (toupper(endpoint[2]) == port) print "chromium.session.post-timeout.listener " FILENAME ":" $0 }\' /proc/net/tcp /proc/net/tcp6 2>/dev/null; done',
        'if [ -n "$diag_dir" ]; then for name in wrapper direct_elf cft cft-system-bus cft-session-bus; do log="$diag_dir/$name.log"; if [ -f "$log" ]; then tail -n 35 "$log" | sed "s/^/chromium.session.post-timeout.log name=$name /"; fi; done; fi',
        'if [ -n "$diag_dir" ]; then for name in wrapper direct_elf cft cft_system_bus cft_session_bus; do pid_file="$diag_dir/$name-launcher.pid"; launcher_pid="$(cat "$pid_file" 2>/dev/null)"; children=; if [[ "$launcher_pid" =~ ^[0-9]+$ && -r "/proc/$launcher_pid/task/$launcher_pid/children" ]]; then children="$(cat "/proc/$launcher_pid/task/$launcher_pid/children" 2>/dev/null)"; fi; pids="$launcher_pid $children"; pids="${pids# }"; pids="${pids% }"; pid_list="${pids// /,}"; printf "chromium.session.post-timeout.profile name=%s launcher_pid=%s children=%s\\n" "$name" "${launcher_pid:-missing}" "${children:-none}"; if [[ "$pid_list" =~ ^[0-9,]+$ ]]; then ps -p "$pid_list" -o pid=,ppid=,stat=,wchan=,etime=,%cpu=,rss=,comm=,args= 2>/dev/null | sed "s/^/chromium.session.post-timeout.process name=$name /"; fi; done; fi',
        'nl -ba /usr/bin/chromium 2>/dev/null | sed -n "1,16p" | sed "s/^/chromium.session.post-timeout.wrapper.source /"',
        '"${CSA_CHROMIUM_SESSION_CFT_BIN:-/opt/csa-chrome-for-testing-157.0.8103.50/chrome-linux-arm64/chrome}" --version 2>&1 | sed "s/^/chromium.session.post-timeout.cft.version /"',
        'printf "chromium.session.post-timeout.complete\\n"',
      ].join('\n');
      try {
        const inspection = await withBuildStep(
          'chromium.session.diagnostic.post-timeout.inspect',
          { sandboxId: builder.sandboxId, transport: 'cube-command-api', timeoutMs: 60_000 },
          () => runBuildGuestCommandApi('chromium.session.diagnostic.post-timeout.inspect', builder!, postTimeoutInspection, '/', {}, 60_000),
        );
        buildLog('chromium.session.diagnostic.post-timeout.inspect.complete', inspection.exitCode === 0 ? 'warning' : 'error', {
          sandboxId: builder.sandboxId,
          exitCode: inspection.exitCode,
          outputBytes: Buffer.byteLength(inspection.output),
          endMarkerSeen: inspection.output.includes('chromium.session.post-timeout.complete'),
        });
      } catch (inspectionError) {
        buildLog('chromium.session.diagnostic.post-timeout.inspect.failed', 'error', {
          sandboxId: builder.sandboxId,
          diagnosticError: safeBuildError(diagnosticError),
          inspectionError: safeBuildError(inspectionError),
        });
      }
      throw diagnosticError;
    }
    buildLog('chromium.session.diagnostic.complete', diagnostic.exitCode === 0 ? 'info' : 'error', {
      sandboxId: builder.sandboxId,
      exitCode: diagnostic.exitCode,
      outputBytes: Buffer.byteLength(diagnostic.output),
      snapshotCreated: false,
    });
    process.stdout.write('chromium_session_diagnostic_complete ' + builder.sandboxId + '\n');
    throw new Error('CSA_CHROMIUM_SESSION_DIAGNOSTIC_COMPLETE');
  }
  beginBuildPhase('desktop.bootstrap');
  buildLog('desktop.bootstrap.start', 'info', { sandboxId: builderSandboxId });
  await withBuildStep('desktop.bootstrap', { sandboxId: builderSandboxId }, () => ensureDesktop(builder!));
  buildLog('desktop.bootstrap.ready', 'info', { sandboxId: builderSandboxId });
  buildLog('desktop.session.stop-for-template', 'info');
  await stopDesktopSession(builder);

  if (desktopProbeOnly) {
    beginBuildPhase('desktop.session.start-and-verify');
    desktopSession = await startDesktopSession(builder);
    buildLog('desktop.probe.only.ready', 'info', {
      sandboxId: builderSandboxId,
      pid: desktopSession.handle.pid,
      durationMs: Date.now() - desktopSession.startedAt,
      outputBytes: desktopSession.outputBytes,
      outputLines: desktopSession.outputLines,
      snapshotCreated: false,
      runtimeTransferSkipped: true,
    });
    process.stdout.write('desktop_probe_only_ready ' + builderSandboxId + '\n');
    throw new Error('CSA_DESKTOP_PROBE_ONLY_COMPLETE');
  }

  beginBuildPhase('runtime.files.stage');
  const runtimeDirectories = await withBuildStep('runtime.directories.prepare', { sandboxId: builder.sandboxId }, () => runBuildGuestCommand(
    'runtime.directories.prepare',
    builder!,
    'set -eu; install -d -m 0755 ' + runtimeRoot + ' ' + runtimeState,
    '/',
  ));
  if (runtimeDirectories.exitCode !== 0) throw new Error('无法创建模板内的 Agent Runtime 目录。');
  await writeGuestTextFile(builder, runtimeRoot + '/package.json', packageJson);
  await writeGuestTextFile(builder, runtimeRoot + '/package-lock.json', packageLock);
  await writeGuestTextFile(builder, runtimeRoot + '/runtime-manifest.json', runtimeManifest);
  await writeGuestTextFile(builder, runtimeRoot + '/computer-plugin.mjs', computerPluginSource);
  await writeGuestTextFile(builder, runtimeState + '/runtime-key.expected.sha256', runtimeKey + '\n');
  await writeGuestTextFile(builder, '/tmp/csa-bootstrap-dsh-runtime.sh', runtimeBootstrap);
  await writeGuestTextFile(builder, '/tmp/csa-run-dsh-runtime-bootstrap.sh', runtimeBootstrapWrapper);
  buildLog('runtime.files.staged', 'info', { sandboxId: builder.sandboxId, packageLockSha256: lockHash, runtimeKey: runtimeKey.slice(0, 16) });
  await builder.files.remove(runtimeState + '/install.exit').catch(() => undefined);
  buildLog('runtime.bundle.transfer.start', 'info', { bytes: bundle.size });
  await withBuildStep('runtime.bundle.transfer', { sandboxId: builder.sandboxId, bytes: bundle.size, sha256: bundle.archiveSha256 }, () => stageRuntimeBundle(builder!, bundle, async event => {
    buildLog('runtime.bundle.' + event.stage, event.level, {
      message: event.message,
      ...(event.durationMs === undefined ? {} : { durationMs: event.durationMs }),
      ...event.details,
    });
  }));
  buildLog('runtime.bundle.transfer.verified', 'info', { sha256: bundle.archiveSha256 });
  beginBuildPhase('runtime.install');
  await withBuildStep('runtime.install', { sandboxId: builder.sandboxId, runtimeKey: runtimeKey.slice(0, 16) }, () => installRuntime(builder!, lockHash, runtimeWheelSha256, runtimeKey, buildRunId));

  beginBuildPhase('pi-runtime.bundle.transfer');
  buildLog('pi-runtime.bundle.transfer.start', 'info', { sandboxId: builder.sandboxId, bytes: piBundle.size, sha256: piBundle.archiveSha256, runtimeKey: piRuntimeKey.slice(0, 16) });
  await withBuildStep('pi-runtime.bundle.transfer', { sandboxId: builder.sandboxId, bytes: piBundle.size, sha256: piBundle.archiveSha256, runtimeKey: piRuntimeKey.slice(0, 16) }, () => stageRuntimeBundle(builder!, piBundle, async event => {
    buildLog('pi-runtime.bundle.' + event.stage, event.level, {
      message: event.message,
      ...(event.durationMs === undefined ? {} : { durationMs: event.durationMs }),
      ...event.details,
    });
  }));
  buildLog('pi-runtime.bundle.transfer.verified', 'info', { sandboxId: builder.sandboxId, sha256: piBundle.archiveSha256, runtimeKey: piRuntimeKey.slice(0, 16) });

  beginBuildPhase('pi-runtime.install');
  await withBuildStep('pi-runtime.install', { sandboxId: builder.sandboxId, runtimeKey: piRuntimeKey.slice(0, 16), version: piManifest.version }, () => installPiRuntime(builder!, piBundle, piRuntimeKey, piManifest.version || '', buildRunId));

  beginBuildPhase('runtime.post-install.checks');
  buildLog('runtime.post-install.checks.start', 'info', { sandboxId: builder.sandboxId });
  const setup = await withBuildStep('runtime.post-install.checks', { sandboxId: builder.sandboxId }, () => runBuildGuestCommand(
    'runtime.post-install.checks',
    builder!,
    [
      'set -eu',
      'echo check.runtime.ready-marker.start',
      'test -f ' + runtimeState + '/ready',
      'echo check.runtime.ready-marker.passed',
      'test "$(cat ' + runtimeState + '/package-lock.sha256)" = ' + lockHash,
      'test "$(cat ' + runtimeState + '/runtime-wheel.sha256)" = ' + runtimeWheelSha256,
      'test "$(cat ' + runtimeState + '/runtime-key.sha256)" = ' + runtimeKey,
      'echo check.runtime.hashes.passed',
      'test -x ' + runtimeRoot + '/bin/node',
      'test -s ' + runtimeRoot + '/dsh-sdk-client/dist/run-task.bundle.mjs',
      'test -s ' + runtimeRoot + '/dsh-sdk-client/package.json',
      'test -s ' + runtimeRoot + '/chrome-cdp-pipe-bridge.cjs',
      'test -s ' + runtimeRoot + '/dsh-runtime-launcher.mjs',
      'test -x ' + runtimeRoot + '/dsh-runtime-bin/runtime/deepseek-harness-sdk-runtime-linux-arm64',
      'test -x ' + runtimeRoot + '/dsh-runtime-bin/runtime/deepseek-harness-sdk-runtime-linux-arm64-rg',
      'test -f ' + runtimeRoot + '/dsh-runtime-bin/runtime/linux-arm64/downloads.json',
      'echo check.runtime.files.passed',
      'echo template.desktop-user.lookup.start',
      'desktop_user="$(getent passwd 1000 | cut -d: -f1)"',
      'test -n "$desktop_user"',
      'desktop_uid="$(id -u "$desktop_user")"',
      'desktop_gid="$(id -g "$desktop_user")"',
      'echo template.desktop-user.lookup.passed',
      'echo check.runtime.desktop-user-access.start',
      'setpriv --reuid="$desktop_uid" --regid="$desktop_gid" --init-groups -- test -r ' + runtimeRoot + '/dsh-sdk-client/dist/run-task.bundle.mjs',
      'setpriv --reuid="$desktop_uid" --regid="$desktop_gid" --init-groups -- env CSA_DSH_BUNDLE_IMPORT_SMOKE=1 ' + runtimeRoot + '/bin/node ' + runtimeRoot + '/dsh-sdk-client/dist/run-task.bundle.mjs',
      'echo check.runtime.desktop-user-access.passed',
      'echo smoke.worker.sdk-import.start',
      'CSA_DSH_BUNDLE_IMPORT_SMOKE=1 ' + runtimeRoot + '/bin/node ' + runtimeRoot + '/dsh-sdk-client/dist/run-task.bundle.mjs',
      'echo smoke.worker.sdk-import.passed',
      runtimeRoot + '/bin/node -e ' + shellQuote('const [major, minor] = process.versions.node.split(".").map(Number); process.exit(major > 24 || (major === 24 && minor >= 9) ? 0 : 1)'),
      'echo check.runtime.profile-smoke.installer-passed',
      'echo template.profile.install.start',
      'install -d -m 0755 /etc/profile.d',
      'printf "%s\\n" ' + shellQuote('export PATH=' + runtimeRoot + '/bin:' + runtimeRoot + ':$PATH') + ' > /etc/profile.d/csa-agent-runtime.sh',
      'echo template.profile.install.passed',
      'echo template.desktop-profile.update.start',
      'for profile in /workspace/.desktop-home/.profile /workspace/.desktop-home/.bashrc; do touch "$profile"; grep -Fq /etc/profile.d/csa-agent-runtime.sh "$profile" || printf "%s\\n" ". /etc/profile.d/csa-agent-runtime.sh" >> "$profile"; done',
      'echo template.desktop-profile.update.passed',
      'echo template.workspace.prepare.start',
      'install -d -o "$desktop_user" -g "$desktop_gid" -m 0755 /workspace/tasks',
      'echo template.workspace.clean.start',
      'timeout --kill-after=5s 90s rm -rf /workspace/.csa-super-agent /workspace/tasks/*',
      'echo template.workspace.clean.passed',
      'echo template.transient-files.clean.start',
      'rm -f ' + runtimeState + '/install.exit ' + runtimeState + '/install.phase ' + runtimeState + '/install.log ' + runtimeState + '/installer-launch.log ' + runtimeState + '/installer.pid /tmp/csa-bootstrap-dsh-runtime.sh /tmp/csa-run-dsh-runtime-bootstrap.sh /root/.bash_history /workspace/.desktop-home/.bash_history',
      'echo template.transient-files.clean.passed',
      'echo template.desktop-tools.check.start',
      'command -v chromium >/dev/null || command -v chromium-browser >/dev/null',
      'python3 --version',
      runtimeRoot + '/bin/node --version',
      'echo template.desktop-tools.check.passed',
      'echo template_builder_workspace_clean',
    ].join('\n'),
    '/',
    {},
    10 * 60_000,
  ));
  if (setup.exitCode !== 0) {
    buildLog('runtime.post-install.checks.failed', 'error', { sandboxId: builder.sandboxId, exitCode: setup.exitCode, output: safeBuildError(setup.output).slice(-1600) });
    throw new Error('模板构建 VM 的 DSH、Linux 桌面或工作目录验收失败：' + setup.output.slice(-1200));
  }
  buildLog('runtime.post-install.checks.passed', 'info', { sandboxId: builder.sandboxId, output: setup.output.trim().slice(-600) });
  if (await builder.files.exists('/workspace/.csa-super-agent')) throw new Error('模板构建 VM 仍有 DSH 会话数据。');
  if ((await builder.files.list('/workspace/tasks')).length !== 0) throw new Error('模板构建 VM 的任务目录不为空。');
  beginBuildPhase('desktop.session.start-and-verify');
  desktopSession = await startDesktopSession(builder);
  const activeDesktopSession = desktopSession;

  beginBuildPhase('snapshot.create');
  const snapshotName = 'csa-dsh-node24-' + runtimeVersion.replaceAll('.', '').replaceAll('-', '') + '-pi' + piManifest.version!.replaceAll('.', '') + '-' + runtimeKey.slice(0, 8) + '-' + piRuntimeKey.slice(0, 8) + '-' + Date.now().toString(36);
  buildLog('snapshot.create.start', 'info', { snapshotName, sandboxId: builderSandboxId });
  const snapshot = await withBuildStep('snapshot.create', { snapshotName, sandboxId: builderSandboxId }, () => builder!.createSnapshot(snapshotName));
  createdSnapshotId = snapshot.snapshotId;
  if (!createdSnapshotId) throw new Error('CubeSandbox 没有为 DSH 模板构建返回 snapshot ID。');
  buildLog('snapshot.create.ready', 'info', {
    snapshotId: createdSnapshotId,
    snapshotName,
    desktopPtyPid: activeDesktopSession.handle.pid,
    desktopPtyState: activeDesktopSession.state,
    desktopPtyOutputBytes: activeDesktopSession.outputBytes,
    desktopPtyOutputLines: activeDesktopSession.outputLines,
  });
  await logBuildStorage('host-storage.before-snapshot-verification', {
    repository: process.cwd(),
    buildLogs: buildLogDirectory,
    runtimeCache: join(homedir(), '.local/share/csa-cube-node/runtime-cache'),
  });
  process.stdout.write('template_snapshot_created ' + createdSnapshotId + '\n');

  // Two existing tenant VMs already use the local node's capacity. Release the
  // temporary builder before creating a clone for validation.
  activeDesktopSession.detached = true;
  activeDesktopSession.handle.disconnect();
  buildLog('desktop.session.pty.disconnect', 'info', {
    sandboxId: builderSandboxId,
    pid: activeDesktopSession.handle.pid,
    reason: 'builder-will-be-released-after-snapshot',
    outputBytes: activeDesktopSession.outputBytes,
    outputLines: activeDesktopSession.outputLines,
  });
  desktopSession = undefined;
  buildLog('builder.release.kill.start', 'info', { sandboxId: builderSandboxId });
  await builder.kill();
  builderCleanup = 'deleted';
  buildLog('builder.release.kill.complete', 'info', { sandboxId: builderSandboxId, result: builderCleanup });
  builder = undefined;
  buildLog('sandbox.release.wait.start', 'info', { sandboxId: builderSandboxId });
  await waitUntilSandboxReleased(builderSandboxId);

  beginBuildPhase('snapshot.clone.verify');
  await logCubeSandboxCapacity('sandbox.capacity.before-clone-verification');
  buildLog('snapshot.clone.create.start', 'info', { snapshotId: createdSnapshotId });
  verifier = await withBuildStep('snapshot.clone.create', { snapshotId: createdSnapshotId, ...cubeControlPlaneSummary() }, () => Sandbox.create({
    config: cubeConfig(templateCreateTimeoutMs),
    template: createdSnapshotId,
    timeout: NEVER_TIMEOUT,
    allowInternetAccess: true,
    network: { allowPublicTraffic: false },
    extra: { restartPolicy: 'Never' },
    metadata: { csa_template_verifier: 'true', csa_template_build_run: buildRunId, csa_template_runtime_lock: runtimeKey.slice(0, 16), csa_template_dsh_version: runtimeVersion, csa_template_pi_lock: piRuntimeKey.slice(0, 16), csa_template_pi_version: String(piManifest.version) },
  }));
  buildLog('snapshot.clone.create.ready', 'info', { snapshotId: createdSnapshotId, sandboxId: verifier.sandboxId, idleTimeoutSeconds: NEVER_TIMEOUT });
  buildLog('snapshot.clone.start', 'info', { snapshotId: createdSnapshotId });
  await waitUntilSandboxRuns(verifier);
  await writeGuestTextFile(verifier, '/tmp/csa-dsh-profile-initialize-smoke.mjs', profileInitializeSmoke);
  const cloneCheck = await withBuildStep('snapshot.clone.check', { snapshotId: createdSnapshotId, sandboxId: verifier.sandboxId }, () => runBuildGuestCommand(
    'snapshot.clone.check',
    verifier!,
    [
      'set -eu',
      'echo check.clone.runtime-markers.start',
      'test -f ' + runtimeState + '/ready',
      'test "$(cat ' + runtimeState + '/package-lock.sha256)" = ' + lockHash,
      'test "$(cat ' + runtimeState + '/runtime-wheel.sha256)" = ' + runtimeWheelSha256,
      'test "$(cat ' + runtimeState + '/runtime-key.sha256)" = ' + runtimeKey,
      'echo check.clone.runtime-markers.passed',
      'echo check.clone.runtime-files.start',
      'test -s ' + runtimeRoot + '/dsh-runtime-launcher.mjs',
      'test -s ' + runtimeRoot + '/dsh-sdk-client/dist/run-task.bundle.mjs',
      'test -s ' + runtimeRoot + '/dsh-sdk-client/package.json',
      'test -s ' + runtimeRoot + '/chrome-cdp-pipe-bridge.cjs',
      'test -x ' + runtimeRoot + '/dsh-runtime-bin/runtime/deepseek-harness-sdk-runtime-linux-arm64',
      'test -x ' + runtimeRoot + '/dsh-runtime-bin/runtime/deepseek-harness-sdk-runtime-linux-arm64-rg',
      'test -f ' + runtimeRoot + '/dsh-runtime-bin/runtime/linux-arm64/downloads.json',
      runtimeRoot + '/bin/node -e ' + shellQuote('const [major, minor] = process.versions.node.split(".").map(Number); process.exit(major > 24 || (major === 24 && minor >= 9) ? 0 : 1)'),
      'echo check.clone.runtime-files.passed',
      'echo check.clone.desktop-packages.start',
      'test -f /var/lib/csa-desktop/ready',
      'command -v python3 >/dev/null',
      'command -v chromium >/dev/null || command -v chromium-browser >/dev/null',
      'echo check.clone.desktop-packages.passed',
      'test -d /workspace/tasks',
      'test -z "$(find /workspace/tasks -mindepth 1 -maxdepth 1 -print -quit)"',
      'echo check.clone.desktop-session.start',
      'test -f /run/csa-desktop/session.ready',
      'session_pid="$(cat /run/csa-desktop/session.pid)"',
      'test "$session_pid" -gt 1',
      'session_state="$(ps -p "$session_pid" -o stat= | awk \'NF { print substr($1, 1, 1) }\')"',
      'test -n "$session_state" && test "$session_state" != Z',
      'websockify_listener_count="$(awk \'$4 == "0A" { split($2, endpoint, ":"); if (toupper(endpoint[2]) == "17C0") count++ } END { print count + 0 }\' /proc/net/tcp /proc/net/tcp6)"',
      'test "$websockify_listener_count" -gt 0',
      'echo check.clone.websockify.passed',
      'echo check.clone.chrome-cdp.start timeout_seconds=360',
      'cdp_started=$SECONDS; cdp_attempt=0; cdp_ready=0; cdp_body="/tmp/csa-clone-cdp-$$.json"; cdp_error="/tmp/csa-clone-cdp-$$.stderr"; : >"$cdp_body"; : >"$cdp_error"',
      'while [ "$((SECONDS - cdp_started))" -lt 360 ]; do cdp_attempt=$((cdp_attempt + 1)); if cdp_meta="$(timeout --kill-after=1s 4s curl --noproxy "*" --connect-timeout 1 --max-time 3 -sS -o "$cdp_body" -w "%{http_code}|%{time_total}|%{size_download}" http://127.0.0.1:9222/json/version 2>"$cdp_error")"; then cdp_exit=0; else cdp_exit=$?; fi; cdp_http="${cdp_meta%%|*}"; cdp_rest="${cdp_meta#*|}"; cdp_time="${cdp_rest%%|*}"; cdp_size="${cdp_rest#*|}"; case "$cdp_meta" in *"|"*) ;; *) cdp_http=000; cdp_time=0; cdp_size=0 ;; esac; cdp_actual_bytes="$(wc -c <"$cdp_body" | tr -d "[:space:]")"; cdp_listener_count="$(awk \'$4 == "0A" { split($2, endpoint, ":"); if (toupper(endpoint[2]) == "2406") count++ } END { print count + 0 }\' /proc/net/tcp /proc/net/tcp6 2>/dev/null)"; if [ "$cdp_exit" -eq 0 ] && [ "$cdp_http" = 200 ] && [ "$cdp_actual_bytes" -gt 0 ] && ' + runtimeRoot + '/bin/node -e ' + shellQuote('const fs=require("fs"); const d=JSON.parse(fs.readFileSync(process.argv[1],"utf8")); if(!d.Browser||!d.webSocketDebuggerUrl)process.exit(1)') + ' "$cdp_body"; then cdp_ready=1; echo "check.clone.chrome-cdp.passed attempt=$cdp_attempt elapsed_seconds=$((SECONDS - cdp_started)) http_code=$cdp_http response_bytes=$cdp_actual_bytes time_total=$cdp_time"; break; fi; cdp_error_tail="$(tr "\\n" " " <"$cdp_error" | cut -c1-180)"; echo "check.clone.chrome-cdp.probe attempt=$cdp_attempt elapsed_seconds=$((SECONDS - cdp_started)) curl_exit=$cdp_exit http_code=${cdp_http:-000} response_bytes=$cdp_actual_bytes listener_count=$cdp_listener_count time_total=$cdp_time curl_error=$cdp_error_tail"; sleep 5; done',
      'if [ "$cdp_ready" -ne 1 ]; then echo "check.clone.chrome-cdp.failed attempts=$cdp_attempt elapsed_seconds=$((SECONDS - cdp_started))"; cat "$cdp_error"; exit 1; fi; rm -f "$cdp_body" "$cdp_error"',
      'echo check.clone.desktop-session.passed pid="$session_pid" state="$session_state"',
      'desktop_user="$(getent passwd 1000 | cut -d: -f1)"',
      'test -n "$desktop_user"',
      'desktop_uid="$(id -u "$desktop_user")"',
      'desktop_gid="$(id -g "$desktop_user")"',
      'echo check.clone.desktop-user-access.start',
      'setpriv --reuid="$desktop_uid" --regid="$desktop_gid" --init-groups -- /usr/bin/test -r ' + runtimeRoot + '/dsh-sdk-client/dist/run-task.bundle.mjs',
      'setpriv --reuid="$desktop_uid" --regid="$desktop_gid" --init-groups -- /usr/bin/test -x ' + runtimeRoot + '/dsh-runtime-bin/runtime/deepseek-harness-sdk-runtime-linux-arm64',
      'setpriv --reuid="$desktop_uid" --regid="$desktop_gid" --init-groups -- /usr/bin/test -x ' + runtimeRoot + '/bin/node',
      'echo check.clone.desktop-user-access.passed',
      'echo smoke.worker.sdk-import.start',
      'setpriv --reuid="$desktop_uid" --regid="$desktop_gid" --init-groups -- env CSA_DSH_BUNDLE_IMPORT_SMOKE=1 ' + runtimeRoot + '/bin/node ' + runtimeRoot + '/dsh-sdk-client/dist/run-task.bundle.mjs',
      'echo smoke.worker.sdk-import.passed',
      'install -d -o "$desktop_uid" -g "$desktop_gid" -m 0700 /tmp/csa-dsh-clone-smoke-home',
      'echo smoke.dsh.initialize.start timeout_seconds=480 profile=sdk-minimal provider=deepseek-official model=deepseek-flash api_key=false computer_plugin=true',
      'timeout --kill-after=20s 540s setpriv --reuid="$desktop_uid" --regid="$desktop_gid" --init-groups -- env DEEPSEEK_API_KEY= DSH_HOME=/tmp/csa-dsh-clone-smoke-home CSA_DSH_LAUNCH_LOG=/tmp/csa-dsh-clone-smoke-home/launcher.log CSA_DSH_RUNTIME_EXECUTABLE=' + runtimeRoot + '/dsh-runtime-bin/runtime/deepseek-harness-sdk-runtime-linux-arm64 DSH_PERMISSION_MODE=danger-full-access HOME=/workspace/.desktop-home ' + runtimeRoot + '/bin/node /tmp/csa-dsh-profile-initialize-smoke.mjs',
      'echo smoke.dsh.initialize.passed',
      'echo cleanup.clone-smoke-home.start',
      'timeout --kill-after=5s 90s rm -rf /tmp/csa-dsh-clone-smoke-home /tmp/csa-dsh-profile-initialize-smoke.mjs',
      'echo cleanup.clone-smoke-home.passed',
      'echo dsh_template_clone_valid',
    ].join('; '),
    '/',
    {},
    20 * 60_000,
  ));
  if (cloneCheck.exitCode !== 0) {
    buildLog('snapshot.clone.check.failed', 'error', { snapshotId: createdSnapshotId, exitCode: cloneCheck.exitCode, output: safeBuildError(cloneCheck.output).slice(-1200) });
    throw new Error('从模板 snapshot 创建的 microVM 未通过 DSH、桌面和干净工作区校验：' + cloneCheck.output.slice(-1200));
  }
  buildLog('snapshot.clone.check.passed', 'info', { snapshotId: createdSnapshotId, exitCode: cloneCheck.exitCode, checks: 'runtime hashes and executables, desktop marker and live process, noVNC HTTP, Chrome CDP HTTP, Chromium, Python, empty workspace, DSH initialize/shutdown with the Computer Use plugin' });

  beginBuildPhase('snapshot.clone.pi-runtime.check');
  buildLog('snapshot.clone.pi-runtime.check.start', 'info', {
    snapshotId: createdSnapshotId,
    sandboxId: verifier.sandboxId,
    runtimeKey: piRuntimeKey.slice(0, 16),
    version: piManifest.version,
    modelCall: false,
  });
  const piCloneCheck = await withBuildStep('snapshot.clone.pi-runtime.check', {
    snapshotId: createdSnapshotId,
    sandboxId: verifier.sandboxId,
    runtimeKey: piRuntimeKey.slice(0, 16),
  }, () => runBuildGuestCommand(
    'snapshot.clone.pi-runtime.check',
    verifier!,
    [
      'set -eu',
      'echo check.clone.pi-markers.start',
      'test -f ' + runtimeState + '/pi-runtime-key.sha256',
      'test "$(cat ' + runtimeState + '/pi-runtime-key.sha256)" = ' + shellQuote(piRuntimeKey),
      'test -s ' + runtimeRoot + '/pi-' + piRuntimeKey.slice(0, 16) + '/run-task.mjs',
      'test -s ' + runtimeRoot + '/pi-' + piRuntimeKey.slice(0, 16) + '/package-lock.json',
      'test -s ' + runtimeRoot + '/pi-' + piRuntimeKey.slice(0, 16) + '/node_modules/@mariozechner/pi-coding-agent/package.json',
      'echo check.clone.pi-markers.passed version=' + piManifest.version,
      'desktop_user="$(getent passwd 1000 | cut -d: -f1)"',
      'test -n "$desktop_user"',
      'desktop_uid="$(id -u "$desktop_user")"',
      'desktop_gid="$(id -g "$desktop_user")"',
      'echo smoke.clone.pi-import.start timeout_seconds=600 identity=desktop-user model_call=false',
      'timeout --kill-after=20s 600s setpriv --reuid="$desktop_uid" --regid="$desktop_gid" --init-groups -- env CSA_PI_BUNDLE_IMPORT_SMOKE=1 HOME=/workspace/.desktop-home ' + runtimeRoot + '/bin/node ' + runtimeRoot + '/pi-' + piRuntimeKey.slice(0, 16) + '/run-task.mjs',
      'echo smoke.clone.pi-import.passed',
      'echo csa_template_clone_pi_runtime_valid',
    ].join('\n'),
    '/',
    {},
    11 * 60_000,
  ));
  if (piCloneCheck.exitCode !== 0 || !piCloneCheck.output.includes('pi_sdk_import_smoke_ok')) {
    buildLog('snapshot.clone.pi-runtime.check.failed', 'error', {
      snapshotId: createdSnapshotId,
      sandboxId: verifier.sandboxId,
      exitCode: piCloneCheck.exitCode,
      output: safeBuildError(piCloneCheck.output).slice(-1800),
    });
    throw new Error('模板 snapshot 克隆后的 Pi SDK 标记或桌面用户导入检查失败：' + safeBuildError(piCloneCheck.output).slice(-1200));
  }
  buildLog('snapshot.clone.pi-runtime.check.passed', 'info', {
    snapshotId: createdSnapshotId,
    sandboxId: verifier.sandboxId,
    runtimeKey: piRuntimeKey.slice(0, 16),
    version: piManifest.version,
    importSmokeOutput: safeBuildError(piCloneCheck.output).trim().slice(-1000),
  });
  buildLog('snapshot.clone.verified', 'info', { snapshotId: createdSnapshotId });
  snapshotVerified = true;
  buildLog('verifier.cleanup.kill.start', 'info', { sandboxId: verifier.sandboxId, snapshotId: createdSnapshotId });
  await verifier.kill();
  verifierCleanup = 'deleted';
  buildLog('verifier.cleanup.kill.complete', 'info', { sandboxId: verifier.sandboxId, result: verifierCleanup });
  verifier = undefined;

  finishBuildPhase();
  buildLog('template.complete', 'info', { buildRunId, buildLogPath, snapshotId: createdSnapshotId, durationMs: Date.now() - buildStartedAt, snapshotVerified, runtimeKey: runtimeKey.slice(0, 16), piRuntimeKey: piRuntimeKey.slice(0, 16), completedPhases: [...buildPhaseTimeline] });
  await logBuildStorage('host-storage.template-complete', {
    repository: process.cwd(),
    buildLogs: buildLogDirectory,
    runtimeCache: join(homedir(), '.local/share/csa-cube-node/runtime-cache'),
  });
  process.stdout.write(JSON.stringify({
    builderSandboxId,
    baseTemplateId: templateId,
    snapshotId: createdSnapshotId,
    snapshotName,
    runtimeLockHash: runtimeKey,
    deepseekHarnessVersion: runtimeVersion,
    runtimeBundleBytes: bundle.size,
    piRuntimeLockHash: piRuntimeKey,
    piPackage: piManifest.package,
    piVersion: piManifest.version,
    piRuntimeBundleBytes: piBundle.size,
    desktopReady: true,
    dshRuntimeReady: true,
    piRuntimeReady: true,
    browserSessionClean: true,
    snapshotCloneVerified: snapshotVerified,
  }) + '\n');
} catch (error) {
  if (websockifyDiagnosticOnly && error instanceof Error && error.message === 'CSA_WEBSOCKIFY_DIAGNOSTIC_COMPLETE') {
    buildLog('websockify.diagnostic.only.complete', 'info', { builderSandboxId, snapshotCreated: false, runtimeTransferSkipped: true });
    finishBuildPhase();
  } else if (chromiumDiagnosticOnly && error instanceof Error && error.message === 'CSA_CHROMIUM_DIAGNOSTIC_COMPLETE') {
    buildLog('chromium.diagnostic.only.complete', 'info', { builderSandboxId, snapshotCreated: false, runtimeTransferSkipped: true });
    finishBuildPhase();
  } else if (chromiumSessionDiagnosticOnly && error instanceof Error && error.message === 'CSA_CHROMIUM_SESSION_DIAGNOSTIC_COMPLETE') {
    buildLog('chromium.session.diagnostic.only.complete', 'info', { builderSandboxId, snapshotCreated: false, runtimeTransferSkipped: true });
    finishBuildPhase();
  } else if (desktopProbeOnly && error instanceof Error && error.message === 'CSA_DESKTOP_PROBE_ONLY_COMPLETE') {
    buildLog('desktop.probe.only.complete', 'info', { builderSandboxId, snapshotCreated: false, runtimeTransferSkipped: true });
    finishBuildPhase();
  } else {
    buildLog('template.failed', 'error', {
      message: safeBuildError(error),
      errorDetails: safeBuildErrorDetails(error),
    });
    finishBuildPhase('failed', { error: safeBuildError(error) });
    throw error;
  }
} finally {
  beginBuildPhase('cleanup', { builderSandboxId, snapshotId: createdSnapshotId, snapshotVerified });
  buildLog('builder.cleanup.start', 'info', { builderSandboxId, snapshotId: createdSnapshotId, snapshotVerified });
  if (verifier) {
    buildLog('verifier.cleanup.start', 'info', { sandboxId: verifier.sandboxId });
    try {
      await verifier.kill();
      verifierCleanup = 'deleted';
      buildLog('verifier.cleanup.complete', 'info', { sandboxId: verifier.sandboxId, result: verifierCleanup });
    } catch (cleanupError) {
      verifierCleanup = 'failed';
      buildLog('verifier.cleanup.failed', 'error', { sandboxId: verifier.sandboxId, message: safeBuildError(cleanupError) });
    }
    try {
      verifier.close();
      buildLog('verifier.cleanup.client-close.complete', 'info', { sandboxId: verifier.sandboxId });
    } catch (closeError) {
      buildLog('verifier.cleanup.client-close.failed', 'warning', { sandboxId: verifier.sandboxId, message: safeBuildError(closeError) });
    }
  }
  if (builder) {
    const cleanupBuilder = builder;
    const cleanupBuilderId = cleanupBuilder.sandboxId;
    if (chromiumSessionDiagnosticOnly) {
      try {
        await collectCubeSandboxDiagnosticLogs(cleanupBuilderId);
      } catch (diagnosticLogError) {
        buildLog('cube.diagnostic.logs.failed', 'warning', {
          sandboxId: cleanupBuilderId,
          buildRunId,
          error: safeBuildError(diagnosticLogError),
        });
      }
    }
    if (desktopSession) {
      desktopSession.detached = true;
      buildLog('desktop.session.pty.kill.start', 'info', { sandboxId: cleanupBuilderId, pid: desktopSession.handle.pid, reason: 'failed-build-cleanup' });
      try {
        const killed = await desktopSession.handle.kill();
        buildLog('desktop.session.pty.kill.complete', killed ? 'info' : 'warning', { sandboxId: cleanupBuilderId, pid: desktopSession.handle.pid, killed });
      } catch (ptyError) {
        buildLog('desktop.session.pty.kill.failed', 'warning', { sandboxId: cleanupBuilderId, pid: desktopSession.handle.pid, error: safeBuildError(ptyError) });
      }
      desktopSession.handle.disconnect();
      desktopSession = undefined;
    }
    buildLog('builder.cleanup.kill.start', 'info', { sandboxId: cleanupBuilderId });
    try {
      await cleanupBuilder.kill();
      builderCleanup = 'deleted';
      buildLog('builder.cleanup.kill.complete', 'info', { sandboxId: cleanupBuilderId, result: builderCleanup });
    } catch (cleanupError) {
      builderCleanup = 'kill-failed';
      buildLog('builder.cleanup.kill.failed', 'error', { sandboxId: cleanupBuilderId, message: safeBuildError(cleanupError) });
      try {
        const info = await cleanupBuilder.getInfo();
        buildLog('builder.cleanup.state.after-kill-failure', 'warning', { sandboxId: cleanupBuilderId, state: String(info.state || 'unknown') });
      } catch (stateError) {
        buildLog('builder.cleanup.state.check.failed', 'warning', { sandboxId: cleanupBuilderId, message: safeBuildError(stateError) });
      }
    }
    try {
      cleanupBuilder.close();
      buildLog('builder.cleanup.client-close.complete', 'info', { sandboxId: cleanupBuilderId });
    } catch (closeError) {
      buildLog('builder.cleanup.client-close.failed', 'warning', { sandboxId: cleanupBuilderId, message: safeBuildError(closeError) });
    }
  }
  if (createdSnapshotId && !snapshotVerified) {
    buildLog('snapshot.cleanup.delete.start', 'info', { snapshotId: createdSnapshotId });
    try {
      const deleted = await Sandbox.deleteSnapshot(createdSnapshotId, { config: cubeConfig() });
      snapshotCleanup = deleted ? 'deleted' : 'not-found';
      buildLog('snapshot.cleanup.delete.complete', deleted ? 'info' : 'warning', { snapshotId: createdSnapshotId, result: snapshotCleanup });
    } catch (cleanupError) {
      snapshotCleanup = 'failed';
      buildLog('snapshot.cleanup.delete.failed', 'error', { snapshotId: createdSnapshotId, message: safeBuildError(cleanupError) });
    }
  }
  const cleanupFailed = [verifierCleanup, builderCleanup, snapshotCleanup].some(result => result === 'failed' || result === 'kill-failed');
  buildLog('builder.cleanup.complete', cleanupFailed ? 'error' : 'info', { builderSandboxId, snapshotId: createdSnapshotId, snapshotVerified, verifierCleanup, builderCleanup, snapshotCleanup });
  finishBuildPhase(cleanupFailed ? 'failed' : 'complete', { verifierCleanup, builderCleanup, snapshotCleanup });
  buildLog('template.phase.summary', cleanupFailed ? 'error' : 'info', { phases: [...buildPhaseTimeline], totalDurationMs: Date.now() - buildStartedAt, cleanupFailed });
  try {
    await getGlobalDispatcher().close();
    buildLog('process.cleanup.control-plane-dispatcher.complete');
  } catch (closeError) {
    buildLog('process.cleanup.control-plane-dispatcher.failed', 'warning', { message: safeBuildError(closeError) });
  }
}

function safeBuildError(error: unknown, maxLength = 2000): string {
  let message = error instanceof Error ? error.message : String(error);
  return redactBuildText(message).slice(-Math.max(1, maxLength));
}

function lastGuestEventLine(content: string | undefined, eventName: string, maxLength = 2200): string | undefined {
  if (!content) return undefined;
  const marker = `event=${eventName}`;
  const line = content.split(/\r?\n/).reverse().find(candidate => candidate.includes(marker));
  return line ? redactBuildText(line).slice(0, Math.max(1, maxLength)) : undefined;
}

function safeBuildErrorDetails(error: unknown, depth = 0): Record<string, unknown> {
  const value = error instanceof Error ? error : new Error(String(error));
  const details: Record<string, unknown> = {
    name: value.name || 'Error',
    message: value.message,
    ...(value.stack ? { stack: value.stack.slice(0, depth === 0 ? 5000 : 1800) } : {}),
  };
  for (const field of ['code', 'errno', 'syscall', 'status', 'statusCode', 'statusText', 'requestId', 'retryAfter', 'timeout', 'hostname', 'address', 'port', 'method', 'url'] as const) {
    const candidate = (value as Error & Record<typeof field, unknown>)[field];
    if (typeof candidate === 'string' || typeof candidate === 'number') {
      details[field] = field === 'url' ? safeBuildUrl(candidate) : candidate;
    }
  }
  if (depth >= 3) return safeBuildValue({ ...details, truncated: true }) as Record<string, unknown>;
  if (value.cause !== undefined) details.cause = safeBuildErrorDetails(value.cause, depth + 1);
  if (value instanceof AggregateError) details.errors = [...value.errors].slice(0, 5).map(item => safeBuildErrorDetails(item, depth + 1));
  return safeBuildValue(details) as Record<string, unknown>;
}

function safeBuildUrl(value: unknown): string {
  try {
    const url = new URL(String(value));
    return `${url.protocol}//${url.host}${url.pathname}`.slice(0, 500);
  } catch {
    return redactBuildText(String(value)).split(/[?#]/, 1)[0].slice(0, 500);
  }
}

function cubeControlPlaneSummary(): Record<string, unknown> {
  try {
    const endpoint = new URL(config.cube.apiUrl);
    return {
      endpoint: `${endpoint.protocol}//${endpoint.host}${endpoint.pathname}`,
      protocol: endpoint.protocol,
      host: endpoint.host,
      requestTimeoutMs: templateCreateTimeoutMs,
      authenticationConfigured: Boolean(config.cube.apiKey),
    };
  } catch {
    return { endpointConfigured: Boolean(config.cube.apiUrl), requestTimeoutMs: templateCreateTimeoutMs };
  }
}

function cubeConfig(requestTimeoutMs = config.cube.requestTimeoutMs): Config {
  if (!config.cube.apiUrl) throw new Error('外部环境文件中没有设置 CUBE_API_URL。');
  return new Config({
    apiUrl: config.cube.apiUrl,
    apiKey: config.cube.apiKey || undefined,
    templateId: config.cube.templateId || undefined,
    proxyNodeIp: config.cube.proxyNodeIp || undefined,
    proxyPort: config.cube.proxyPort,
    proxyScheme: config.cube.proxyScheme,
    sandboxDomain: config.cube.sandboxDomain,
    requestTimeoutMs,
  });
}

async function logCubeSandboxCapacity(stage: string): Promise<void> {
  const startedAt = Date.now();
  try {
    const sandboxes = await Sandbox.list(cubeConfig());
    const normalized = sandboxes.map(sandbox => ({
      sandboxId: String(sandbox.sandboxID || sandbox.sandboxId || ''),
      state: String(sandbox.state || 'unknown'),
      templateId: String(sandbox.templateID || sandbox.templateId || ''),
      cpuMilli: Number(sandbox.cpuMilli || Number(sandbox.cpuCount || 0) * 1000),
      memoryMB: Number(sandbox.memoryMB || sandbox.memoryMb || 0),
    }));
    const running = normalized.filter(sandbox => sandbox.state === 'running');
    buildLog(stage, 'info', {
      durationMs: Date.now() - startedAt,
      totalSandboxCount: normalized.length,
      runningCount: running.length,
      pausedCount: normalized.filter(sandbox => sandbox.state === 'paused').length,
      otherStates: normalized.filter(sandbox => sandbox.state !== 'running' && sandbox.state !== 'paused').map(sandbox => ({ sandboxId: sandbox.sandboxId, state: sandbox.state })),
      runningCpuMilliAllocated: running.reduce((total, sandbox) => total + sandbox.cpuMilli, 0),
      runningMemoryMBAllocated: running.reduce((total, sandbox) => total + sandbox.memoryMB, 0),
      sandboxes: normalized,
    });
  } catch (error) {
    buildLog(stage + '.failed', 'warning', {
      durationMs: Date.now() - startedAt,
      error: safeBuildError(error),
      errorDetails: safeBuildErrorDetails(error),
    });
  }
}

async function prepareRuntimeBundle(
  expectedRuntimeKey: string,
  script = runtimeBundleBuilderPath,
  runtimeLabel = 'DeepSeek Harness',
): Promise<RuntimeBundle> {
  const output = await new Promise<string>((resolveOutput, reject) => {
    const startedAt = Date.now();
    const child = spawn('bash', [script], {
      env: {
        ...process.env,
        CSA_NPM_HTTP_PROXY: config.agent.npmHttpProxy,
        CSA_EXPECTED_RUNTIME_KEY: expectedRuntimeKey,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderrTail = '';
    let stderrBytes = 0;
    let pendingStderrLine = '';
    let settled = false;
    buildLog('runtime.bundle.builder.process.start', 'info', {
      script,
      command: `bash ${script}`,
      runtimeLabel,
      expectedRuntimeKey: expectedRuntimeKey.slice(0, 16),
      pid: child.pid,
      logDirectory: resolve(process.env.CSA_BUILD_LOG_DIR?.trim() || join(homedir(), '.local/share/csa-cube-node/build-logs')),
    });
    child.stdout.on('data', chunk => { stdout += chunk.toString(); });
    child.stderr.on('data', chunk => {
      const value = chunk.toString();
      stderrBytes += Buffer.byteLength(value);
      stderrTail = (stderrTail + value).slice(-4000);
      pendingStderrLine += value;
      const lines = pendingStderrLine.split(/\r?\n/);
      pendingStderrLine = lines.pop() || '';
      for (const line of lines) {
        if (!line.trim()) continue;
        const level = classifyBuilderOutput(line);
        buildLog('runtime.bundle.builder-output', level, { line: safeBuildError(line).slice(0, 1000) });
      }
    });
    child.on('error', error => {
      settled = true;
      buildLog('runtime.bundle.builder.process.error', 'error', {
        pid: child.pid,
        durationMs: Date.now() - startedAt,
        stderrBytes,
        stderrTail: safeBuildError(stderrTail).slice(-2400),
        error: safeBuildError(error),
        errorDetails: safeBuildErrorDetails(error),
      });
      reject(error);
    });
    child.on('close', code => {
      if (pendingStderrLine.trim()) buildLog('runtime.bundle.builder-output', classifyBuilderOutput(pendingStderrLine), { line: safeBuildError(pendingStderrLine).slice(0, 1000) });
      if (settled) return;
      settled = true;
      const processDetails = {
        pid: child.pid,
        exitCode: code,
        signal: child.signalCode,
        durationMs: Date.now() - startedAt,
        stdoutBytes: Buffer.byteLength(stdout),
        stderrBytes,
        stderrTail: safeBuildError(stderrTail).slice(-2400),
      };
      if (code === 0) {
        buildLog('runtime.bundle.builder.process.complete', 'info', processDetails);
        resolveOutput(stdout.trim());
      } else {
        buildLog('runtime.bundle.builder.process.failed', 'error', processDetails);
        reject(new Error('经 HTTP 代理准备 Linux ARM64 ' + runtimeLabel + ' 依赖失败，退出码 ' + String(code) + '：' + stderrTail.trim().slice(-1800)));
      }
    });
  });
  const [archivePath, returnedRuntimeKey, archiveSha256] = output.split('\t');
  if (!archivePath || returnedRuntimeKey !== expectedRuntimeKey || !/^[a-f0-9]{64}$/.test(archiveSha256 || '')) {
    throw new Error('依赖准备脚本没有返回与当前 ' + runtimeLabel + ' runtime manifest 匹配的有效制品。');
  }
  const size = (await stat(archivePath)).size;
  const hash = await hashFile(archivePath);
  if (hash !== archiveSha256) throw new Error('Linux ARM64 ' + runtimeLabel + ' 依赖包 SHA-256 校验失败。');
  return { archivePath, archiveSha256, size };
}

function classifyBuilderOutput(line: string): 'info' | 'warning' | 'error' {
  const normalized = line.trim();
  if (/^(?:npm ERR!|error:|fatal:|e:|dpkg: error)/i.test(normalized) || /\b(?:build failed|installation failed|command failed|timed out)\b/i.test(normalized)) return 'error';
  if (/^(?:npm WARN|warning:|w:)/i.test(normalized)) return 'warning';
  return 'info';
}

async function hashFile(path: string): Promise<string> {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest('hex');
}

async function waitUntilSandboxRuns(sandbox: Sandbox): Promise<void> {
  const startedAt = Date.now();
  const deadline = startedAt + 5 * 60_000;
  let lastState = '';
  let lastProgressAt = Date.now();
  while (Date.now() < deadline) {
    const info = await sandbox.getInfo();
    const state = String(info.state || '').toLowerCase();
    const restartState = String(info.restartStatus?.restartState || '').toLowerCase();
    const currentState = state + (restartState ? ':' + restartState : '');
    const lifecycleDetails = {
      sandboxId: sandbox.sandboxId,
      state,
      restartState: restartState || 'none',
      restartCount: Number(info.restartStatus?.restartCount || 0),
      idleTimeoutSeconds: info.timeout,
      endAt: info.endAt,
      startedAt: info.startedAt,
    };
    if (currentState !== lastState) {
      buildLog('sandbox.lifecycle', restartState === 'backoff' ? 'warning' : 'info', lifecycleDetails);
      lastState = currentState;
      lastProgressAt = Date.now();
    } else if (Date.now() - lastProgressAt >= 30_000) {
      buildLog('sandbox.lifecycle.wait', 'info', { ...lifecycleDetails, elapsedSeconds: Math.floor((Date.now() - startedAt) / 1000) });
      lastProgressAt = Date.now();
    }
    if (state === 'running') return;
    if (['failed', 'gaveup', 'succeeded'].includes(restartState)) {
      throw new Error('CubeSandbox 构建 VM 启动失败：' + String(info.restartStatus?.lastExitReason || restartState));
    }
    await delay(2_000);
  }
  throw new Error('等待 CubeSandbox 构建 VM 启动超时。');
}

async function waitUntilSandboxReleased(sandboxId: string): Promise<void> {
  const startedAt = Date.now();
  const deadline = startedAt + 90_000;
  let releasedAt = 0;
  let lastHeartbeatAt = 0;
  while (Date.now() < deadline) {
    const sandboxes = await Sandbox.listV2(cubeConfig());
    const match = sandboxes.find(item => String(item.sandboxID ?? item.sandboxId ?? item.id ?? '') === sandboxId);
    if (!match) {
      if (!releasedAt) {
        releasedAt = Date.now();
        buildLog('sandbox.release.control-plane-cleared', 'info', { sandboxId, elapsedSeconds: Math.floor((releasedAt - startedAt) / 1000) });
      }
      if (Date.now() - releasedAt >= 15_000) {
        buildLog('sandbox.release.settled', 'info', { sandboxId, elapsedSeconds: Math.floor((Date.now() - startedAt) / 1000) });
        return;
      }
    } else {
      releasedAt = 0;
    }
    if (Date.now() - lastHeartbeatAt >= 10_000) {
      buildLog('sandbox.release.wait', 'info', { sandboxId, elapsedSeconds: Math.floor((Date.now() - startedAt) / 1000), state: String(match?.state || 'not-listed'), activeSandboxCount: sandboxes.length });
      lastHeartbeatAt = Date.now();
    }
    await delay(2_000);
  }
  throw new Error('CubeSandbox builder VM did not release its local microVM capacity within 90 seconds.');
}

async function checkSandboxLifecycle(sandbox: Sandbox, stage: string): Promise<void> {
  const now = Date.now();
  const lastCheckedAt = sandboxLifecycleCheckAt.get(sandbox) || 0;
  if (now - lastCheckedAt < sandboxLifecycleCheckIntervalMs) return;
  sandboxLifecycleCheckAt.set(sandbox, now);

  let info: Awaited<ReturnType<Sandbox['getInfo']>>;
  try {
    info = await sandbox.getInfo();
  } catch (error) {
    const statusCode = error && typeof error === 'object' && 'statusCode' in error
      ? Number((error as { statusCode?: unknown }).statusCode)
      : undefined;
    if (error instanceof SandboxNotFoundError || statusCode === 404) {
      const message = `CubeSandbox builder ${sandbox.sandboxId} disappeared while ${stage}.`;
      buildLog('sandbox.lifecycle.disappeared', 'error', { sandboxId: sandbox.sandboxId, stage, error: safeBuildError(error) });
      throw new Error(message);
    }
    if (isRetryableDataPlaneError(error)) {
      buildLog('sandbox.lifecycle.inspect.retry', 'warning', {
        sandboxId: sandbox.sandboxId,
        stage,
        error: safeBuildError(error),
        errorDetails: safeBuildErrorDetails(error),
      });
      return;
    }
    throw error;
  }

  const state = String(info.state || 'unknown').toLowerCase();
  const lifecycleDetails = {
    sandboxId: sandbox.sandboxId,
    stage,
    state,
    idleTimeoutSeconds: info.timeout,
    endAt: info.endAt,
    startedAt: info.startedAt,
    restartState: String(info.restartStatus?.restartState || 'none').toLowerCase(),
  };
  if (state !== 'running') {
    buildLog('sandbox.lifecycle.not-running', 'error', lifecycleDetails);
    throw new Error(`CubeSandbox builder ${sandbox.sandboxId} entered state ${state} while ${stage}; guest operations require a running VM.`);
  }
  buildLog('sandbox.lifecycle.data-plane-check', 'info', lifecycleDetails);
}

function noteSandboxDataPlaneFailure(sandbox: Sandbox, stage: string, error: unknown): void {
  const now = Date.now();
  const startedAt = sandboxDataPlaneFailureAt.get(sandbox) || now;
  sandboxDataPlaneFailureAt.set(sandbox, startedAt);
  const elapsedMs = now - startedAt;
  if (elapsedMs >= sandboxDataPlaneFailureLimitMs) {
    buildLog('sandbox.data-plane.unavailable', 'error', {
      sandboxId: sandbox.sandboxId,
      stage,
      elapsedMs,
      maxElapsedMs: sandboxDataPlaneFailureLimitMs,
      error: safeBuildError(error),
      errorDetails: safeBuildErrorDetails(error),
    });
    throw new Error(`CubeSandbox data plane remained unavailable for ${elapsedMs}ms while ${stage}; stopping this build instead of polling indefinitely.`);
  }
}

function noteSandboxDataPlaneSuccess(sandbox: Sandbox): void {
  sandboxDataPlaneFailureAt.delete(sandbox);
}

async function ensureDesktop(sandbox: Sandbox): Promise<void> {
  const desktopReadyFile = '/var/lib/csa-desktop/ready';
  const deadline = Date.now() + 60 * 60_000;
  const desktopSession = await readFile(resolve('scripts/cube/csa-desktop-session.sh'), 'utf8');
  const requiredSystemBusFiles = ['/usr/share/dbus-1/system.conf', '/usr/bin/dbus-daemon', '/usr/bin/dbus-launch'];
  const [desktopBootstrapReady, ...systemBusFilesReady] = await Promise.all([
    guestFileExists(sandbox, desktopReadyFile, deadline),
    ...requiredSystemBusFiles.map(path => guestFileExists(sandbox, path, deadline)),
  ]);
  const missingSystemBusFiles = requiredSystemBusFiles.filter((_, index) => !systemBusFilesReady[index]);
  if (!desktopBootstrapReady || missingSystemBusFiles.length > 0) {
    buildLog('desktop.bootstrap.required', 'info', {
      sandboxId: sandbox.sandboxId,
      reason: !desktopBootstrapReady ? 'desktop marker missing' : 'system bus runtime files missing',
      missingSystemBusFiles,
    });
    const desktopBootstrap = await readFile(resolve('scripts/cube/bootstrap-linux-desktop.sh'), 'utf8');
    const desktopLauncher = await readFile(resolve('scripts/cube/launch-linux-desktop-bootstrap.sh'), 'utf8');
    await sandbox.files.write('/tmp/csa-desktop-bootstrap.sh', desktopBootstrap);
    await sandbox.files.write('/tmp/csa-launch-desktop-bootstrap.sh', desktopLauncher);
    await sandbox.files.write('/tmp/csa-desktop-session.sh', desktopSession);
    const desktopEnvs = {
      COKE_DESKTOP_RESOLUTION: config.agent.desktopResolution,
      CSA_FORCE_DESKTOP_BOOTSTRAP: '1',
      CSA_TENANT_ID: 'template-builder',
      CSA_CUBE_SANDBOX_ID: sandbox.sandboxId,
      CSA_COMPUTER_GENERATION: 'template-build',
      CSA_RUN_ID: buildRunId,
      CSA_DESKTOP_CHROME_CDP_TIMEOUT_SECONDS: desktopProbeOnly ? '210' : '360',
      ...(config.agent.desktopAptMirror ? { CSA_APT_MIRROR: config.agent.desktopAptMirror } : {}),
    };
    const launch = await retryDataPlane(
      '启动 Linux 桌面初始化',
      deadline,
      // A cloned full snapshot took 40–43s to answer its first guest command on ARM64.
      // Keep the initial launcher on a streamed PTY: command.run's 60-second deadline
      // can expire while its detached guest child continues, causing duplicate launches.
      () => runBuildGuestCommand('desktop.bootstrap.launch', sandbox, 'bash /tmp/csa-launch-desktop-bootstrap.sh', '/', desktopEnvs, 180_000),
      sandbox,
    );
    if (launch.exitCode !== 0) throw new Error('无法启动 Linux 桌面初始化：' + launch.output.slice(-800));
    buildLog('desktop.bootstrap.launched', 'info', { sandboxId: sandbox.sandboxId, exitCode: launch.exitCode });

    let lastProgress = 0;
    while (Date.now() < deadline) {
      if (await guestFileExists(sandbox, desktopReadyFile, deadline)) break;
      if (await guestFileExists(sandbox, '/var/lib/csa-desktop/bootstrap.exitcode', deadline)) {
        const code = (await guestFileRead(sandbox, '/var/lib/csa-desktop/bootstrap.exitcode', deadline)).trim();
        const log = await guestFileRead(sandbox, '/var/lib/csa-desktop/bootstrap.log', deadline).catch(() => '');
        const diagnosticReads = await Promise.all([
          '/var/lib/csa-desktop/bootstrap.status',
          '/tmp/csa-desktop-session.log',
          '/tmp/csa-xfce.log',
          '/tmp/csa-websockify.log',
          '/tmp/csa-vnc.log',
          '/tmp/csa-xvfb.log',
          '/tmp/csa-chromium.log',
        ].map(async path => {
          try {
            return { path, content: await guestFileRead(sandbox, path, deadline) };
          } catch (error) {
            return { path, content: '', readError: safeBuildError(error) };
          }
        }));
        const diagnosticByPath = new Map(diagnosticReads.map(item => [item.path, item]));
        const sessionLog = diagnosticByPath.get('/tmp/csa-desktop-session.log');
        const xfceLog = diagnosticByPath.get('/tmp/csa-xfce.log');
        const websockifyLog = diagnosticByPath.get('/tmp/csa-websockify.log');
        const vncLog = diagnosticByPath.get('/tmp/csa-vnc.log');
        const xvfbLog = diagnosticByPath.get('/tmp/csa-xvfb.log');
        const chromiumLog = diagnosticByPath.get('/tmp/csa-chromium.log');
        const bootstrapStatus = diagnosticByPath.get('/var/lib/csa-desktop/bootstrap.status');
        buildLog('desktop.bootstrap.failure.capture', 'error', {
          sandboxId: sandbox.sandboxId,
          exitCode: code,
          bootstrapLogBytes: Buffer.byteLength(log),
          bootstrapLogTail: safeBuildError(log, 2_200),
          desktopReadinessFailureEvent: lastGuestEventLine(log, 'desktop-readiness.failed'),
          desktopReadinessSessionExitedEvent: lastGuestEventLine(log, 'desktop-readiness.session.exited'),
          desktopReadinessSessionPidInvalidEvent: lastGuestEventLine(log, 'desktop-readiness.session.pid.invalid'),
          xfceExitEvent: lastGuestEventLine(sessionLog?.content, 'xfce.exited'),
          xfceReadyTimeoutEvent: lastGuestEventLine(sessionLog?.content, 'xfce.ready.timeout'),
          desktopSessionCleanupEvent: lastGuestEventLine(sessionLog?.content, 'session.cleanup.start'),
          chromeFailureProfileEvent: lastGuestEventLine(sessionLog?.content, 'chrome.failure.profile'),
          chromeCdpTimeoutEvent: lastGuestEventLine(sessionLog?.content, 'chrome-cdp.ready.timeout'),
          chromeProcessSampleEvent: lastGuestEventLine(sessionLog?.content, 'chrome-cdp.process.sample', 5000),
          chromeFailureProcessTreeEvent: lastGuestEventLine(sessionLog?.content, 'chrome.failure.process-tree', 5000),
          chromeFailureSnapshotEvent: lastGuestEventLine(sessionLog?.content, 'chrome.failure.snapshot'),
          chromeStartupFailureEvent: lastGuestEventLine(sessionLog?.content, 'chrome.startup.failed'),
          bootstrapStatus: bootstrapStatus?.content ? safeBuildError(bootstrapStatus.content, 2_000) : undefined,
          bootstrapStatusReadError: bootstrapStatus?.readError,
          sessionLogBytes: Buffer.byteLength(sessionLog?.content || ''),
          sessionLogTail: sessionLog?.content ? safeBuildError(sessionLog.content, 2_200) : undefined,
          sessionLogReadError: sessionLog?.readError,
          xfceLogBytes: Buffer.byteLength(xfceLog?.content || ''),
          xfceLogTail: xfceLog?.content ? safeBuildError(xfceLog.content, 2_200) : undefined,
          xfceLogReadError: xfceLog?.readError,
          websockifyLogBytes: Buffer.byteLength(websockifyLog?.content || ''),
          websockifyLogTail: websockifyLog?.content ? safeBuildError(websockifyLog.content, 2_200) : undefined,
          websockifyLogReadError: websockifyLog?.readError,
          vncLogBytes: Buffer.byteLength(vncLog?.content || ''),
          vncLogTail: vncLog?.content ? safeBuildError(vncLog.content, 2_200) : undefined,
          vncLogReadError: vncLog?.readError,
          xvfbLogBytes: Buffer.byteLength(xvfbLog?.content || ''),
          xvfbLogTail: xvfbLog?.content ? safeBuildError(xvfbLog.content, 2_200) : undefined,
          xvfbLogReadError: xvfbLog?.readError,
          chromiumLogBytes: Buffer.byteLength(chromiumLog?.content || ''),
          chromiumLogTail: chromiumLog?.content ? safeBuildError(chromiumLog.content, 2_200) : undefined,
          chromiumLogReadError: chromiumLog?.readError,
        });
        throw new Error('Linux 桌面初始化失败，退出码 ' + code + '：' + log.slice(-1200));
      }
      if (Date.now() - lastProgress >= 30_000) {
        const log = await guestFileRead(sandbox, '/var/lib/csa-desktop/bootstrap.log', Date.now() + 5_000).catch(() => '');
        const apt = await guestFileRead(sandbox, '/var/lib/csa-desktop/apt.log', Date.now() + 5_000).catch(() => '');
        buildLog('desktop.bootstrap.wait', 'info', { sandboxId: sandbox.sandboxId, elapsedSeconds: Math.floor((Date.now() - (deadline - 60 * 60_000)) / 1000), bootstrapLogTail: log.trim().split(/\r?\n/).slice(-5).join(' | ').slice(-800), aptLogTail: apt.trim().split(/\r?\n/).slice(-5).join(' | ').slice(-800) });
        lastProgress = Date.now();
      }
      await delay(5_000);
    }
    if (!await guestFileExists(sandbox, desktopReadyFile, deadline)) throw new Error('Linux 桌面初始化超过 60 分钟。');
  }

  const desktopSessionSha256 = createHash('sha256').update(desktopSession).digest('hex');
  await withBuildStep('desktop.session.script.stage', {
    sandboxId: sandbox.sandboxId,
    path: '/tmp/csa-desktop-session.sh',
    bytes: Buffer.byteLength(desktopSession),
    sha256: desktopSessionSha256,
  }, () => sandbox.files.write('/tmp/csa-desktop-session.sh', desktopSession));
  const installSessionScript = await withBuildStep('desktop.session.script.install', {
    sandboxId: sandbox.sandboxId,
    path: '/usr/local/bin/csa-desktop-session',
    sha256: desktopSessionSha256,
  }, () => runBuildGuestCommandApi(
    'desktop.session.script.install',
    sandbox,
    [
      'set -eu',
      'install -m 0755 /tmp/csa-desktop-session.sh /usr/local/bin/csa-desktop-session',
      'installed_sha256="$(sha256sum /usr/local/bin/csa-desktop-session | awk \'{print $1}\')"',
      'printf "desktop_session_script_installed sha256=%s\\n" "$installed_sha256"',
      'test "$installed_sha256" = ' + shellQuote(desktopSessionSha256),
    ].join('\n'),
    '/',
    {},
    60_000,
  ));
  if (installSessionScript.exitCode !== 0) {
    throw new Error('Linux 桌面会话脚本未更新到当前源码：' + safeBuildError(installSessionScript.output).slice(-1000));
  }
  buildLog('desktop.session.script.install.verified', 'info', {
    sandboxId: sandbox.sandboxId,
    path: '/usr/local/bin/csa-desktop-session',
    sha256: desktopSessionSha256,
    output: safeBuildError(installSessionScript.output).trim().slice(-400),
  });

  const check = await retryDataPlane(
    '确认 Linux 桌面包已安装',
    deadline,
    () => runBuildGuestCommand(
      'desktop.packages.verify',
      sandbox,
      'set -eu; test -f ' + desktopReadyFile + '; test -x /usr/local/bin/csa-desktop-session; command -v websockify >/dev/null; command -v python3 >/dev/null; command -v chromium >/dev/null || command -v chromium-browser >/dev/null; echo linux_desktop_packages_ready novnc_assets=app-hosted',
      '/',
    ),
    sandbox,
  );
  if (check.exitCode !== 0) throw new Error('Linux 桌面包安装不完整：' + check.output.slice(-800));
  buildLog('desktop.packages.verified', 'info', { sandboxId: sandbox.sandboxId });
}

async function stopDesktopSession(sandbox: Sandbox): Promise<void> {
  const runStopCommand = async (stage: string, command: string, timeoutMs = 60_000): Promise<string> => {
    const result = await runBuildGuestCommandApi(stage, sandbox, command, '/', {}, timeoutMs);
    if (result.exitCode !== 0) throw new Error(`Linux 桌面停止阶段 ${stage} 失败：${result.output.slice(-800)}`);
    return result.output;
  };

  const inspect = await runStopCommand('desktop.session.stop.inspect', [
    'set -eu',
    'session_pid_file=/run/csa-desktop/session.pid',
    'if test ! -s "$session_pid_file"; then echo desktop.session.stop.no_pid_marker; exit 0; fi',
    'session_pid="$(cat "$session_pid_file")"',
    'case "$session_pid" in ""|*[!0-9]*) echo desktop.session.stop.invalid_pid pid="$session_pid"; exit 2 ;; esac',
    'session_state="$(ps -p "$session_pid" -o stat= 2>/dev/null | awk \'NF { print substr($1, 1, 1); exit }\')"',
    'if test -n "$session_state" && test "$session_state" != Z && test "$session_state" != X; then',
    '  session_command="$(tr "\\000" " " <"/proc/$session_pid/cmdline" 2>/dev/null || true)"',
    '  case "$session_command" in *csa-desktop-session*) ;; *) echo desktop.session.stop.pid_identity_mismatch pid="$session_pid" command="$session_command"; exit 3 ;; esac',
    'fi',
    'echo desktop.session.wrapper pid="$session_pid" state="${session_state:-missing}"',
  ].join('\n'), 60_000);
  const sessionPid = inspect.match(/desktop\.session\.wrapper pid=(\d+)/)?.[1];
  const initialState = inspect.match(/desktop\.session\.wrapper pid=\d+ state=(\S+)/)?.[1] || 'missing';
  const wrapperAlive = (state: string): boolean => !['missing', 'Z', 'X'].includes(state);

  if (sessionPid && wrapperAlive(initialState)) {
    await runStopCommand('desktop.session.stop.term', [
      'set -eu',
      `session_pid=${sessionPid}`,
      'session_command="$(tr "\\000" " " <"/proc/$session_pid/cmdline" 2>/dev/null || true)"',
      'case "$session_command" in *csa-desktop-session*) ;; *) echo desktop.session.stop.pid_identity_mismatch pid="$session_pid" command="$session_command"; exit 3 ;; esac',
      'echo desktop.session.stop.signal signal=TERM pid="$session_pid"',
      'kill -TERM "$session_pid"',
    ].join('\n'));
  }

  const readDesktopStatus = async (stage: string): Promise<{ wrapperState: string; components: Array<{ pid: string; state: string; comm: string }> }> => {
    const lines = ['set -eu'];
    if (sessionPid) {
      lines.push(`session_pid=${sessionPid}`);
      lines.push('session_state="$(ps -p "$session_pid" -o stat= 2>/dev/null | awk \'NF { print substr($1, 1, 1); exit }\')"');
      lines.push('echo desktop.session.wrapper pid="$session_pid" state="${session_state:-missing}"');
    }
    lines.push(
      'desktop_uid="$(id -u "$(getent passwd 1000 | cut -d: -f1)")"',
      'ps -u "$desktop_uid" -o pid=,stat=,comm= 2>/dev/null | awk \'$2 !~ /^Z/ && $2 !~ /^X/ && ($3 ~ /^(Xvfb|startxfce4|xfce4-session|xfwm4|xfsettingsd|xfce4-panel|Thunar|xfdesktop|x11vnc|websockify|chromium|chromium-browser|chrome_crashpad|xfconfd|dbus-daemon|pulseaudio)$/ || $3 ~ /^panel-/) { printf "desktop.session.component pid=%s state=%s comm=%s\\n", $1, $2, $3 }\'',
    );
    const output = await runStopCommand(stage, lines.join('\n'));
    const wrapperState = output.match(/desktop\.session\.wrapper pid=\d+ state=(\S+)/)?.[1] || 'missing';
    const components = [...output.matchAll(/desktop\.session\.component pid=(\d+) state=(\S+) comm=(\S+)/g)]
      .map(match => ({ pid: match[1], state: match[2], comm: match[3] }));
    return { wrapperState, components };
  };

  const signalComponents = async (signal: 'TERM' | 'KILL', components: Array<{ pid: string; state: string; comm: string }>): Promise<void> => {
    for (const { pid, comm } of components) {
      if (!/^\d+$/.test(pid) || !/^[A-Za-z0-9_-]+$/.test(comm)) throw new Error('桌面组件 PID/进程名格式无效。');
    }
    const specs = components.map(({ pid, comm }) => `${pid}:${comm}`).join(' ');
    const command = [
      'set -eu',
      `signal=${signal}`,
      `for component in ${specs}; do`,
      '  component_pid=${component%%:*}',
      '  expected_comm=${component#*:}',
      '  current_comm=',
      '  IFS= read -r current_comm <"/proc/$component_pid/comm" 2>/dev/null || current_comm=',
      '  if test "$current_comm" = "$expected_comm"; then',
      '    echo desktop.session.stop.signal signal="$signal" pid="$component_pid" comm="$current_comm"',
      '    kill -"$signal" "$component_pid" 2>/dev/null || true',
      '  else',
      '    echo desktop.session.stop.process-changed pid="$component_pid" expected="$expected_comm" actual="$current_comm"',
      '  fi',
      'done',
    ].join('\n');
    buildLog(`desktop.session.stop.component-${signal.toLowerCase()}.start`, 'info', {
      sandboxId: sandbox.sandboxId,
      signal,
      componentCount: components.length,
      components,
      commandBytes: Buffer.byteLength(command),
      timeoutMs: 60_000,
    });
    await runStopCommand(`desktop.session.stop.component-${signal.toLowerCase()}`, command, 60_000);
  };

  let status = await readDesktopStatus('desktop.session.stop.status.initial');
  if (sessionPid && wrapperAlive(status.wrapperState)) {
    await delay(3_000);
    status = await readDesktopStatus('desktop.session.stop.status.after-term');
    if (wrapperAlive(status.wrapperState)) {
      await runStopCommand('desktop.session.stop.kill', `set -eu; session_pid=${sessionPid}; echo desktop.session.stop.signal signal=KILL pid="$session_pid"; kill -KILL "$session_pid" 2>/dev/null || true`);
      await delay(1_000);
      status = await readDesktopStatus('desktop.session.stop.status.after-kill');
    }
  }
  if (sessionPid && wrapperAlive(status.wrapperState)) {
    throw new Error(`桌面会话 PID ${sessionPid} 在 TERM/KILL 后仍处于 ${status.wrapperState} 状态。`);
  }
  if (status.components.length > 0) {
    await signalComponents('TERM', status.components);
    await delay(1_000);
    status = await readDesktopStatus('desktop.session.stop.status.after-component-term');
    if (status.components.length > 0) {
      await signalComponents('KILL', status.components);
      await delay(1_000);
      status = await readDesktopStatus('desktop.session.stop.status.final');
    }
  }
  if (status.components.length > 0) {
    const retainedXvfb = status.components.length === 1 && status.components[0].comm === 'Xvfb'
      ? status.components[0]
      : undefined;
    if (retainedXvfb) {
      await delay(3_000);
      status = await readDesktopStatus('desktop.session.stop.status.after-xvfb-settle');
      if (status.components.length === 0) {
        buildLog('desktop.session.stop.xvfb.exit.confirmed', 'info', {
          sandboxId: sandbox.sandboxId,
          pid: retainedXvfb.pid,
          settleDelayMs: 3_000,
        });
      } else if (status.components.length === 1 && status.components[0].pid === retainedXvfb.pid && status.components[0].comm === 'Xvfb') {
        const displayCheck = await runBuildGuestCommandApi(
          'desktop.session.stop.xvfb.reuse-check',
          sandbox,
          [
            'set -eu',
            `xvfb_pid=${retainedXvfb.pid}`,
          'if test ! -e "/proc/$xvfb_pid/comm"; then echo desktop.session.stop.xvfb.exited-before-reuse-check pid="$xvfb_pid"; exit 78; fi',
            'current_comm=',
            'IFS= read -r current_comm <"/proc/$xvfb_pid/comm" 2>/dev/null || current_comm=',
            'test "$current_comm" = Xvfb',
            'timeout --kill-after=1s 8s xdpyinfo -display :1 >/dev/null',
            'echo desktop.session.stop.xvfb.reusable pid="$xvfb_pid" display=:1',
          ].join('\n'),
          '/',
          {},
          60_000,
        );
        if (displayCheck.exitCode === 0) {
          buildLog('desktop.session.stop.xvfb.reused', 'warning', {
            sandboxId: sandbox.sandboxId,
            pid: retainedXvfb.pid,
            state: retainedXvfb.state,
            display: ':1',
            output: safeBuildError(displayCheck.output).trim(),
          });
          status = { ...status, components: [] };
        } else if (displayCheck.exitCode === 78 || /No such file or directory|cannot open/i.test(displayCheck.output)) {
          status = await readDesktopStatus('desktop.session.stop.status.after-xvfb-exit');
        } else {
          throw new Error('SIGKILL 后仍存在的 Xvfb 无法确认 :1 显示可用：' + safeBuildError(displayCheck.output).slice(-800));
        }
      }
    }
  }
  if (status.components.length > 0) {
    const specs = status.components.map(({ pid, comm }) => `${pid}:${comm}`).join(' ');
    const diagnosisCommand = [
      'set +e',
      `for component in ${specs}; do`,
      '  component_pid=${component%%:*}',
      '  expected_comm=${component#*:}',
      '  printf "desktop.session.stop.leftover pid=%s expected_comm=%s\\n" "$component_pid" "$expected_comm"',
      '  ps -p "$component_pid" -o pid=,ppid=,pgid=,sid=,uid=,stat=,wchan=,etime=,comm=,args= 2>/dev/null',
      '  if test -r "/proc/$component_pid/status"; then awk -F: \'/^(Name|State|Tgid|Pid|PPid|TracerPid|Uid|Gid|SigQ|SigPnd|ShdPnd|SigBlk|SigIgn|SigCgt):/ { gsub(/^[ \\t]+/, "", $2); printf "desktop.session.stop.proc_status %s=%s\\n", $1, $2 }\' "/proc/$component_pid/status"; fi',
      '  if test -r "/proc/$component_pid/cmdline"; then printf "desktop.session.stop.proc_cmdline "; tr "\\000" " " <"/proc/$component_pid/cmdline"; printf "\\n"; fi',
      '  if test -r "/proc/$component_pid/task/$component_pid/children"; then printf "desktop.session.stop.proc_children "; cat "/proc/$component_pid/task/$component_pid/children"; printf "\\n"; fi',
      'done',
      'desktop_uid="$(id -u "$(getent passwd 1000 | cut -d: -f1)")"',
      'echo desktop.session.stop.wrapper-scan.start',
      'ps -u "$desktop_uid" -o pid=,ppid=,pgid=,sid=,stat=,wchan=,comm=,args= 2>/dev/null | awk \'index($0, "/usr/local/bin/csa-desktop-session") > 0 { print "desktop.session.stop.wrapper-candidate " $0 }\'',
      'echo desktop.session.stop.wrapper-scan.complete',
    ].join('\n');
    let diagnostics = '';
    try {
      const result = await runBuildGuestCommandApi('desktop.session.stop.leftovers.diagnosis', sandbox, diagnosisCommand, '/', {}, 60_000);
      diagnostics = safeBuildError(result.output).trim().slice(-3_000);
    } catch (error) {
      diagnostics = 'diagnostic command failed: ' + safeBuildError(error).slice(-800);
    }
    buildLog('desktop.session.stop.leftovers', 'error', {
      sandboxId: sandbox.sandboxId,
      components: status.components,
      diagnostics,
    });
    throw new Error('桌面会话停止后仍有组件进程：' + status.components.map(item => `${item.pid}:${item.comm}:${item.state}`).join(', ') + (diagnostics ? '；诊断=' + diagnostics : ''));
  }
  await runStopCommand('desktop.session.stop.markers.clear', 'rm -f /run/csa-desktop/session.pid /run/csa-desktop/session.ready; echo desktop_session_stopped_for_runtime_install');
}

async function startDesktopSession(sandbox: Sandbox): Promise<DesktopSessionMonitor> {
  buildLog('desktop.session.start', 'info', {
    sandboxId: sandbox.sandboxId,
    transport: 'persistent-cube-pty',
    resolution: config.agent.desktopResolution,
    readinessTimeoutMs: 10 * 60_000,
  });
  const prepared = await runBuildGuestCommandApi(
    'desktop.session.prepare',
    sandbox,
    [
      'set -eu',
      'desktop_user="$(getent passwd 1000 | cut -d: -f1)"',
      'test -n "$desktop_user"',
      'desktop_gid="$(id -g "$desktop_user")"',
      'chrome_bin="$(command -v chromium || command -v chromium-browser)"',
      'test -x /usr/local/bin/csa-desktop-session',
      'install -d -o "$desktop_user" -g "$desktop_gid" -m 0755 /workspace/.desktop-home /run/csa-desktop',
      ': > /tmp/csa-desktop-session.log; chown "$desktop_user:$desktop_gid" /tmp/csa-desktop-session.log; chmod 0600 /tmp/csa-desktop-session.log',
      'rm -f /run/csa-desktop/session.ready /run/csa-desktop/session.pid',
      'printf "desktop_session.prerequisites user=%s uid=%s gid=%s chrome=%s\\n" "$desktop_user" "$(id -u "$desktop_user")" "$desktop_gid" "$chrome_bin"',
    ].join('\n'),
    '/',
    {},
    60_000,
  );
  const desktopUser = prepared.output.match(/desktop_session\.prerequisites user=([^\s]+)/)?.[1];
  if (prepared.exitCode !== 0 || !desktopUser) {
    throw new Error('Linux 桌面 PTY 前置条件检查失败：' + safeBuildError(prepared.output).slice(-1000));
  }

  const environment = {
    HOME: '/workspace/.desktop-home',
    DISPLAY: ':1',
    CSA_TENANT_ID: 'template-builder',
    CSA_CUBE_SANDBOX_ID: sandbox.sandboxId,
    CSA_COMPUTER_GENERATION: 'template-build',
    CSA_RUN_ID: buildRunId,
    CSA_DESKTOP_CHROME_CDP_TIMEOUT_SECONDS: desktopProbeOnly ? '210' : '360',
    COKE_DESKTOP_RESOLUTION: config.agent.desktopResolution,
    COKE_DESKTOP_CHROME_BIN: '/usr/lib/chromium/chromium',
    COKE_DESKTOP_START_URL: 'about:blank',
    COKE_DESKTOP_SESSION_LOG: '/tmp/csa-desktop-session.log',
    COKE_DESKTOP_LOG_STDOUT: '1',
    CSA_DESKTOP_PROBE_ONLY: desktopProbeOnly ? '1' : '0',
  };
  buildLog('desktop.session.pty.create.start', 'info', {
    sandboxId: sandbox.sandboxId,
    user: desktopUser,
    cwd: environment.HOME,
    timeoutMs: 0,
    envNames: Object.keys(environment).sort(),
  });
  const handle = await withBuildStep(
    'desktop.session.pty.create',
    { sandboxId: sandbox.sandboxId, user: desktopUser, cwd: environment.HOME, timeoutMs: 0 },
    () => sandbox.pty.create({ rows: 24, cols: 100 }, { user: desktopUser, cwd: environment.HOME, envs: environment, timeoutMs: 0 }),
  );
  const monitor: DesktopSessionMonitor = {
    handle,
    state: { status: 'running' },
    desktopReady: false,
    outputBytes: 0,
    outputLines: 0,
    outputTail: '',
    startedAt: Date.now(),
    detached: false,
  };
  const decoder = new TextDecoder();
  let pendingOutput = '';
  const recordOutput = (text: string): void => {
    const sanitized = text
      .replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, '')
      .replace(/\u001b\][^\u0007]*(?:\u0007|\u001b\\)/g, '')
      .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '');
    pendingOutput += sanitized;
    let newline: number;
    while ((newline = pendingOutput.indexOf('\n')) >= 0) {
      const line = pendingOutput.slice(0, newline).replace(/\r$/, '');
      pendingOutput = pendingOutput.slice(newline + 1);
      if (!line.trim()) continue;
      const chromeStarted = line.match(/event=chrome\.started pid=(\d+)/);
      if (chromeStarted) monitor.chromePid = Number(chromeStarted[1]);
      monitor.outputLines += 1;
      monitor.outputTail = (monitor.outputTail + line + '\n').slice(-3200);
      if (line.includes('event=services.ready websockify=6080 chromeCDP=9222')) monitor.desktopReady = true;
      buildLog('desktop.session.pty.output', classifyBuilderOutput(line), {
        sandboxId: sandbox.sandboxId,
        pid: handle.pid,
        chromePid: monitor.chromePid,
        lineSequence: monitor.outputLines,
        line: safeBuildError(line).slice(0, 1800),
      });
    }
  };
  void handle.wait(chunk => {
    monitor.outputBytes += chunk.byteLength;
    recordOutput(decoder.decode(chunk, { stream: true }));
  }).then(exitCode => {
    if (pendingOutput.trim()) recordOutput('\n' + pendingOutput);
    monitor.state = { status: 'exited', exitCode };
    buildLog(monitor.detached ? 'desktop.session.pty.stream.detached' : 'desktop.session.pty.exited', monitor.detached ? 'info' : 'error', {
      sandboxId: sandbox.sandboxId,
      pid: handle.pid,
      exitCode,
      durationMs: Date.now() - monitor.startedAt,
      outputBytes: monitor.outputBytes,
      outputLines: monitor.outputLines,
      outputTail: safeBuildError(monitor.outputTail).slice(-2400),
    });
  }).catch(error => {
    const message = safeBuildError(error);
    monitor.state = { status: 'error', message };
    buildLog(monitor.detached ? 'desktop.session.pty.stream.detached' : 'desktop.session.pty.stream.failed', monitor.detached ? 'info' : 'error', {
      sandboxId: sandbox.sandboxId,
      pid: handle.pid,
      durationMs: Date.now() - monitor.startedAt,
      outputBytes: monitor.outputBytes,
      outputLines: monitor.outputLines,
      outputTail: safeBuildError(monitor.outputTail).slice(-2400),
      error: message,
      errorDetails: safeBuildErrorDetails(error),
    });
  });

  buildLog('desktop.session.pty.create.complete', 'info', { sandboxId: sandbox.sandboxId, pid: handle.pid, user: desktopUser, timeoutMs: 0 });
  try {
    await handle.sendStdin('stty -echo 2>/dev/null || true\n', 15_000);
    buildLog('desktop.session.pty.command.sent', 'info', { sandboxId: sandbox.sandboxId, pid: handle.pid, command: 'stty -echo 2>/dev/null || true' });
    await handle.sendStdin('exec /usr/local/bin/csa-desktop-session\n', 15_000);
    buildLog('desktop.session.pty.command.sent', 'info', { sandboxId: sandbox.sandboxId, pid: handle.pid, command: 'exec /usr/local/bin/csa-desktop-session' });
    buildLog('desktop.session.launch.started', 'info', { sandboxId: sandbox.sandboxId, pid: handle.pid, user: desktopUser, transport: 'persistent-cube-pty' });
    await waitForDesktopServices(Date.now() + 10 * 60_000, monitor);
    buildLog('desktop.session.ready', 'info', { sandboxId: sandbox.sandboxId, pid: handle.pid, durationMs: Date.now() - monitor.startedAt, outputBytes: monitor.outputBytes, outputLines: monitor.outputLines });
    return monitor;
  } catch (error) {
    buildLog('desktop.session.start.failed', 'error', {
      sandboxId: sandbox.sandboxId,
      pid: handle.pid,
      chromePid: monitor.chromePid,
      ptyState: monitor.state,
      durationMs: Date.now() - monitor.startedAt,
      outputBytes: monitor.outputBytes,
      outputLines: monitor.outputLines,
      outputTail: safeBuildError(monitor.outputTail).slice(-2400),
      error: safeBuildError(error),
      errorDetails: safeBuildErrorDetails(error),
    });
    if (monitor.chromePid || monitor.outputTail.includes('event=chrome-cdp.ready.timeout')) {
      await collectDesktopReadinessFailureDiagnostics(sandbox, monitor);
    } else {
      buildLog('desktop.session.failure.diagnostics.skipped', 'info', {
        sandboxId: sandbox.sandboxId,
        ptyPid: handle.pid,
        reason: 'Chromium was not observed starting in this desktop session',
      });
    }
    monitor.detached = true;
    buildLog('desktop.session.start.cleanup.begin', 'info', {
      sandboxId: sandbox.sandboxId,
      pid: handle.pid,
      reason: 'desktop readiness failed; terminating PTY',
    });
    try {
      const killed = await handle.kill();
      buildLog('desktop.session.start.cleanup', killed ? 'info' : 'warning', { sandboxId: sandbox.sandboxId, pid: handle.pid, killed });
    } catch (cleanupError) {
      buildLog('desktop.session.start.cleanup.failed', 'warning', { sandboxId: sandbox.sandboxId, pid: handle.pid, error: safeBuildError(cleanupError) });
    }
    handle.disconnect();
    throw error;
  }
}

async function waitForDesktopServices(serviceDeadline: number, monitor: DesktopSessionMonitor): Promise<void> {
  const serviceStartedAt = Date.now();
  let lastProgress = 0;
  let attempt = 0;
  while (Date.now() < serviceDeadline) {
    attempt += 1;
    if (monitor.desktopReady) {
      buildLog('desktop.services.ready', 'info', {
        ptyPid: monitor.handle.pid,
        ptyState: monitor.state,
        attempt,
        readinessSource: 'pty-event',
        output: safeBuildError(monitor.outputTail).trim().slice(-1200),
      });
      process.stdout.write('Linux desktop ready: noVNC, Chromium, and Python are available.\n');
      return;
    }
    if (monitor.state.status !== 'running') {
      throw new Error('Linux 桌面 PTY 提前退出：pid=' + monitor.handle.pid + '，state=' + JSON.stringify(monitor.state) + '，output=' + safeBuildError(monitor.outputTail).slice(-1800));
    }
    if (Date.now() - lastProgress >= 30_000) {
      const elapsedSeconds = Math.floor((Date.now() - serviceStartedAt) / 1000);
      buildLog('desktop.services.waiting', 'info', {
        ptyPid: monitor.handle.pid,
        attempt,
        elapsedSeconds,
        outputBytes: monitor.outputBytes,
        outputLines: monitor.outputLines,
        ptyOutputTail: safeBuildError(monitor.outputTail, 1800),
      });
      process.stdout.write('Waiting for the guest desktop PTY readiness event (' + elapsedSeconds + 's elapsed).\n');
      lastProgress = Date.now();
    }
    await delay(1_000);
  }
  throw new Error('Linux 桌面服务超过 10 分钟仍未就绪：ptyPid=' + monitor.handle.pid + '，ptyState=' + JSON.stringify(monitor.state) + '，ptyOutput=' + safeBuildError(monitor.outputTail).slice(-1800));
}

async function installRuntime(sandbox: Sandbox, expectedLockHash: string, expectedWheelHash: string, expectedRuntimeKey: string, runId: string): Promise<void> {
  buildLog('runtime.install.reuse-check.start', 'info', {
    sandboxId: sandbox.sandboxId,
    runtimeKey: expectedRuntimeKey.slice(0, 16),
  });
  const [ready, lockHash, wheelHash, runtimeKey, nodeExists, clientExists, bridgeExists, launcherExists] = await Promise.all([
    sandbox.files.exists(runtimeState + '/ready').catch(() => false),
    sandbox.files.read(runtimeState + '/package-lock.sha256').catch(() => ''),
    sandbox.files.read(runtimeState + '/runtime-wheel.sha256').catch(() => ''),
    sandbox.files.read(runtimeState + '/runtime-key.sha256').catch(() => ''),
    sandbox.files.exists(runtimeRoot + '/bin/node').catch(() => false),
    sandbox.files.exists(runtimeRoot + '/dsh-sdk-client/dist/run-task.bundle.mjs').catch(() => false),
    sandbox.files.exists(runtimeRoot + '/chrome-cdp-pipe-bridge.cjs').catch(() => false),
    sandbox.files.exists(runtimeRoot + '/dsh-runtime-launcher.mjs').catch(() => false),
  ]);
  if (ready && lockHash.trim() === expectedLockHash && wheelHash.trim() === expectedWheelHash && runtimeKey.trim() === expectedRuntimeKey && nodeExists && clientExists && bridgeExists && launcherExists) {
    buildLog('runtime.install.reused', 'info', {
      sandboxId: sandbox.sandboxId,
      runtimeKey: expectedRuntimeKey.slice(0, 16),
      packageLockHash: expectedLockHash,
      runtimeWheelHash: expectedWheelHash,
      reason: 'matching runtime and ready markers already exist in the template seed snapshot',
    });
    return;
  }
  const installStartedAt = Date.now();
  const guestOutputTail: string[] = [];
  let guestOutputBytes = 0;
  let guestLineSequence = 0;
  const recordGuestOutput = (line: string, stage: string): void => {
    guestLineSequence += 1;
    guestOutputBytes += Buffer.byteLength(line) + 1;
    guestOutputTail.push(line);
    if (guestOutputTail.length > 16) guestOutputTail.shift();
    buildLog(stage, classifyBuilderOutput(line), {
      sandboxId: sandbox.sandboxId,
      guestLineSequence,
      stepElapsedMs: Date.now() - installStartedAt,
      line: safeBuildError(line).slice(0, 1800),
    });
  };

  buildLog('runtime.install.pty.start', 'info', {
    sandboxId: sandbox.sandboxId,
    runtimeKey: expectedRuntimeKey.slice(0, 16),
    timeoutMs: 30 * 60_000,
    logTransport: 'guest-pty-stream',
  });
  const installerCommand = [
    'set -eu',
    'rm -f ' + runtimeState + '/install.exit ' + runtimeState + '/install.phase',
    'exec bash /tmp/csa-run-dsh-runtime-bootstrap.sh',
  ].join('\n');
  let installerResult: { exitCode: number; output: string };
  try {
    installerResult = await runGuestPty(
      sandbox,
      installerCommand,
      '/',
      { CSA_TENANT_ID: 'template-builder', CSA_RUN_ID: runId },
      line => recordGuestOutput(line, 'runtime.install.guest-output'),
      30 * 60_000,
    );
  } catch (error) {
    const outputTail = safeBuildError(guestOutputTail.join('\n')).slice(-3200);
    buildLog('runtime.install.pty.failed', 'error', {
      sandboxId: sandbox.sandboxId,
      runtimeKey: expectedRuntimeKey.slice(0, 16),
      durationMs: Date.now() - installStartedAt,
      guestOutputBytes,
      guestLineCount: guestLineSequence,
      outputTail,
      error: safeBuildError(error),
      errorDetails: safeBuildErrorDetails(error),
    });
    throw error;
  }
  const installDurationMs = Date.now() - installStartedAt;
  buildLog('runtime.install.pty.complete', installerResult.exitCode === 0 ? 'info' : 'error', {
    sandboxId: sandbox.sandboxId,
    runtimeKey: expectedRuntimeKey.slice(0, 16),
    exitCode: installerResult.exitCode,
    durationMs: installDurationMs,
    guestOutputBytes,
    guestLineCount: guestLineSequence,
    outputTail: safeBuildError(guestOutputTail.join('\n')).slice(-3200),
  });
  if (installerResult.exitCode !== 0) {
    throw new Error('DeepSeek Harness guest 安装器退出码为 ' + installerResult.exitCode + '：' + safeBuildError(guestOutputTail.join('\n')).slice(-1600));
  }

  const verifyCommand = [
    'set -eu',
    'test "$(cat ' + runtimeState + '/install.exit)" = 0',
    'test -s ' + runtimeState + '/ready',
    'test "$(cat ' + runtimeState + '/package-lock.sha256)" = ' + shellQuote(expectedLockHash),
    'test "$(cat ' + runtimeState + '/runtime-wheel.sha256)" = ' + shellQuote(expectedWheelHash),
    'test "$(cat ' + runtimeState + '/runtime-key.sha256)" = ' + shellQuote(expectedRuntimeKey),
    'test -x ' + runtimeRoot + '/bin/node',
    'test -s ' + runtimeRoot + '/dsh-sdk-client/dist/run-task.bundle.mjs',
    'test -s ' + runtimeRoot + '/dsh-sdk-client/package.json',
    'test -s ' + runtimeRoot + '/chrome-cdp-pipe-bridge.cjs',
    'test -s ' + runtimeRoot + '/dsh-runtime-launcher.mjs',
    'test -x ' + runtimeRoot + '/dsh-runtime-bin/runtime/deepseek-harness-sdk-runtime-linux-arm64',
    'test -x ' + runtimeRoot + '/dsh-runtime-bin/runtime/deepseek-harness-sdk-runtime-linux-arm64-rg',
    'test -s ' + runtimeRoot + '/dsh-runtime-bin/runtime/linux-arm64/downloads.json',
    'echo template_dsh_runtime_markers_verified',
  ].join('\n');
  const verification = await runGuestPty(
    sandbox,
    verifyCommand,
    '/',
    { CSA_TENANT_ID: 'template-builder', CSA_RUN_ID: runId },
    line => recordGuestOutput(line, 'runtime.install.verify-output'),
    60_000,
  );
  buildLog('runtime.install.verified', verification.exitCode === 0 ? 'info' : 'error', {
    sandboxId: sandbox.sandboxId,
    runtimeKey: expectedRuntimeKey.slice(0, 16),
    exitCode: verification.exitCode,
    totalDurationMs: Date.now() - installStartedAt,
    guestOutputBytes,
    guestLineCount: guestLineSequence,
    verificationOutputTail: safeBuildError(verification.output).trim().slice(-1600),
  });
  if (verification.exitCode !== 0) {
    throw new Error('DeepSeek Harness 安装器退出码为 0，但模板内 runtime ready 标记、校验和或文件验收失败：' + verification.output.trim().slice(-1200));
  }
}

async function installPiRuntime(
  sandbox: Sandbox,
  bundle: RuntimeBundle,
  expectedRuntimeKey: string,
  expectedVersion: string,
  runId: string,
): Promise<void> {
  const startedAt = Date.now();
  const runtimeDirectory = runtimeRoot + '/pi-' + expectedRuntimeKey.slice(0, 16);
  const packageManifestPath = runtimeDirectory + '/node_modules/@mariozechner/pi-coding-agent/package.json';
  const readyPath = runtimeState + '/pi-runtime-key.sha256';

  const existing = await sandbox.files.read(readyPath).catch(() => '');
  if (existing.trim() === expectedRuntimeKey
    && await sandbox.files.exists(runtimeDirectory + '/run-task.mjs')
    && await sandbox.files.exists(packageManifestPath)) {
    buildLog('pi-runtime.install.reused', 'info', {
      sandboxId: sandbox.sandboxId,
      runtimeKey: expectedRuntimeKey.slice(0, 16),
      version: expectedVersion,
    });
    return;
  }

  const installCommand = [
    'set -eu',
    'pi_install_started=$(date +%s)',
    'echo pi.install.preflight.start runtime_key=' + expectedRuntimeKey.slice(0, 16),
    'test -x ' + runtimeRoot + '/bin/node',
    'test -s /tmp/csa-dsh-runtime-linux-arm64.tar.gz',
    'install -d -m 0755 ' + runtimeDirectory,
    'echo pi.extract.start archive_bytes=' + bundle.size + ' runtime_directory=' + runtimeDirectory,
    'timeout --kill-after=20s 1200s tar --warning=no-unknown-keyword --checkpoint=1000 --checkpoint-action=echo=pi.extract.checkpoint:block=%u -xzf /tmp/csa-dsh-runtime-linux-arm64.tar.gz -C ' + runtimeDirectory,
    'echo pi.extract.complete elapsed_seconds="$(($(date +%s) - pi_install_started))"',
    'echo pi.install.files.verify.start',
    'test -s ' + runtimeDirectory + '/run-task.mjs',
    'test -s ' + runtimeDirectory + '/package-lock.json',
    'test -s ' + packageManifestPath,
    'test "$(' + runtimeRoot + '/bin/node -p ' + shellQuote('require(process.argv[1]).version') + ' ' + packageManifestPath + ')" = ' + shellQuote(expectedVersion),
    'test -r ' + runtimeDirectory + '/run-task.mjs',
    'test -r ' + packageManifestPath,
    'echo pi.install.files.verify.passed package_version=' + expectedVersion,
  ].join('\n');

  buildLog('pi-runtime.install.extract.start', 'info', {
    sandboxId: sandbox.sandboxId,
    runtimeKey: expectedRuntimeKey.slice(0, 16),
    runtimeDirectory,
    archiveBytes: bundle.size,
    archiveSha256: bundle.archiveSha256,
    timeoutMs: 20 * 60_000,
    progress: 'GNU tar checkpoint every 10000 blocks',
  });
  const installed = await runBuildGuestCommand(
    'pi-runtime.install.extract',
    sandbox,
    installCommand,
    '/',
    { CSA_TENANT_ID: 'template-builder', CSA_RUN_ID: runId },
    20 * 60_000,
  );
  if (installed.exitCode !== 0) {
    throw new Error('Pi SDK 在模板 microVM 中解包或文件校验失败：' + safeBuildError(installed.output).slice(-1600));
  }

  const desktopUserSmoke = [
    'set -eu',
    'echo pi.import-smoke.desktop-user.start',
    'desktop_user="$(getent passwd 1000 | cut -d: -f1)"',
    'test -n "$desktop_user"',
    'desktop_uid="$(id -u "$desktop_user")"',
    'desktop_gid="$(id -g "$desktop_user")"',
    'setpriv --reuid="$desktop_uid" --regid="$desktop_gid" --init-groups -- env CSA_PI_BUNDLE_IMPORT_SMOKE=1 HOME=/workspace/.desktop-home ' + runtimeRoot + '/bin/node ' + runtimeDirectory + '/run-task.mjs',
    'echo pi.import-smoke.desktop-user.passed',
    'printf "%s\\n" ' + shellQuote(expectedRuntimeKey) + ' > ' + readyPath + '.tmp',
    'mv ' + readyPath + '.tmp ' + readyPath,
    'rm -f /tmp/csa-dsh-runtime-linux-arm64.tar.gz /tmp/csa-dsh-runtime-linux-arm64.tar.gz.sha256',
    'echo pi.install.complete runtime_key=' + expectedRuntimeKey.slice(0, 16),
  ].join('\n');
  buildLog('pi-runtime.install.import-smoke.start', 'info', {
    sandboxId: sandbox.sandboxId,
    runtimeKey: expectedRuntimeKey.slice(0, 16),
    version: expectedVersion,
    timeoutMs: 10 * 60_000,
    identity: 'desktop user uid 1000',
    modelCall: false,
  });
  const smoke = await runBuildGuestCommand(
    'pi-runtime.install.import-smoke',
    sandbox,
    desktopUserSmoke,
    '/',
    { CSA_TENANT_ID: 'template-builder', CSA_RUN_ID: runId },
    10 * 60_000,
  );
  if (smoke.exitCode !== 0 || !smoke.output.includes('pi_sdk_import_smoke_ok')) {
    throw new Error('Pi SDK 在模板 microVM 桌面用户下的导入检查失败：' + safeBuildError(smoke.output).slice(-1600));
  }
  buildLog('pi-runtime.install.verified', 'info', {
    sandboxId: sandbox.sandboxId,
    runtimeKey: expectedRuntimeKey.slice(0, 16),
    version: expectedVersion,
    durationMs: Date.now() - startedAt,
    archiveBytes: bundle.size,
    extractOutputBytes: Buffer.byteLength(installed.output),
    extractLineCount: installed.output.split('\n').filter(Boolean).length,
    extractOutputTail: safeBuildError(installed.output).trim().slice(-1600),
    importSmokeOutput: safeBuildError(smoke.output).trim().slice(-1000),
  });
}

async function guestFileExists(sandbox: Sandbox, path: string, deadline: number): Promise<boolean> {
  let lastError: unknown;
  while (Date.now() < deadline) {
    await checkSandboxLifecycle(sandbox, `checking guest path ${path}`);
    try {
      const exists = await sandbox.files.exists(path);
      noteSandboxDataPlaneSuccess(sandbox);
      return exists;
    } catch (error) {
      if (!isRetryableDataPlaneError(error)) throw error;
      lastError = error;
      noteSandboxDataPlaneFailure(sandbox, `checking guest path ${path}`, error);
      buildLog('sandbox.data-plane.retry', 'warning', {
        sandboxId: sandbox.sandboxId,
        stage: 'guest-file-exists',
        path,
        error: safeBuildError(error),
        errorDetails: safeBuildErrorDetails(error),
      });
      process.stdout.write('Cube data plane is temporarily unavailable; retrying the readiness check.\n');
      await delay(5_000);
    }
  }
  if (lastError instanceof Error) throw lastError;
  return false;
}

async function guestFileRead(sandbox: Sandbox, path: string, deadline: number): Promise<string> {
  let lastError: unknown;
  while (Date.now() < deadline) {
    await checkSandboxLifecycle(sandbox, `reading guest path ${path}`);
    try {
      const contents = await sandbox.files.read(path);
      noteSandboxDataPlaneSuccess(sandbox);
      return contents;
    } catch (error) {
      if (!isRetryableDataPlaneError(error)) throw error;
      lastError = error;
      noteSandboxDataPlaneFailure(sandbox, `reading guest path ${path}`, error);
      buildLog('sandbox.data-plane.retry', 'warning', {
        sandboxId: sandbox.sandboxId,
        stage: 'guest-file-read',
        path,
        error: safeBuildError(error),
        errorDetails: safeBuildErrorDetails(error),
      });
      await delay(5_000);
    }
  }
  if (lastError instanceof Error) throw lastError;
  throw new Error('读取构建 VM 文件超时：' + path);
}

function isRetryableDataPlaneError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /\b50[234]\b|Gateway Time-out|Bad Gateway|fetch failed|ECONNRESET|ECONNREFUSED|ETIMEDOUT|EHOSTUNREACH|deadline_exceeded|context deadline exceeded/i.test(message);
}

async function retryDataPlane<T>(label: string, deadline: number, operation: () => Promise<T>, sandbox?: Sandbox): Promise<T> {
  let lastError: unknown;
  while (Date.now() < deadline) {
    if (sandbox) await checkSandboxLifecycle(sandbox, label);
    try {
      const result = await operation();
      if (sandbox) noteSandboxDataPlaneSuccess(sandbox);
      return result;
    } catch (error) {
      if (!isRetryableDataPlaneError(error)) throw error;
      lastError = error;
      if (sandbox) {
        noteSandboxDataPlaneFailure(sandbox, label, error);
        buildLog('sandbox.data-plane.retry', 'warning', {
          sandboxId: sandbox.sandboxId,
          stage: label,
          error: safeBuildError(error),
          errorDetails: safeBuildErrorDetails(error),
        });
      }
      process.stdout.write('Cube data plane temporarily unavailable while ' + label + '; retrying.\n');
      await delay(5_000);
    }
  }
  if (lastError instanceof Error) throw lastError;
  throw new Error('Cube data plane timed out while ' + label + '.');
}

function shellQuote(value: string): string {
  return "'" + value.replaceAll("'", "'\\''") + "'";
}

function delay(milliseconds: number): Promise<void> {
  return new Promise(resolveDelay => setTimeout(resolveDelay, milliseconds));
}
