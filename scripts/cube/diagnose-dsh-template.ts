import 'dotenv/config';
import { randomUUID } from 'node:crypto';
import { appendFileSync } from 'node:fs';
import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { Config, NEVER_TIMEOUT, Sandbox } from '@cubesandbox/sdk';
import { runGuestPty } from '../../src/server/runtime-bundle.ts';

const templateId = process.env.CSA_AGENT_DIAGNOSTIC_TEMPLATE_ID || '';
const apiUrl = process.env.CUBE_API_URL || '';
const apiKey = process.env.CUBE_API_KEY || undefined;
const modelApiKey = process.env.DEEPSEEK_API_KEY || '';
const model = process.env.DSH_MODEL || '';
const baseUrl = (process.env.DEEPSEEK_BASE_URL || 'https://api.deepseek.com/anthropic').trim().replace(/\/+$/, '');
const apiHost = apiUrl ? new URL(apiUrl).hostname : '';
const localCubeApi = ['127.0.0.1', 'localhost', '::1'].includes(apiHost);
const proxyNodeIp = process.env.CUBE_PROXY_NODE_IP || (localCubeApi ? '127.0.0.1' : undefined);
const proxyPort = Number(process.env.CUBE_PROXY_PORT_HTTP || (localCubeApi ? '28080' : '80'));
const sandboxDomain = process.env.CUBE_SANDBOX_DOMAIN || 'cube.app';
const runId = randomUUID();
const threadId = randomUUID();
const startedAt = Date.now();
const logDirectory = process.env.CSA_BUILD_LOG_DIR || join(homedir(), '.local/share/csa-cube-node/build-logs');
const logPath = join(logDirectory, `dsh-template-${new Date().toISOString().replace(/[:.]/g, '-')}-${runId}.jsonl`);
const taskPrompt = 'Reply with exactly CSA_DSH_CUBE_E2E_OK and no other text. Do not use any tools.';

await mkdir(logDirectory, { recursive: true, mode: 0o700 });
await writeFile(logPath, '', { mode: 0o600 });
await chmod(logPath, 0o600);

