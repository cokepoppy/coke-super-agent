import 'dotenv/config';
import { createHash, randomUUID } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { spawn } from 'node:child_process';
import { chmod, copyFile, mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createPiRuntimeKey } from '../../src/shared/pi-runtime-key.ts';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const imageDirectory = join(repoRoot, 'images/coke-super-agent-desktop');
const cacheRoot = process.env.CSA_AGENT_RUNTIME_CACHE_DIR || join(homedir(), '.local/share/csa-cube-node/runtime-cache');
const logDirectory = process.env.CSA_BUILD_LOG_DIR || join(homedir(), '.local/share/csa-cube-node/build-logs');
const buildRunId = randomUUID();
const buildStartedAt = Date.now();
const imageName = process.env.CSA_DESKTOP_IMAGE || 'coke-super-agent-desktop:local';
const pushImage = process.env.CSA_DESKTOP_IMAGE_PUSH === '1';
const registryDockerHost = process.env.CSA_LOCAL_REGISTRY_DOCKER_HOST || 'localhost:15001';
const registryGuestUrl = (process.env.CSA_LOCAL_REGISTRY_GUEST_URL || 'http://127.0.0.1:15002').replace(/\/$/, '');
const registryRepository = process.env.CSA_LOCAL_REGISTRY_REPOSITORY || 'coke-super-agent-desktop';
const baseImage = process.env.CUBE_DESKTOP_DOCKER_BASE_IMAGE || 'ghcr.io/tencentcloud/cubesandbox-base:2026.16';
if (pushImage) {
  if (!/^(localhost|127\.0\.0\.1):[0-9]+$/.test(registryDockerHost)) {
    throw new Error('The local image push target must use localhost or 127.0.0.1.');
  }
  const guestRegistry = new URL(registryGuestUrl);
  if (guestRegistry.protocol !== 'http:' || !['localhost', '127.0.0.1'].includes(guestRegistry.hostname)) {
    throw new Error('The Cube registry endpoint must be an HTTP loopback URL.');
  }
  if (!/^[a-z0-9]+(?:[._-][a-z0-9]+)*$/.test(registryRepository)) {
    throw new Error('The local registry repository name is invalid.');
  }
}
const configuredAptMirror = process.env.CSA_DESKTOP_APT_MIRROR?.trim();
const aptMirrorCandidate = configuredAptMirror || 'http://mirrors.tencent.com/ubuntu-ports';
const aptMirrorUrl = new URL(aptMirrorCandidate);
let aptMirrorRemapped = false;
if (aptMirrorUrl.hostname === 'mirrors.tencent.com' && aptMirrorUrl.pathname.replace(/\/$/, '') === '/ubuntu') {
  aptMirrorUrl.pathname = '/ubuntu-ports';
  aptMirrorRemapped = true;
}
const arm64UbuntuCubeBase = baseImage.startsWith('ghcr.io/tencentcloud/cubesandbox-base:');
if (arm64UbuntuCubeBase && aptMirrorUrl.pathname.replace(/\/$/, '') === '/debian') {
  if (!['mirrors.tuna.tsinghua.edu.cn', 'mirrors.tencent.com'].includes(aptMirrorUrl.hostname)) {
    throw new Error('The ARM64 Cube base image uses Ubuntu; CSA_DESKTOP_APT_MIRROR must end in /ubuntu-ports.');
  }
  aptMirrorUrl.pathname = '/ubuntu-ports';
  aptMirrorRemapped = true;
}
const aptMirror = aptMirrorUrl.toString().replace(/\/$/, '');
const npmProxy = process.env.CSA_NPM_HTTP_PROXY || (process.platform === 'darwin' ? 'http://127.0.0.1:7890' : '');

await mkdir(logDirectory, { recursive: true, mode: 0o700 });
const logPath = join(logDirectory, `desktop-image-build-${new Date().toISOString().replace(/[:.]/g, '-')}-${buildRunId}.log`);
await writeFile(logPath, '', { mode: 0o600 });
await chmod(logPath, 0o600);
const logStream = createWriteStream(logPath, { flags: 'a', mode: 0o600 });

function log(stage: string, fields: Record<string, string | number | boolean> = {}): void {
  const line = JSON.stringify({
    timestamp: new Date().toISOString(),
    buildRunId,
    elapsedMs: Date.now() - buildStartedAt,
    stage,
    ...fields,
  });
  process.stdout.write(line + '\n');
  logStream.write(line + '\n');
}

