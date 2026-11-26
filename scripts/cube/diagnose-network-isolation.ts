import 'dotenv/config';
import { appendFileSync, mkdirSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { homedir } from 'node:os';
import { isIPv4 } from 'node:net';
import { join } from 'node:path';
import { Config, Sandbox } from '@cubesandbox/sdk';

const apiUrl = process.env.CUBE_API_URL || '';
const templateId = process.env.CSA_NETWORK_DIAGNOSTIC_TEMPLATE_ID || '';
const nodeIp = process.env.CSA_NETWORK_DIAGNOSTIC_NODE_IP || '';
const nodePort = Number(process.env.CSA_NETWORK_DIAGNOSTIC_NODE_PORT || '22');
if (!apiUrl || !templateId || !isIPv4(nodeIp) || !Number.isSafeInteger(nodePort) || nodePort < 1 || nodePort > 65535) {
  throw new Error('Set the Cube API URL, diagnostic template ID, node IPv4 address, and valid node port.');
}

const apiHost = new URL(apiUrl).hostname;
const localApi = ['127.0.0.1', 'localhost', '::1'].includes(apiHost);
const cube = new Config({
  apiUrl,
  apiKey: process.env.CUBE_API_KEY || undefined,
  proxyNodeIp: process.env.CUBE_PROXY_NODE_IP || (localApi ? '127.0.0.1' : undefined),
  proxyPort: Number(process.env.CUBE_PROXY_PORT_HTTP || (localApi ? '28080' : '80')),
  proxyScheme: process.env.CUBE_PROXY_SCHEME || 'http',
  sandboxDomain: process.env.CUBE_SANDBOX_DOMAIN || 'cube.app',
  requestTimeoutMs: 30_000,
});
const runId = randomUUID();
const startedAt = Date.now();
const logDirectory = process.env.CSA_BUILD_LOG_DIR || join(homedir(), '.local/share/csa-cube-node/build-logs');
mkdirSync(logDirectory, { recursive: true, mode: 0o700 });
const logPath = join(logDirectory, `network-isolation-${new Date().toISOString().replace(/[:.]/g, '-')}-${runId}.jsonl`);
function log(stage: string, details: Record<string, string | number | boolean> = {}): void {
  const line = JSON.stringify({ timestamp: new Date().toISOString(), runId, elapsedMs: Date.now() - startedAt, stage, ...details }) + '\n';
  process.stdout.write(line);
  appendFileSync(logPath, line, { mode: 0o600 });
}

async function probe(sandbox: Sandbox, stage: string): Promise<{ privateConnected: boolean; publicConnected: boolean }> {
  const command = `python3 - '${nodeIp}' '${nodePort}' <<'PY'
import json, socket, sys
targets = [('private', sys.argv[1], int(sys.argv[2])), ('public', 'api.deepseek.com', 443)]
results = {}
for name, host, port in targets:
    try:
        with socket.create_connection((host, port), timeout=4):
            results[name] = {'connected': True}
    except OSError as error:
        results[name] = {'connected': False, 'error': type(error).__name__}
print(json.dumps(results), flush=True)
PY`;
  const result = await sandbox.commands.run(command, { timeoutMs: 20_000 });
  if (result.exitCode !== 0) throw new Error(`Network probe ${stage} exited ${result.exitCode}.`);
  const parsed = JSON.parse(result.stdout) as { private?: { connected?: unknown }; public?: { connected?: unknown } };
  if (typeof parsed.private?.connected !== 'boolean' || typeof parsed.public?.connected !== 'boolean') {
    throw new Error(`Network probe ${stage} returned invalid data.`);
  }
  const observation = { privateConnected: parsed.private.connected, publicConnected: parsed.public.connected };
  log(stage, observation);
  return observation;
}

let sandbox: Sandbox | undefined;
try {
  log('sandbox.create.start', { templateId });
  sandbox = await Sandbox.create({
    config: cube,
    template: templateId,
    timeout: 300,
    allowInternetAccess: true,
    network: { allowPublicTraffic: false, allowOut: ['0.0.0.0/0'] },
    extra: { restartPolicy: 'Never' },
    metadata: { csa_network_diagnostic: runId },
  });
  log('sandbox.create.complete', { sandboxId: sandbox.sandboxId });
  const wildcard = await probe(sandbox, 'wildcard.probe');
  log('policy.update.start', { sandboxId: sandbox.sandboxId });
  await sandbox.updateNetwork({ allowInternetAccess: true, allowOut: [] });
  await new Promise(resolve => setTimeout(resolve, 2_000));
  const standard = await probe(sandbox, 'default.probe');
  if (!wildcard.privateConnected || !wildcard.publicConnected) {
    throw new Error('The wildcard control could not reach both known endpoints; the comparison is inconclusive.');
  }
  if (standard.privateConnected || !standard.publicConnected) {
    throw new Error('The default policy did not block the node endpoint while retaining the public connection.');
  }
  log('comparison.passed', { privateBlocked: true, publicReachable: true });
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  const key = process.env.CUBE_API_KEY || '';
  log('diagnostic.failed', { error: key ? message.replaceAll(key, '[redacted]') : message });
  process.exitCode = 1;
} finally {
  if (sandbox) {
    try {
      await sandbox.kill();
      log('sandbox.cleanup.complete', { sandboxId: sandbox.sandboxId });
    } catch (error) {
      log('sandbox.cleanup.failed', { sandboxId: sandbox.sandboxId, error: error instanceof Error ? error.name : 'unknown' });
      process.exitCode = 1;
    }
    sandbox.close();
  }
  process.stdout.write(`diagnostic_log=${logPath}\n`);
}
