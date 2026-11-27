import { once } from 'node:events';
import { config } from './config.ts';
import { pool, runLeasePool } from './db.ts';
import { migrate } from './migrate.ts';
import { listen } from './http.ts';
import { startAgentRuntime, stopAgentRuntime } from './agent-runtime.ts';
import { probeCubeApi } from './cube-health.ts';

function logLifecycle(stage: string, level: 'info' | 'warning' | 'error', details: Record<string, unknown> = {}): void {
  const sanitize = (value: unknown, key = '', depth = 0): unknown => {
    if (/api.?key|password|token|secret|credential|authorization|cookie/i.test(key)) return '[redacted]';
    if (typeof value === 'string') {
      return [config.agent.apiKey, config.cube.apiKey].filter(Boolean)
        .reduce((text, secret) => text.split(secret).join('[redacted]'), value)
        .replace(/\b(Bearer|Basic)\s+[^\s"'`]+/gi, '$1 [redacted]')
        .replace(/\bsk-[A-Za-z0-9_-]{8,}\b/g, '[redacted-api-key]')
        .replace(/(?:https?:\/\/)[^\s/@]+:[^\s/@]+@/gi, 'https://[redacted]@')
        .slice(-4000);
    }
    if (!value || typeof value !== 'object') return value;
    if (depth >= 4) return '[truncated]';
    if (Array.isArray(value)) return value.slice(0, 50).map(item => sanitize(item, '', depth + 1));
    return Object.fromEntries(Object.entries(value).slice(0, 50).map(([childKey, childValue]) => [childKey, sanitize(childValue, childKey, depth + 1)]));
  };
  const safeDetails = sanitize(details) as Record<string, unknown>;
  process.stdout.write(JSON.stringify({ timestamp: new Date().toISOString(), logger: 'coke-super-agent.lifecycle', stage, level, ...safeDetails }) + '\n');
}

function endpointOrigin(value: string): string | null {
  if (!value) return null;
  try { return new URL(value).origin; }
  catch { return '(invalid)'; }
}

async function start(): Promise<void> {
  const startedAt = Date.now();
  logLifecycle('startup.start', 'info', { nodeVersion: process.version, platform: process.platform, architecture: process.arch, host: config.host, port: config.port });
  const runtimeSupported = config.agent.runtime === 'dsh' || config.agent.runtime === 'pi';
  const templateConfigured = Boolean(config.cube.dshTemplateSnapshotId || config.cube.templateId);
  const modelConfigured = Boolean(config.agent.apiKey && config.agent.model);
  const runtimeBaseUrl = config.agent.runtime === 'pi' ? config.agent.piBaseUrl : config.agent.baseUrl;
  logLifecycle(
    'configuration.preflight',
    runtimeSupported && modelConfigured && config.cube.apiUrl && templateConfigured ? 'info' : 'warning',
    {
      agentRuntime: config.agent.runtime,
      runtimeSupported,
      model: config.agent.model || null,
      runtimeEndpointOrigin: endpointOrigin(runtimeBaseUrl),
      runtimeProtocol: config.agent.runtime === 'pi' ? 'openai-completions' : 'anthropic-messages',
      modelAuthAvailable: Boolean(config.agent.apiKey),
      cubeEndpointOrigin: endpointOrigin(config.cube.apiUrl),
      cubeAuthAvailable: Boolean(config.cube.apiKey),
      cubeTemplateConfigured: templateConfigured,
      requiredSettingsPresent: Boolean(runtimeSupported && modelConfigured && config.cube.apiUrl && templateConfigured),
    },
  );
  const cubeHealth = await probeCubeApi(config.cube.apiUrl);
  logLifecycle('cube.health.probe', cubeHealth.reachable === true ? 'info' : 'warning', { ...cubeHealth });
  const migrationStartedAt = Date.now();
  logLifecycle('database.migration.start', 'info');
  await migrate();
  logLifecycle('database.migration.complete', 'info', { durationMs: Date.now() - migrationStartedAt });
  const server = listen();
  logLifecycle('http.server.start.requested', 'info', { host: config.host, port: config.port });
  startAgentRuntime();
  await once(server, 'listening');
  logLifecycle('http.server.ready', 'info', { host: config.host, port: config.port });
  logLifecycle('startup.ready', 'info', { durationMs: Date.now() - startedAt });
  let shuttingDown = false;
  const shutdown = (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    logLifecycle('shutdown.start', 'warning', { signal });
    stopAgentRuntime();
    server.close(() => {
      logLifecycle('http.server.closed', 'info', { signal });
      void Promise.all([pool.end(), runLeasePool.end()]).then(() => {
        logLifecycle('shutdown.complete', 'info', { signal });
        process.exit(0);
      }).catch(error => {
        logLifecycle('shutdown.database.close.failed', 'error', { signal, error: error instanceof Error ? error.message : String(error) });
        process.exit(1);
      });
    });
    setTimeout(() => {
      logLifecycle('shutdown.timeout', 'error', { signal, timeoutMs: 5000 });
      process.exit(1);
    }, 5000).unref();
  };
  process.once('SIGINT', () => shutdown('SIGINT'));
  process.once('SIGTERM', () => shutdown('SIGTERM'));
}

start().catch(async error => {
  const value = error instanceof Error ? error : new Error(String(error));
  logLifecycle('startup.failed', 'error', {
    errorName: value.name,
    error: value.message,
    ...(value.stack ? { errorStack: value.stack.slice(-4000) } : {}),
    ...(value.cause instanceof Error ? { errorCause: value.cause.message } : {}),
  });
  await Promise.all([pool.end(), runLeasePool.end()]);
  process.exitCode = 1;
});