function safeArgsForLog(args: string[]): string {
  return args.map(value => value
    .replace(/(https?:\/\/)[^/@\s]+:[^/@\s]+@/gi, '$1[redacted]@')
    .replace(/([?&](?:token|key|password|secret)=)[^&\s]+/gi, '$1[redacted]'))
    .join(' ');
}

const childEnvironment: NodeJS.ProcessEnv = {};
for (const key of [
  'PATH', 'HOME', 'USER', 'LOGNAME', 'SHELL', 'TMPDIR', 'TMP', 'LANG', 'LC_ALL', 'TZ',
  'DOCKER_CONFIG', 'DOCKER_CONTEXT', 'DOCKER_HOST', 'DOCKER_TLS_VERIFY', 'DOCKER_CERT_PATH', 'BUILDKIT_HOST',
  'CSA_AGENT_RUNTIME_CACHE_DIR', 'CSA_NPM_CACHE_DIR', 'CSA_NPM_HTTP_PROXY', 'CSA_BUILD_LOG_DIR',
  'HTTP_PROXY', 'HTTPS_PROXY', 'http_proxy', 'https_proxy', 'NO_PROXY', 'no_proxy',
]) {
  if (process.env[key] !== undefined) childEnvironment[key] = process.env[key];
}

function shellCommand(command: string, args: string[], env: NodeJS.ProcessEnv, stage: string): Promise<string> {
  return new Promise((resolvePromise, reject) => {
    log(`${stage}.start`, { command, args: safeArgsForLog(args) });
    const child = spawn(command, args, { cwd: repoRoot, env, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    const write = (chunk: Buffer, stream: 'stdout' | 'stderr') => {
      const text = chunk.toString();
      if (stream === 'stdout') stdout += text;
      else stderr += text;
      process[stream].write(text);
      logStream.write(text);
    };
    child.stdout.on('data', chunk => write(chunk as Buffer, 'stdout'));
    child.stderr.on('data', chunk => write(chunk as Buffer, 'stderr'));
    child.on('error', error => reject(error));
    child.on('close', code => {
      log(code === 0 ? `${stage}.complete` : `${stage}.failed`, { exitCode: code ?? -1, durationMs: Date.now() - buildStartedAt });
      if (code === 0) resolvePromise(stdout);
      else reject(new Error(`${stage} exited ${code ?? -1}: ${stderr.slice(-2_000)}`));
    });
  });
}

function lastBundleLine(output: string, label: string): { archivePath: string; runtimeKey: string; archiveSha256: string } {
  const line = output.trim().split(/\r?\n/).at(-1) || '';
  const [archivePath, runtimeKey, archiveSha256] = line.split('\t');
  if (!archivePath || !/^[a-f0-9]{64}$/.test(runtimeKey || '') || !/^[a-f0-9]{64}$/.test(archiveSha256 || '')) {
    throw new Error(`${label} bundle builder returned an invalid archive descriptor.`);
  }
  return { archivePath, runtimeKey, archiveSha256 };
}

function proxyForBuildKit(value: string): string {
  if (!value) return '';
  const parsed = new URL(value);
  if (parsed.hostname === '127.0.0.1' || parsed.hostname === 'localhost' || parsed.hostname === '::1') {
    parsed.hostname = 'host.docker.internal';
  }
  return parsed.toString().replace(/\/$/, '');
}

const dshPackageDirectory = join(repoRoot, 'scripts/cube/dsh-runtime');
const piPackageDirectory = join(repoRoot, 'scripts/cube/pi-runtime');
const dshPackageLock = await readFile(join(dshPackageDirectory, 'package-lock.json'), 'utf8');
const dshManifest = await readFile(join(dshPackageDirectory, 'runtime-manifest.json'), 'utf8');
const dshRuntimeSource = await readFile(join(dshPackageDirectory, 'run-task.mjs'), 'utf8');
const dshComputerSource = await readFile(join(dshPackageDirectory, 'computer-plugin.mjs'), 'utf8');
const dshChromeBridgeSource = await readFile(join(dshPackageDirectory, 'chrome-cdp-pipe-bridge.mjs'), 'utf8');
const dshRuntimeLauncher = await readFile(join(dshPackageDirectory, 'dsh-runtime-launcher.mjs'), 'utf8');
const dshBundleBuilder = await readFile(join(repoRoot, 'scripts/cube/prepare-dsh-runtime-linux-arm64.sh'), 'utf8');
const dshBootstrap = await readFile(join(repoRoot, 'scripts/cube/bootstrap-dsh-runtime.sh'), 'utf8');
const dshBootstrapWrapper = await readFile(join(repoRoot, 'scripts/cube/run-dsh-runtime-bootstrap.sh'), 'utf8');
const dshRuntimeKey = createHash('sha256')
  .update(dshPackageLock).update('\0')
  .update(dshManifest).update('\0')
  .update(dshBundleBuilder).update('\0')
  .update(dshRuntimeSource).update('\0')
  .update(dshComputerSource).update('\0')
  .update(dshChromeBridgeSource).update('\0')
  .update(dshRuntimeLauncher).update('\0')
  .update(dshBootstrap).update('\0')
  .update(dshBootstrapWrapper)
  .digest('hex');
const dshRuntimeWheelSha256 = String(JSON.parse(dshManifest).runtimeWheelSha256 || '');

const piPackageJson = await readFile(join(piPackageDirectory, 'package.json'), 'utf8');
const piPackageLock = await readFile(join(piPackageDirectory, 'package-lock.json'), 'utf8');
const piManifest = await readFile(join(piPackageDirectory, 'runtime-manifest.json'), 'utf8');
const piRuntimeSource = await readFile(join(piPackageDirectory, 'run-task.mjs'), 'utf8');
const piComputerSource = await readFile(join(dshPackageDirectory, 'computer-plugin.mjs'), 'utf8');
const piBundleBuilder = await readFile(join(repoRoot, 'scripts/cube/prepare-pi-runtime-linux-arm64.sh'), 'utf8');
const piRuntimeKey = createPiRuntimeKey({
  packageJson: piPackageJson,
  packageLock: piPackageLock,
  runtimeManifest: piManifest,
  bundleBuilder: piBundleBuilder,
  runtimeSource: piRuntimeSource,
  computerPlugin: piComputerSource,
});

const buildEnv = { ...childEnvironment };
const dshOutput = await shellCommand('bash', ['scripts/cube/prepare-dsh-runtime-linux-arm64.sh'], buildEnv, 'runtime.dsh.prepare');
const piOutput = await shellCommand('bash', ['scripts/cube/prepare-pi-runtime-linux-arm64.sh'], {
  ...buildEnv,
  CSA_EXPECTED_RUNTIME_KEY: piRuntimeKey,
}, 'runtime.pi.prepare');
const dshBundle = lastBundleLine(dshOutput, 'DeepSeek Harness');
const piBundle = lastBundleLine(piOutput, 'Pi');
if (dshBundle.runtimeKey !== dshRuntimeKey) throw new Error('DeepSeek Harness archive key does not match the control-plane runtime key.');
if (piBundle.runtimeKey !== piRuntimeKey) throw new Error('Pi archive key does not match the control-plane runtime key.');

const dshLockHash = createHash('sha256').update(dshPackageLock).digest('hex');
const imageContext = await mkdtemp(join(cacheRoot, 'csa-desktop-image-context-'));
log('image-context.created', { path: imageContext });
try {
  await copyFile(join(imageDirectory, 'Dockerfile'), join(imageContext, 'Dockerfile'));
  await copyFile(join(repoRoot, 'scripts/cube/csa-desktop-session.sh'), join(imageContext, 'csa-desktop-session.sh'));
  await copyFile(dshBundle.archivePath, join(imageContext, 'dsh-runtime-linux-arm64.tar.gz'));
  await copyFile(piBundle.archivePath, join(imageContext, 'pi-runtime-linux-arm64.tar.gz'));
  const sourceCommit = (await shellCommand('git', ['rev-parse', 'HEAD'], buildEnv, 'git.source-revision')).trim().split(/\r?\n/).at(-1) || 'unknown';
  const manifest = {
    schemaVersion: 1,
    image: imageName,
    architecture: 'linux/arm64',
    sourceCommit,
    dsh: { runtimeKey: dshRuntimeKey, archiveSha256: dshBundle.archiveSha256, packageLockSha256: dshLockHash, version: JSON.parse(dshManifest).deepseekHarnessVersion },
    pi: { runtimeKey: piRuntimeKey, archiveSha256: piBundle.archiveSha256, version: JSON.parse(piManifest).version },
    desktop: { chrome: 'google-chrome-stable', cdpTransport: 'remote-debugging-pipe-http-websocket-bridge', nodeMajor: 24, python: 'python3', display: ':1', novncPort: 6080 },
    buildRunId,
  };
  await writeFile(join(imageContext, 'desktop-image.json'), JSON.stringify(manifest, null, 2) + '\n', { mode: 0o644 });
  const proxy = proxyForBuildKit(npmProxy);
  const buildArgs = [
    'buildx', 'build', '--platform', 'linux/arm64', '--progress', 'plain', '--tag', imageName,
    '--build-arg', `CUBE_BASE_IMAGE=${baseImage}`,
    '--build-arg', `APT_MIRROR=${aptMirror}`,
    '--build-arg', 'NODE_MAJOR=24',
    '--build-arg', `DSH_RUNTIME_FINGERPRINT=${dshRuntimeKey}`,
    '--build-arg', `DSH_PACKAGE_LOCK_SHA256=${dshLockHash}`,
    '--build-arg', `DSH_RUNTIME_WHEEL_SHA256=${dshRuntimeWheelSha256}`,
    '--build-arg', `PI_RUNTIME_FINGERPRINT=${piRuntimeKey}`,
  ];
  if (proxy) {
    for (const key of ['HTTP_PROXY', 'HTTPS_PROXY', 'http_proxy', 'https_proxy']) buildArgs.push('--build-arg', `${key}=${proxy}`);
  }
  buildArgs.push('--load', '--file', join(imageContext, 'Dockerfile'), imageContext);
  log('image.build.start', {
    image: imageName,
    architecture: 'linux/arm64',
    publish: pushImage,
    baseImage,
    aptMirror,
    aptMirrorConfigured: configuredAptMirror || 'default',
    aptMirrorRemapped,
    proxyConfigured: Boolean(proxy),
    contextBytes: (await Promise.all(['Dockerfile', 'csa-desktop-session.sh', 'dsh-runtime-linux-arm64.tar.gz', 'pi-runtime-linux-arm64.tar.gz', 'desktop-image.json'].map(name => stat(join(imageContext, name)).then(file => file.size)))).reduce((sum, size) => sum + size, 0),
    logPath,
  });
  await shellCommand('docker', buildArgs, buildEnv, 'image.build');
  if (!pushImage) {
    const imageInfo = await shellCommand('docker', ['image', 'inspect', imageName, '--format', '{{.Id}} {{.Size}} {{.Os}}/{{.Architecture}}'], buildEnv, 'image.inspect');
    log('image.local.ready', { image: imageName, imageInfo: imageInfo.trim(), published: false, next: 'Start the local registry tunnel, set CSA_DESKTOP_IMAGE_PUSH=1, and rerun to push only to the Mac loopback registry.' });
  } else {
    const registryTag = `${new Date().toISOString().slice(0, 10).replace(/-/g, '')}-${buildRunId.slice(0, 12)}`;
    const registryImage = `${registryDockerHost}/${registryRepository}:${registryTag}`;
    await shellCommand('docker', ['tag', imageName, registryImage], buildEnv, 'image.registry.tag');
    await shellCommand('docker', ['push', registryImage], buildEnv, 'image.registry.push');
    const hostForHttp = registryDockerHost.replace(/^localhost:/, '127.0.0.1:');
    const registryResponse = await fetch(`http://${hostForHttp}/v2/${registryRepository}/manifests/${registryTag}`, {
      method: 'HEAD',
      headers: {
        Accept: [
          'application/vnd.oci.image.index.v1+json',
          'application/vnd.oci.image.manifest.v1+json',
          'application/vnd.docker.distribution.manifest.list.v2+json',
          'application/vnd.docker.distribution.manifest.v2+json',
        ].join(', '),
      },
      signal: AbortSignal.timeout(10_000),
    });
    if (!registryResponse.ok) throw new Error(`Local registry manifest lookup failed with HTTP ${registryResponse.status}.`);
    const digest = registryResponse.headers.get('docker-content-digest');
    if (!digest || !/^sha256:[a-f0-9]{64}$/.test(digest)) throw new Error('Local registry response did not contain an OCI SHA-256 digest.');
    const cubeImageReference = `${registryGuestUrl}/${registryRepository}@${digest}`;
    log('image.published', {
      image: imageName,
      registryImage,
      digest,
      cubeImageReference,
      published: true,
      next: `Set CUBE_DESKTOP_BASE_IMAGE=${cubeImageReference} and run npm run cube:desktop-template.`,
    });
  }
} finally {
  await rm(imageContext, { recursive: true, force: true });
  log('image-context.removed', { path: imageContext });
}
await new Promise<void>(resolvePromise => logStream.end(resolvePromise));