function redact(value: unknown): string {
  let text = String(value ?? '');
  if (modelApiKey) text = text.split(modelApiKey).join('[REDACTED]');
  return text
    .replace(/(https?:\/\/)[^/@\s]+:[^/@\s]+@/gi, '$1[redacted]@')
    .replace(/([?&](?:token|key|password|secret)=)[^&\s]+/gi, '$1[redacted]')
    .replace(/\b(Bearer|Basic)\s+[^\s"'`]+/gi, '$1 [REDACTED]')
    .replace(/\bsk-[A-Za-z0-9_-]{12,}\b/g, '[REDACTED]');
}

function log(stage: string, fields: Record<string, unknown> = {}): void {
  const row = JSON.stringify({ timestamp: new Date().toISOString(), runId, elapsedMs: Date.now() - startedAt, stage, ...fields });
  process.stdout.write(row + '\n');
  appendFileSync(logPath, row + '\n', { mode: 0o600 });
}

if (!/^tpl-[a-z0-9]+$/.test(templateId)) throw new Error('Set CSA_AGENT_DIAGNOSTIC_TEMPLATE_ID to the READY prebuilt desktop template.');
if (!apiUrl || !modelApiKey || !model) throw new Error('Cube API and DeepSeek model configuration must be present in the external environment file.');
if (!/^https:\/\//i.test(baseUrl) || !Number.isSafeInteger(proxyPort) || proxyPort < 1 || proxyPort > 65535) {
  throw new Error('DeepSeek endpoint or Cube proxy configuration is invalid.');
}

const config = new Config({
  apiUrl,
  apiKey,
  proxyNodeIp,
  proxyPort,
  proxyScheme: process.env.CUBE_PROXY_SCHEME || 'http',
  sandboxDomain,
  requestTimeoutMs: 30_000,
});
let sandbox: Sandbox | undefined;

try {
  log('sandbox.create.start', {
    templateId,
    disposable: true,
    internetAccess: true,
    publicTraffic: false,
    model,
    endpointHost: new URL(baseUrl).host,
    apiKeyConfigured: true,
  });
  sandbox = await Sandbox.create({
    config,
    template: templateId,
    timeout: NEVER_TIMEOUT,
    allowInternetAccess: true,
    network: { allowPublicTraffic: false, allowOut: ['0.0.0.0/0'] },
    extra: { restartPolicy: 'Never' },
    metadata: { csa_dsh_template_diagnostic: 'true', csa_diagnostic_run: runId },
  });
  log('sandbox.create.complete', { sandboxId: sandbox.sandboxId, templateId: sandbox.templateId });

  const envdDeadline = Date.now() + 120_000;
  let envdReady = false;
  while (Date.now() < envdDeadline) {
    try {
      const probe = await sandbox.commands.run('printf "csa_dsh_envd_ready\\n"', { timeoutMs: 10_000 });
      if (probe.exitCode === 0 && `${probe.stdout || ''}${probe.stderr || ''}`.includes('csa_dsh_envd_ready')) {
        envdReady = true;
        log('guest.envd.ready', { sandboxId: sandbox.sandboxId, elapsedMs: Date.now() - startedAt });
        break;
      }
      log('guest.envd.probe', { sandboxId: sandbox.sandboxId, exitCode: probe.exitCode, outputTail: redact(`${probe.stdout || ''}${probe.stderr || ''}`).slice(-300) });
    } catch (error) {
      log('guest.envd.probe.retry', { sandboxId: sandbox.sandboxId, error: redact(error instanceof Error ? error.message : error).slice(0, 500) });
    }
    await new Promise(resolve => setTimeout(resolve, 3_000));
  }
  if (!envdReady) throw new Error('The diagnostic microVM envd did not become ready within two minutes.');

  const manifestText = String(await sandbox.files.read('/etc/csa-super-agent/desktop-image.json'));
  const manifest = JSON.parse(manifestText) as { dsh?: { runtimeKey?: string; version?: string } };
  const runtimeKey = manifest.dsh?.runtimeKey || '';
  if (!/^[a-f0-9]{64}$/.test(runtimeKey)) throw new Error('The image manifest does not contain a valid DSH runtime key.');
  const runtimeEntry = '/opt/csa-agent-runtime/dsh-sdk-client/dist/run-task.bundle.mjs';
  const preflight = await sandbox.commands.run(
    `set -eu; test -x /opt/csa-agent-runtime/bin/node; test -s '${runtimeEntry}'; test -x /opt/csa-agent-runtime/dsh-runtime-bin/runtime/deepseek-harness-sdk-runtime-linux-arm64; test "$(cat /var/lib/csa-agent-runtime/runtime-key.sha256)" = '${runtimeKey}'; test "$(cat /var/lib/csa-agent-runtime/runtime-key.expected.sha256)" = '${runtimeKey}'; printf 'dsh_preinstalled version=%s runtime_key=%s node=%s\\n' '${manifest.dsh?.version || 'unknown'}' '${runtimeKey.slice(0, 16)}' "$(/opt/csa-agent-runtime/bin/node --version)"`,
    { timeoutMs: 15_000 },
  );
  const preflightOutput = redact(`${preflight.stdout || ''}${preflight.stderr || ''}`).trim();
  log('guest.dsh.preflight', { sandboxId: sandbox.sandboxId, exitCode: preflight.exitCode, output: preflightOutput.slice(-600) });
  if (preflight.exitCode !== 0 || !preflightOutput.includes('dsh_preinstalled')) throw new Error('Pinned DSH runtime preflight did not pass.');

  // The product control plane injects the shared Computer plugin immediately
  // before launching the preinstalled DSH bundle. Mirror that step here.
  const computerPlugin = await readFile(new URL('./dsh-runtime/computer-plugin.mjs', import.meta.url), 'utf8');
  await sandbox.files.write('/opt/csa-agent-runtime/computer-plugin.mjs', computerPlugin);
  log('guest.dsh.computer-plugin.staged', {
    sandboxId: sandbox.sandboxId,
    bytes: Buffer.byteLength(computerPlugin),
    source: 'product-shared-computer-plugin',
  });

  const runDirectory = `/workspace/.csa-super-agent/runs/${runId}`;
  const taskDirectory = `/workspace/tasks/${threadId}`;
  await sandbox.commands.run(`set -eu; install -d -o 1000 -g 1000 -m 0700 '${runDirectory}' '${taskDirectory}'`, { timeoutMs: 10_000 });
  await sandbox.files.write(`${runDirectory}/input.json`, JSON.stringify({ threadId, prompt: taskPrompt, baseUrl, model }));
  await sandbox.commands.run(`chown 1000:1000 '${runDirectory}/input.json'; chmod 0600 '${runDirectory}/input.json'`, { timeoutMs: 10_000 });
  log('guest.dsh.task.start', {
    sandboxId: sandbox.sandboxId,
    threadId,
    runId,
    prompt: taskPrompt,
    runtimeVersion: manifest.dsh?.version || 'unknown',
    permissionMode: 'danger-full-access',
  });
  const taskStartedAt = Date.now();
  const result = await runGuestPty(
    sandbox,
    `/usr/bin/setpriv --reuid=1000 --regid="$(/usr/bin/id -g "$(/usr/bin/getent passwd 1000 | /usr/bin/cut -d: -f1)")" --init-groups /opt/csa-agent-runtime/bin/node '${runtimeEntry}' '${runId}'`,
    taskDirectory,
    {
      HOME: '/workspace/.desktop-home',
      DISPLAY: ':1',
      PATH: '/opt/csa-agent-runtime/bin:/opt/csa-agent-runtime:/usr/local/bin:/usr/bin:/bin',
      CSA_TENANT_ID: 'diagnostic-disposable',
      CSA_RUN_ID: runId,
      DEEPSEEK_API_KEY: modelApiKey,
      DSH_PERMISSION_MODE: 'danger-full-access',
      COKE_DESKTOP_RESOLUTION: process.env.CSA_DESKTOP_RESOLUTION || '1280x800',
      COKE_AGENT_HANDOFF_FILE: `${runDirectory}/handoff.json`,
    },
    line => {
      if (line.trim()) log('guest.dsh.task.output', { line: redact(line).slice(0, 1_800), taskElapsedMs: Date.now() - taskStartedAt });
    },
    8 * 60_000,
  );
  const stateText = await sandbox.files.read(`${runDirectory}/state.json`).catch(() => '');
  const state = stateText ? JSON.parse(String(stateText)) as { status?: string; stage?: string; message?: string; finalResponse?: string; traces?: Array<Record<string, unknown>> } : undefined;
  const responseText = String(state?.finalResponse || '');
  const responseArtifact = await sandbox.files.read(`${taskDirectory}/agent-response.md`).catch(() => '');
  const traceDetailKeys = new Set([
    'durationMs', 'elapsedMs', 'timeoutMs', 'stepCount', 'toolCallCount', 'toolResultCount',
    'provider', 'model', 'profile', 'finishReason', 'responseCharacters', 'firstTokenElapsedMs',
    'notificationCount', 'returnedNotificationCount', 'eventsCount', 'eventTypeCounts', 'status',
  ]);
  const traceTimeline = (state?.traces || []).map(entry => {
    const details = entry.details && typeof entry.details === 'object' ? entry.details as Record<string, unknown> : {};
    const safeDetails = Object.fromEntries(Object.entries(details).filter(([key, value]) => traceDetailKeys.has(key)
      && (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'string'))
      .map(([key, value]) => [key, typeof value === 'string' ? redact(value).slice(0, 220) : value]));
    return {
      sequence: entry.sequence,
      component: entry.component,
      stage: entry.stage,
      level: entry.level,
      message: redact(entry.message).slice(0, 240),
      ...(Object.keys(safeDetails).length ? { details: safeDetails } : {}),
    };
  });
  log('guest.dsh.task.complete', {
    sandboxId: sandbox.sandboxId,
    exitCode: result.exitCode,
    taskDurationMs: Date.now() - taskStartedAt,
    outputTail: redact(result.output).slice(-2_500),
    guestState: state ? {
      status: state.status,
      stage: state.stage,
      message: redact(state.message).slice(0, 600),
      finalResponse: redact(responseText).slice(0, 600),
      traceCount: state.traces?.length || 0,
    } : 'missing',
    traceTimeline,
    responseArtifactPresent: Boolean(String(responseArtifact).trim()),
  });
  if (result.exitCode !== 0 || state?.status !== 'done' || !responseText.includes('CSA_DSH_CUBE_E2E_OK') || !String(responseArtifact).includes('CSA_DSH_CUBE_E2E_OK')) {
    throw new Error('DSH did not complete and persist the bounded text-only task in the disposable microVM.');
  }
  log('diagnostic.complete', {
    sandboxId: sandbox.sandboxId,
    templateId,
    dshRuntime: manifest.dsh?.version || 'unknown',
    model,
    desktopRequired: false,
    taskStatus: state.status,
    traceCount: state.traces?.length || 0,
  });
} catch (error) {
  log('diagnostic.failed', { sandboxId: sandbox?.sandboxId || 'not-created', error: redact(error instanceof Error ? error.message : error).slice(0, 1_500) });
  process.exitCode = 1;
} finally {
  if (sandbox) {
    try {
      log('sandbox.cleanup.start', { sandboxId: sandbox.sandboxId });
      await sandbox.kill();
      log('sandbox.cleanup.complete', { sandboxId: sandbox.sandboxId });
    } catch (error) {
      log('sandbox.cleanup.failed', { sandboxId: sandbox.sandboxId, error: redact(error instanceof Error ? error.message : error).slice(0, 800) });
      process.exitCode = 1;
    }
    sandbox.close();
  }
  log('diagnostic.log', { path: logPath });
}
