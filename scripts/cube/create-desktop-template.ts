import 'dotenv/config';
import { randomUUID } from 'node:crypto';
import { Config, Template } from '@cubesandbox/sdk';

const buildRunId = randomUUID();
const buildStartedAt = Date.now();
const templateName = process.env.CUBE_DESKTOP_TEMPLATE_NAME || 'coke-super-agent-desktop-image-v1';
const apiUrl = process.env.CUBE_API_URL || '';
const image = process.env.CUBE_DESKTOP_BASE_IMAGE || '';
const apiKey = process.env.CUBE_API_KEY || undefined;

function safeText(value: string): string {
  return value
    .replace(/(https?:\/\/)[^/@\s]+:[^/@\s]+@/gi, '$1[redacted]@')
    .replace(/([?&](?:token|key|password|secret)=)[^&\s]+/gi, '$1[redacted]');
}

function log(stage: string, fields: Record<string, string | number | boolean> = {}): void {
  process.stdout.write(`${JSON.stringify({
    timestamp: new Date().toISOString(),
    buildRunId,
    elapsedMs: Date.now() - buildStartedAt,
    stage,
    ...fields,
  })}\n`);
}

if (!apiUrl || !image) {
  throw new Error('Set CUBE_API_URL and CUBE_DESKTOP_BASE_IMAGE in the local environment file first.');
}

log('template.config.validated', {
  apiOrigin: new URL(apiUrl).origin,
  templateName,
  image: safeText(image),
  cpuCount: 2000,
  memoryMb: 2048,
  writableLayerSize: '8Gi',
  exposedPorts: '6080,49983',
  probe: '49983/health',
});

const cube = new Config({ apiUrl, apiKey, requestTimeoutMs: 30_000 });
log('template.list.start');
const templates = await Template.list({ config: cube });
log('template.list.complete', { count: templates.length });
const existing = templates.find(template => template.name === templateName);
if (existing) {
  if (existing.status !== 'READY') {
    log('template.existing.not_ready', { templateId: existing.templateId, status: existing.status });
    throw new Error(`Template ${templateName} already exists with status ${existing.status}; inspect it before retrying.`);
  }
  log('template.existing.reused', { templateId: existing.templateId, status: existing.status });
  process.stdout.write(JSON.stringify({ templateId: existing.templateId, name: existing.name, status: existing.status }) + '\n');
  process.exit(0);
}

log('template.build.start', { image: safeText(image), templateName });
const build = await Template.build({
  config: cube,
  image,
  name: templateName,
  cpuCount: 2000,
  memoryMb: 2048,
  writableLayerSize: '8Gi',
  exposedPorts: [6080, 49983],
  probePort: 49983,
  probePath: '/health',
  allowInternetAccess: true,
});

if (!build.templateId || !build.buildId) {
  throw new Error('CubeSandbox returned a template build without stable identifiers.');
}
log('template.build.accepted', { templateId: build.templateId, buildId: build.buildId });

const deadline = Date.now() + 15 * 60_000;
let lastProgress = -1;
while (Date.now() < deadline) {
  const status = await Template.getBuildStatus(build.templateId, build.buildId, { config: cube });
  if (status.progress !== lastProgress) {
    lastProgress = status.progress;
    log('template.build.progress', {
      templateId: build.templateId,
      buildId: build.buildId,
      status: status.status,
      phase: status.phase,
      progress: status.progress,
    });
  }
  if (['ready', 'success', 'succeeded', 'completed'].includes(status.status.toLowerCase())) break;
  if (['failed', 'error', 'cancelled', 'canceled'].includes(status.status.toLowerCase())) {
    const detail = safeText(status.errorMessage || status.message || 'no error detail');
    log('template.build.failed', { templateId: build.templateId, buildId: build.buildId, phase: status.phase, detail });
    throw new Error(`CubeSandbox template build failed in phase ${status.phase}: ${detail}`);
  }
  await new Promise(resolve => setTimeout(resolve, 3_000));
}

if (Date.now() >= deadline) {
  log('template.build.wait_timeout', { templateId: build.templateId, buildId: build.buildId });
  throw new Error('CubeSandbox template build exceeded the 15 minute wait limit.');
}
log('template.readback.start', { templateId: build.templateId });
const template = await Template.get(build.templateId, { config: cube });
if (template.status !== 'READY') {
  log('template.readback.not_ready', { templateId: template.templateId, status: template.status });
  throw new Error(`CubeSandbox template finished with status ${template.status}.`);
}
log('template.ready', { templateId: template.templateId, name: template.name, status: template.status });
process.stdout.write(JSON.stringify({ templateId: template.templateId, name: template.name, status: template.status }) + '\n');
