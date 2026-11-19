import 'dotenv/config';
import { Config, Template } from '@cubesandbox/sdk';

const templateName = process.env.CUBE_DESKTOP_TEMPLATE_NAME || 'coke-super-agent-desktop-base-v2';
const apiUrl = process.env.CUBE_API_URL || '';
const image = process.env.CUBE_DESKTOP_BASE_IMAGE || '';
const apiKey = process.env.CUBE_API_KEY || undefined;

if (!apiUrl || !image) {
  throw new Error('Set CUBE_API_URL and CUBE_DESKTOP_BASE_IMAGE in the local environment file first.');
}

const cube = new Config({ apiUrl, apiKey, requestTimeoutMs: 30_000 });
const existing = (await Template.list({ config: cube })).find(template => template.name === templateName);
if (existing) {
  if (existing.status !== 'READY') {
    throw new Error(`Template ${templateName} already exists with status ${existing.status}; inspect it before retrying.`);
  }
  process.stdout.write(JSON.stringify({ templateId: existing.templateId, name: existing.name, status: existing.status }) + '\n');
  process.exit(0);
}

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

const deadline = Date.now() + 15 * 60_000;
let lastProgress = -1;
while (Date.now() < deadline) {
  const status = await Template.getBuildStatus(build.templateId, build.buildId, { config: cube });
  if (status.progress !== lastProgress) {
    lastProgress = status.progress;
    process.stdout.write(`${status.status} ${status.phase} ${status.progress}%\n`);
  }
  if (['ready', 'success', 'succeeded', 'completed'].includes(status.status.toLowerCase())) break;
  if (['failed', 'error', 'cancelled', 'canceled'].includes(status.status.toLowerCase())) {
    throw new Error(`CubeSandbox template build failed in phase ${status.phase}: ${status.errorMessage || status.message || 'no error detail'}`);
  }
  await new Promise(resolve => setTimeout(resolve, 3_000));
}

if (Date.now() >= deadline) throw new Error('CubeSandbox template build exceeded the 15 minute wait limit.');
const template = await Template.get(build.templateId, { config: cube });
if (template.status !== 'READY') throw new Error(`CubeSandbox template finished with status ${template.status}.`);
process.stdout.write(JSON.stringify({ templateId: template.templateId, name: template.name, status: template.status }) + '\n');
