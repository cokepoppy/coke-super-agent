const maxCommandLength = 64 * 1024;
const maxOutputLength = 48 * 1024;
const minimumTimeoutMs = 60_000;
const bridgeResponseGraceMs = 60_000;

export const name = 'coke-super-agent-remote-terminal';
export const inject = ['tools'];

function bridgeConfiguration() {
  const rawUrl = process.env.COKE_CUBE_TERMINAL_BRIDGE_URL || '';
  const token = process.env.COKE_CUBE_TERMINAL_BRIDGE_TOKEN || '';
  let url;
  try { url = new URL(rawUrl); } catch { throw new Error('Cube remote terminal bridge URL is invalid.'); }
  if (url.protocol !== 'http:' || url.hostname !== 'host.docker.internal' || url.username || url.password
    || url.pathname !== '/api/internal/agent/terminal' || url.search || url.hash
    || !/^[A-Za-z0-9_.-]{40,2048}$/.test(token)) {
    throw new Error('Cube remote terminal bridge is not configured for this tenant task.');
  }
  return { url: url.href, token };
}

function log(stage, details = {}, level = 'info') {
  process.stderr.write(`${JSON.stringify({
    timestamp: new Date().toISOString(),
    logger: 'coke-super-agent.computer-tool',
    component: 'computer-tool',
    stage,
    level,
    tenantId: process.env.CSA_TENANT_ID || undefined,
    runId: process.env.CSA_RUN_ID || undefined,
    details,
  })}\n`);
}

async function boundedJson(response) {
  const length = Number(response.headers.get('content-length'));
  if (Number.isFinite(length) && length > maxOutputLength * 2 + 32 * 1024) throw new Error('Cube terminal output exceeded the response limit.');
  const text = await response.text();
  if (Buffer.byteLength(text, 'utf8') > maxOutputLength * 2 + 32 * 1024) throw new Error('Cube terminal output exceeded the response limit.');
  let value;
  try { value = JSON.parse(text); } catch { throw new Error('Cube remote terminal returned an invalid response.'); }
  if (!response.ok) {
    const code = typeof value?.code === 'string' ? value.code : 'CUBE_TERMINAL_FAILED';
    const message = typeof value?.error === 'string' ? value.error : 'Cube remote terminal request failed.';
    throw new Error(`${code}: ${message.slice(0, 300)}`);
  }
  return value;
}

export function apply(ctx) {
  const bridge = bridgeConfiguration();
  const workspace = process.env.COKE_CUBE_TASK_WORKSPACE || '/workspace';
  const workspaceAliases = [process.env.COKE_DSH_TASK_WORKSPACE, process.env.COKE_DSH_LEGACY_TASK_WORKSPACE]
    .filter(value => typeof value === 'string' && value.startsWith('/'))
    .sort((left, right) => right.length - left.length);
  const mapWorkingDirectory = value => {
    const candidate = typeof value === 'string' && value.trim() ? value : workspace;
    for (const alias of workspaceAliases) {
      if (candidate === alias) return workspace;
      if (candidate.startsWith(`${alias}/`)) return `${workspace}${candidate.slice(alias.length)}`;
    }
    return candidate;
  };
  ctx.tools.register({
    name: 'computer_terminal',
    description: 'Run a Bash command as root inside this task’s isolated Cube microVM. The Docker Agent container has no local Bash tool; this command runs only in the tenant microVM and can use its apt, Python, Node, files, and network. Commands required by the task run directly without per-command approval. The default working directory is the current task folder. Shell commands are task actions; inspect outputs before repeating a command whose outcome is unclear.',
    parameters: {
      type: 'object',
      properties: {
        command: { type: 'string', minLength: 1, maxLength: maxCommandLength },
        cwd: { type: 'string', maxLength: 4096 },
        timeoutMs: { type: 'integer', minimum: minimumTimeoutMs, maximum: 900000 },
      },
      required: ['command'],
      additionalProperties: false,
    },
    output: {
      schema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'], additionalProperties: false },
      render: (_args, value) => [{ type: 'text', text: value.text }],
    },
    async execute(args, execution) {
      if (execution.signal?.aborted) throw execution.signal.reason || new Error('Task stopped.');
      if (typeof args.command !== 'string' || !args.command.trim() || args.command.length > maxCommandLength || args.command.includes('\0')) {
        throw new Error('Remote Bash command is invalid.');
      }
      const timeoutMs = Number.isSafeInteger(args.timeoutMs) ? Math.max(minimumTimeoutMs, Math.min(900000, args.timeoutMs)) : 300000;
      const requestedCwd = typeof args.cwd === 'string' && args.cwd.trim() ? args.cwd : workspace;
      if (!requestedCwd.startsWith('/') || requestedCwd.includes('\0') || requestedCwd.length > 4096) {
        throw new Error('Remote Bash working directory must be an absolute path inside the tenant microVM.');
      }
      const cwd = mapWorkingDirectory(requestedCwd);
      const startedAt = Date.now();
      log('remote-terminal.start', { commandBytes: Buffer.byteLength(args.command, 'utf8'), cwd, timeoutMs });
      try {
        const bridgeTimeoutMs = timeoutMs + bridgeResponseGraceMs;
        const timeoutSignal = AbortSignal.timeout(bridgeTimeoutMs);
        const signal = execution.signal ? AbortSignal.any([execution.signal, timeoutSignal]) : timeoutSignal;
        const response = await fetch(bridge.url, {
          method: 'POST',
          redirect: 'error',
          headers: {
            authorization: `Bearer ${bridge.token}`,
            'content-type': 'application/json',
            'accept': 'application/json',
          },
          body: JSON.stringify({ command: args.command, cwd, timeoutMs }),
          signal,
        });
        const result = await boundedJson(response);
        if (!Number.isSafeInteger(result.exitCode) || typeof result.stdout !== 'string' || typeof result.stderr !== 'string') {
          throw new Error('Cube remote terminal response fields are invalid.');
        }
        const stdout = result.stdout.slice(0, maxOutputLength);
        const stderr = result.stderr.slice(0, maxOutputLength);
        const rendered = JSON.stringify({
          exitCode: result.exitCode,
          durationMs: Number.isSafeInteger(result.durationMs) ? result.durationMs : Date.now() - startedAt,
          stdout,
          stderr,
          outputTruncated: result.outputTruncated === true || stdout.length !== result.stdout.length || stderr.length !== result.stderr.length,
          executionLocation: 'tenant-cube-microvm',
        });
        log('remote-terminal.complete', { exitCode: result.exitCode, durationMs: Date.now() - startedAt, stdoutBytes: Buffer.byteLength(stdout), stderrBytes: Buffer.byteLength(stderr) }, result.exitCode === 0 ? 'info' : 'warning');
        return { text: rendered };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        log('remote-terminal.failed', { durationMs: Date.now() - startedAt, errorName: error instanceof Error ? error.name : 'Error', errorMessage: message.slice(0, 300) }, 'error');
        throw error;
      }
    },
  });
}
