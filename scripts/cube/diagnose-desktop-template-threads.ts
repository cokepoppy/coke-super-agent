import 'dotenv/config';
import { execFileSync, spawnSync } from 'node:child_process';
import { appendFileSync, existsSync } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { build } from 'esbuild';
import { Config, NEVER_TIMEOUT, Sandbox } from '@cubesandbox/sdk';
import { runGuestPty } from '../../src/server/runtime-bundle.ts';

const apiUrl = process.env.CUBE_API_URL || '';
const templateId = process.env.CSA_CHROME_DIAGNOSTIC_TEMPLATE_ID || '';
const apiKey = process.env.CUBE_API_KEY || undefined;
const apiHost = apiUrl ? new URL(apiUrl).hostname : '';
const localCubeApi = apiHost === '127.0.0.1' || apiHost === 'localhost' || apiHost === '::1';
const proxyNodeIp = process.env.CUBE_PROXY_NODE_IP || (localCubeApi ? '127.0.0.1' : undefined);
const proxyPort = Number(process.env.CUBE_PROXY_PORT_HTTP || (localCubeApi ? '28080' : '80'));
const proxyScheme = process.env.CUBE_PROXY_SCHEME || 'http';
const sandboxDomain = process.env.CUBE_SANDBOX_DOMAIN || 'cube.app';
const cdpTimeoutSeconds = process.env.CSA_TEMPLATE_CHROME_CDP_TIMEOUT_SECONDS || '360';
if (!/^(?:[3-9][0-9]|[1-5][0-9]{2}|600)$/.test(cdpTimeoutSeconds)) throw new Error('CSA_TEMPLATE_CHROME_CDP_TIMEOUT_SECONDS must be between 30 and 600.');
const disableBackgroundNetworking = process.env.CSA_TEMPLATE_CHROME_DISABLE_BACKGROUND_NETWORKING || '0';
if (disableBackgroundNetworking !== '0' && disableBackgroundNetworking !== '1') throw new Error('CSA_TEMPLATE_CHROME_DISABLE_BACKGROUND_NETWORKING must be 0 or 1.');
const fontCachePrewarm = process.env.CSA_TEMPLATE_CHROME_PREWARM_FONTS || '0';
if (fontCachePrewarm !== '0' && fontCachePrewarm !== '1') throw new Error('CSA_TEMPLATE_CHROME_PREWARM_FONTS must be 0 or 1.');
const runId = randomUUID();
const startedAt = Date.now();
const logDirectory = process.env.CSA_BUILD_LOG_DIR || join(homedir(), '.local/share/csa-cube-node/build-logs');
const gdbBundlePath = process.env.CSA_TEMPLATE_CHROME_GDB_BUNDLE_PATH
  || join(homedir(), '.local/share/csa-cube-node/runtime-cache/gdb-ubuntu-jammy-arm64-12.1-rootfs.tar.gz');
const gdbBundleExpectedSha256 = '33c0188b5165b050feedd732e109149803aadd722fbabbab4fdba633848e1b04';
const straceBundlePath = process.env.CSA_TEMPLATE_CHROME_STRACE_BUNDLE_PATH
  || join(homedir(), '.local/share/csa-cube-node/runtime-cache/strace_6.1-0.1_arm64.deb');
const straceBundleExpectedSha256 = '751817724af91cb95df566a21a154f9a7dcdd938e700e5cb9a5a47eb19752ea2';
const logPath = join(logDirectory, `template-chrome-threads-${new Date().toISOString().replace(/[:.]/g, '-')}-${runId}.jsonl`);
await mkdir(logDirectory, { recursive: true, mode: 0o700 });
await writeFile(logPath, '', { mode: 0o600 });
await chmod(logPath, 0o600);

const redact = (value: string): string => value
  .replace(/(https?:\/\/)[^/@\s]+:[^/@\s]+@/gi, '$1[redacted]@')
  .replace(/([?&](?:token|key|password|secret)=)[^&\s]+/gi, '$1[redacted]')
  .replace(/(DevTools listening on ws:\/\/)[^\s]+/g, '$1[redacted]')
  .replace(/(\/devtools\/browser\/)[A-Za-z0-9_-]+/g, '$1[redacted]');

function log(stage: string, fields: Record<string, string | number | boolean> = {}): void {
  const row = JSON.stringify({ timestamp: new Date().toISOString(), runId, elapsedMs: Date.now() - startedAt, stage, ...fields });
  process.stdout.write(row + '\n');
  appendFileSync(logPath, row + '\n', { mode: 0o600 });
}

const delay = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms));

async function readGuestLog(sandbox: Sandbox, path: string, timeoutMs = 15_000): Promise<string> {
  const quotedPath = `'${path.replace(/'/g, `'\\''`)}'`;
  const result = await sandbox.commands.run(`if [ -r ${quotedPath} ]; then cat -- ${quotedPath}; fi`, { timeoutMs });
  if (result.exitCode !== 0) throw new Error(`Guest log read command exited with status ${result.exitCode}.`);
  return `${result.stdout || ''}${result.stderr || ''}`;
}

async function bundleChromePipeBridge(source: string): Promise<string> {
  const runtimeLock = JSON.parse(await readFile(new URL('./dsh-runtime/package-lock.json', import.meta.url), 'utf8')) as {
    packages?: Record<string, { version?: string; resolved?: string; integrity?: string }>;
  };
  const wsPackage = runtimeLock.packages?.['node_modules/ws'];
  if (!wsPackage?.version || !wsPackage.resolved || !wsPackage.integrity?.startsWith('sha512-')) {
    throw new Error('The locked ws runtime dependency is missing its version, resolved URL, or SHA-512 integrity.');
  }
  log('guest.bridge.bundle.start', { source, wsVersion: wsPackage.version, cacheMode: 'offline' });
  const tempRoot = await mkdtemp(join(tmpdir(), 'csa-chrome-bridge-'));
  try {
    const nodeModules = join(tempRoot, 'node_modules');
    const wsDirectory = join(nodeModules, 'ws');
    await mkdir(wsDirectory, { recursive: true });
    const npmCache = join(homedir(), '.local/share/csa-cube-node/runtime-cache/npm-cache');
    const packedName = execFileSync('npm', [
      'pack', wsPackage.resolved, '--offline', '--ignore-scripts', '--pack-destination', tempRoot, '--cache', npmCache,
    ], { encoding: 'utf8', timeout: 30_000 }).trim().split('\n').at(-1);
    if (!packedName || packedName !== `ws-${wsPackage.version}.tgz`) {
      throw new Error(`Unexpected npm pack result for the cached ws dependency: ${packedName || 'empty result'}.`);
    }
    const tarballPath = join(tempRoot, packedName);
    const tarball = await readFile(tarballPath);
    const actualIntegrity = `sha512-${createHash('sha512').update(tarball).digest('base64')}`;
    if (actualIntegrity !== wsPackage.integrity) throw new Error(`The cached ws tarball failed its lockfile SHA-512 integrity check (${wsPackage.version}).`);
    execFileSync('tar', ['-xzf', tarballPath, '-C', wsDirectory, '--strip-components=1'], { timeout: 15_000 });
    const result = await build({
      entryPoints: [source],
      bundle: true,
      platform: 'node',
      format: 'cjs',
      target: 'node24',
      nodePaths: [nodeModules],
      write: false,
      logLevel: 'silent',
    });
    const bundle = result.outputFiles[0]?.text;
    if (!bundle) throw new Error('esbuild returned no Chrome pipe bridge bundle.');
    const bundlePath = join(tempRoot, 'chrome-cdp-pipe-bridge.cjs');
    await writeFile(bundlePath, bundle, { mode: 0o600 });
    const syntax = spawnSync(process.execPath, ['--check', bundlePath], { encoding: 'utf8', timeout: 15_000, maxBuffer: 1024 * 1024 });
    if (syntax.status !== 0) throw new Error(`Chrome pipe bridge bundle syntax check failed: ${(syntax.stderr || syntax.stdout || '').slice(-1200)}`);
    const smoke = spawnSync(process.execPath, [bundlePath], {
      encoding: 'utf8',
      timeout: 15_000,
      maxBuffer: 1024 * 1024,
      env: { PATH: process.env.PATH || '/usr/bin:/bin', CSA_CHROME_CDP_PIPE_IMPORT_SMOKE: '1' },
    });
    if (smoke.status !== 0 || !String(smoke.stdout || '').includes('chrome_cdp_pipe_bridge_import_smoke_ok')) {
      throw new Error(`Chrome pipe bridge import smoke failed (status=${smoke.status}, signal=${smoke.signal || 'none'}): ${(smoke.stderr || smoke.stdout || 'No smoke output.').slice(0, 1800)}`);
    }
    log('guest.bridge.bundle.complete', { bytes: Buffer.byteLength(bundle), wsVersion: wsPackage.version, integrityVerified: true, syntaxCheck: true, importSmoke: true });
    return bundle;
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
}

if (!apiUrl || !templateId) throw new Error('Set CUBE_API_URL and CSA_CHROME_DIAGNOSTIC_TEMPLATE_ID.');
if (!Number.isSafeInteger(proxyPort) || proxyPort < 1 || proxyPort > 65535) throw new Error('CUBE_PROXY_PORT_HTTP must be a valid TCP port.');
const config = new Config({ apiUrl, apiKey, proxyNodeIp, proxyPort, proxyScheme, sandboxDomain, requestTimeoutMs: 30_000 });
const bootstrap = await readFile(new URL('./bootstrap-linux-desktop.sh', import.meta.url), 'utf8');
const launcher = await readFile(new URL('./launch-linux-desktop-bootstrap.sh', import.meta.url), 'utf8');
let desktopSession = await readFile(new URL('./csa-desktop-session.sh', import.meta.url), 'utf8');
if (disableBackgroundNetworking === '1') {
  const productFlags = '  --disable-dev-shm-usage --disable-gpu --no-first-run --no-default-browser-check';
  if (!desktopSession.includes(productFlags)) throw new Error('Could not locate the product Chrome flag block for the diagnostic-only background-networking comparison.');
  desktopSession = desktopSession.replace(productFlags, `${productFlags} --disable-background-networking`);
}
const guestDiagnostic = await readFile(new URL('./diagnose-template-chrome-threads.sh', import.meta.url), 'utf8');
const chromePipeBridge = await bundleChromePipeBridge(new URL('./dsh-runtime/chrome-cdp-pipe-bridge.mjs', import.meta.url).pathname);
let sandbox: Sandbox | undefined;

try {
  log('sandbox.create.start', { templateId, cpuCount: 2000, memoryMb: 2048, writableLayerSize: '8Gi', proxyNodeIp: proxyNodeIp || 'dns', proxyPort, proxyScheme, sandboxDomain, disableBackgroundNetworking: disableBackgroundNetworking === '1' });
  sandbox = await Sandbox.create({
    config,
    template: templateId,
    timeout: NEVER_TIMEOUT,
    allowInternetAccess: true,
    network: { allowPublicTraffic: false, allowOut: ['0.0.0.0/0'] },
    extra: { restartPolicy: 'Never' },
    metadata: { csa_desktop_diagnostic: 'chrome-thread-sample', csa_diagnostic_run: runId },
  });
  const sandboxInfo = await sandbox.getInfo();
  log('sandbox.create.complete', { sandboxId: sandbox.sandboxId, templateId: sandbox.templateId, state: String(sandboxInfo.state || 'unknown'), dataPlaneHost: sandbox.getHost(49983) });

  const stagedFiles = [
    ['/tmp/csa-desktop-bootstrap.sh', bootstrap],
    ['/tmp/csa-launch-desktop-bootstrap.sh', launcher],
    ['/tmp/csa-desktop-session.sh', desktopSession],
    ['/tmp/csa-chrome-cdp-pipe-bridge.cjs', chromePipeBridge],
    ['/tmp/csa-diagnose-template-chrome-threads.sh', guestDiagnostic],
  ] as const;
  for (const [path, contents] of stagedFiles) {
    log('guest.file.stage.start', { sandboxId: sandbox.sandboxId, path, bytes: Buffer.byteLength(contents) });
    await sandbox.files.write(path, contents);
    log('guest.file.stage.complete', { sandboxId: sandbox.sandboxId, path });
  }

  const launch = await runGuestPty(
    sandbox,
    'exec bash /tmp/csa-launch-desktop-bootstrap.sh',
    '/',
    {
      CSA_TENANT_ID: 'template-chrome-diagnostic',
      CSA_CUBE_SANDBOX_ID: sandbox.sandboxId,
      CSA_COMPUTER_GENERATION: '1',
      CSA_RUN_ID: runId,
      CSA_CHROME_CDP_PIPE_BRIDGE_PATH: '/tmp/csa-chrome-cdp-pipe-bridge.cjs',
      CSA_DESKTOP_CHROME_TRACE_STARTUP: process.env.CSA_TEMPLATE_CHROME_TRACE_STARTUP || '0',
      CSA_DESKTOP_CHROME_CDP_TIMEOUT_SECONDS: cdpTimeoutSeconds,
      CSA_DESKTOP_FONT_CACHE_PREWARM: fontCachePrewarm,
    },
    line => log('bootstrap.launch.output', { sandboxId: sandbox!.sandboxId, line: redact(line) }),
    30_000,
  );
  log('bootstrap.launch.complete', { sandboxId: sandbox.sandboxId, exitCode: launch.exitCode });

  const guestLogPath = '/tmp/csa-template-chrome-threads.log';
  const detachedRunnerLogPath = '/tmp/csa-template-chrome-threads-runner.log';
  const sampleDelay = process.env.CSA_TEMPLATE_CHROME_SAMPLE_DELAY_SECONDS || '25';
  if (!/^(?:1[0-9]|[2-5][0-9]|60)$/.test(sampleDelay)) throw new Error('CSA_TEMPLATE_CHROME_SAMPLE_DELAY_SECONDS must be between 10 and 60.');
  const threadSample = process.env.CSA_TEMPLATE_CHROME_THREAD_SAMPLE || '1';
  if (threadSample !== '0' && threadSample !== '1') throw new Error('CSA_TEMPLATE_CHROME_THREAD_SAMPLE must be 0 or 1.');
  const watchSeconds = process.env.CSA_TEMPLATE_CHROME_WATCH_SECONDS || '0';
  if (!/^(?:0|[1-9][0-9]{0,2})$/.test(watchSeconds) || Number(watchSeconds) > 450) throw new Error('CSA_TEMPLATE_CHROME_WATCH_SECONDS must be between 0 and 450.');
  const gdbSample = process.env.CSA_TEMPLATE_CHROME_GDB_SAMPLE || '0';
  if (gdbSample !== '0' && gdbSample !== '1') throw new Error('CSA_TEMPLATE_CHROME_GDB_SAMPLE must be 0 or 1.');
  const straceSample = process.env.CSA_TEMPLATE_CHROME_STRACE_SAMPLE || '0';
  if (straceSample !== '0' && straceSample !== '1') throw new Error('CSA_TEMPLATE_CHROME_STRACE_SAMPLE must be 0 or 1.');
  const straceAfterListener = process.env.CSA_TEMPLATE_CHROME_STRACE_AFTER_LISTENER || '0';
  if (straceAfterListener !== '0' && straceAfterListener !== '1') throw new Error('CSA_TEMPLATE_CHROME_STRACE_AFTER_LISTENER must be 0 or 1.');
  const straceMainThreadOnly = process.env.CSA_TEMPLATE_CHROME_STRACE_MAIN_THREAD_ONLY || '0';
  if (straceMainThreadOnly !== '0' && straceMainThreadOnly !== '1') throw new Error('CSA_TEMPLATE_CHROME_STRACE_MAIN_THREAD_ONLY must be 0 or 1.');
  const routeMatrixOnly = process.env.CSA_TEMPLATE_CHROME_ROUTE_MATRIX_ONLY || '0';
  if (routeMatrixOnly !== '0' && routeMatrixOnly !== '1') throw new Error('CSA_TEMPLATE_CHROME_ROUTE_MATRIX_ONLY must be 0 or 1.');
  const traceStartup = process.env.CSA_TEMPLATE_CHROME_TRACE_STARTUP || '0';
  if (traceStartup !== '0' && traceStartup !== '1') throw new Error('CSA_TEMPLATE_CHROME_TRACE_STARTUP must be 0 or 1.');
  let gdbBundleBytes: Buffer | undefined;
  if (gdbSample === '1') {
    gdbBundleBytes = await readFile(gdbBundlePath);
    const gdbBundleSha256 = createHash('sha256').update(gdbBundleBytes).digest('hex');
    log('guest.gdb.bundle.verify', { path: gdbBundlePath, bytes: gdbBundleBytes.byteLength, sha256: gdbBundleSha256 });
    if (gdbBundleSha256 !== gdbBundleExpectedSha256) throw new Error(`GDB bundle SHA-256 mismatch: expected ${gdbBundleExpectedSha256}, got ${gdbBundleSha256}.`);
  }
  if (gdbBundleBytes) {
    const path = '/tmp/csa-gdb-jammy-rootfs.tar.gz';
    log('guest.gdb.bundle.stage.start', { sandboxId: sandbox.sandboxId, path, bytes: gdbBundleBytes.byteLength, sha256: gdbBundleExpectedSha256 });
    await sandbox.files.write(path, gdbBundleBytes);
    log('guest.gdb.bundle.stage.complete', { sandboxId: sandbox.sandboxId, path, sha256: gdbBundleExpectedSha256 });
  }
  let straceBundleBytes: Buffer | undefined;
  if (straceSample === '1') {
    straceBundleBytes = await readFile(straceBundlePath);
    const straceBundleSha256 = createHash('sha256').update(straceBundleBytes).digest('hex');
    log('guest.strace.bundle.verify', { path: straceBundlePath, bytes: straceBundleBytes.byteLength, sha256: straceBundleSha256 });
    if (straceBundleSha256 !== straceBundleExpectedSha256) throw new Error(`strace bundle SHA-256 mismatch: expected ${straceBundleExpectedSha256}, got ${straceBundleSha256}.`);
  }
  if (straceBundleBytes) {
    const path = '/tmp/csa-strace-arm64.deb';
    log('guest.strace.bundle.stage.start', { sandboxId: sandbox.sandboxId, path, bytes: straceBundleBytes.byteLength, sha256: straceBundleExpectedSha256 });
    await sandbox.files.write(path, straceBundleBytes);
    log('guest.strace.bundle.stage.complete', { sandboxId: sandbox.sandboxId, path, sha256: straceBundleExpectedSha256 });
  }
  const launchDiagnostic = await sandbox.commands.run(
    `rm -f ${guestLogPath} ${detachedRunnerLogPath}; (nohup setsid env CSA_TEMPLATE_CHROME_SAMPLE_DELAY_SECONDS='${sampleDelay}' CSA_TEMPLATE_CHROME_THREAD_SAMPLE='${threadSample}' CSA_TEMPLATE_CHROME_WATCH_SECONDS='${watchSeconds}' CSA_TEMPLATE_CHROME_ROUTE_MATRIX_ONLY='${routeMatrixOnly}' CSA_TEMPLATE_CHROME_TRACE_STARTUP='${traceStartup}' CSA_TEMPLATE_CHROME_GDB_SAMPLE='${gdbSample}' CSA_TEMPLATE_CHROME_GDB_BUNDLE='/tmp/csa-gdb-jammy-rootfs.tar.gz' CSA_TEMPLATE_CHROME_GDB_BUNDLE_SHA256='${gdbBundleExpectedSha256}' CSA_TEMPLATE_CHROME_STRACE_SAMPLE='${straceSample}' CSA_TEMPLATE_CHROME_STRACE_AFTER_LISTENER='${straceAfterListener}' CSA_TEMPLATE_CHROME_STRACE_MAIN_THREAD_ONLY='${straceMainThreadOnly}' CSA_TEMPLATE_CHROME_PREWARM_FONTS='${fontCachePrewarm}' CSA_TEMPLATE_CHROME_STRACE_BUNDLE='/tmp/csa-strace-arm64.deb' CSA_TEMPLATE_CHROME_STRACE_BUNDLE_SHA256='${straceBundleExpectedSha256}' CSA_TEMPLATE_CHROME_DIAG_LOG='${guestLogPath}' bash /tmp/csa-diagnose-template-chrome-threads.sh >${detachedRunnerLogPath} 2>&1 </dev/null & echo $!)`,
    { timeoutMs: 15_000 },
  );
  log('guest.diagnostic.launch', { sandboxId: sandbox.sandboxId, exitCode: launchDiagnostic.exitCode, gdbSample, straceSample, straceAfterListener, straceMainThreadOnly, fontCachePrewarm, routeMatrixOnly, traceStartup, threadSample, disableBackgroundNetworking: disableBackgroundNetworking === '1', watchSeconds: Number(watchSeconds), output: redact(`${launchDiagnostic.stdout || ''}${launchDiagnostic.stderr || ''}`).trim() });
  if (launchDiagnostic.exitCode !== 0) throw new Error('Unable to start the detached guest thread sampler.');

  const diagnosticTimeoutMs = routeMatrixOnly === '1'
    ? Math.max(420_000, (Number(watchSeconds) + 240) * 1_000)
    : fontCachePrewarm === '1'
      ? Math.max(600_000, (Number(watchSeconds) + Number(cdpTimeoutSeconds) + 300) * 1_500)
    : gdbSample === '1'
    ? 420_000
    : straceSample === '1'
      ? Math.max(straceAfterListener === '1' ? 540_000 : 300_000, (Number(watchSeconds) + (straceAfterListener === '1' ? 300 : 180)) * 1_000)
      : Math.max(120_000, (Number(watchSeconds) + 180) * 1_000);
  const deadline = Date.now() + diagnosticTimeoutMs;
  let observedText = '';
  let complete = false;
  let consecutiveReadFailures = 0;
  while (Date.now() < deadline) {
    let contents: string;
    try {
      contents = await readGuestLog(sandbox, guestLogPath);
      if (consecutiveReadFailures > 0) {
        log('guest.diagnostic.read.recovered', { sandboxId: sandbox.sandboxId, consecutiveFailures: consecutiveReadFailures });
      }
      consecutiveReadFailures = 0;
    } catch (error) {
      consecutiveReadFailures += 1;
      log('guest.diagnostic.read.failed', {
        sandboxId: sandbox.sandboxId,
        attempt: consecutiveReadFailures,
        error: redact(error instanceof Error ? error.message : String(error)),
      });
      if (consecutiveReadFailures >= 3) {
        log('guest.diagnostic.read.aborted', { sandboxId: sandbox.sandboxId, reason: 'three-consecutive-read-failures' });
        process.exitCode = 1;
        break;
      }
      await delay(1_000);
      continue;
    }
    if (contents.length > observedText.length) {
      const delta = contents.slice(observedText.length);
      observedText = contents;
      for (const line of delta.split(/\r?\n/).filter(Boolean)) {
        log('guest.diagnostic.output', { sandboxId: sandbox.sandboxId, line: redact(line) });
      }
      if (contents.includes('stage=sequence.complete')) {
        complete = true;
        break;
      }
    }
    await delay(3_000);
  }
  if (!complete) {
    let runnerTail = '';
    try {
      runnerTail = await readGuestLog(sandbox, detachedRunnerLogPath);
    } catch (error) {
      log('guest.diagnostic.runner-log.read.failed', {
        sandboxId: sandbox.sandboxId,
        error: redact(error instanceof Error ? error.message : String(error)),
      });
    }
    log('guest.diagnostic.deadline', { sandboxId: sandbox.sandboxId, timeoutMs: diagnosticTimeoutMs, outputTail: redact(runnerTail.slice(-2_400)) });
    process.exitCode = 1;
  } else {
    log('guest.diagnostic.complete', { sandboxId: sandbox.sandboxId, sequenceComplete: true });
  }
  if (traceStartup === '1') {
    const tracePath = '/tmp/csa-chromium-startup-trace.json';
    try {
      const sizeResult = await sandbox.commands.run(`stat -c %s ${tracePath} 2>/dev/null || true`, { timeoutMs: 10_000 });
      const traceBytes = Number(String(sizeResult.stdout || '').trim());
      if (!Number.isSafeInteger(traceBytes) || traceBytes < 2 || traceBytes > 80 * 1024 * 1024) {
        log('guest.trace.capture.skipped', { sandboxId: sandbox.sandboxId, tracePath, traceBytes: Number.isSafeInteger(traceBytes) ? traceBytes : 0, reason: traceBytes > 80 * 1024 * 1024 ? 'trace-over-80MiB' : 'trace-file-unavailable' });
      } else {
        log('guest.trace.capture.start', { sandboxId: sandbox.sandboxId, tracePath, traceBytes });
        const traceData = await sandbox.files.read(tracePath, { format: 'bytes' });
        let traceText = Buffer.from(traceData).toString('utf8');
        let traceFormat = 'json';
        try {
          JSON.parse(traceText);
        } catch {
          const traceProcessorPath = process.env.CSA_PERFETTO_TRACE_PROCESSOR
            || join(homedir(), '.local/share/perfetto/prebuilts/trace_processor_shell-8488edbefadfc4be');
          if (!existsSync(traceProcessorPath)) {
            throw new Error(`Perfetto trace requires a local trace_processor binary; configure CSA_PERFETTO_TRACE_PROCESSOR (looked at ${traceProcessorPath}).`);
          }
          log('guest.trace.convert.start', { sandboxId: sandbox.sandboxId, format: 'perfetto-proto-to-json', traceBytes, processorPath: traceProcessorPath });
          traceText = execFileSync(traceProcessorPath, ['convert', 'json', '-', '-'], {
            input: Buffer.from(traceData),
            encoding: 'utf8',
            timeout: 60_000,
            maxBuffer: 128 * 1024 * 1024,
          });
          traceFormat = 'perfetto-proto';
          log('guest.trace.convert.complete', { sandboxId: sandbox.sandboxId, format: 'perfetto-proto-to-json', traceBytes, jsonBytes: Buffer.byteLength(traceText) });
        }
        const traceDocument = JSON.parse(traceText) as { traceEvents?: Array<Record<string, unknown>> };
        const events = Array.isArray(traceDocument.traceEvents) ? traceDocument.traceEvents : [];
        const threadRows = events.filter(event => event.name === 'thread_name').map(event => ({ pid: event.pid, tid: event.tid, name: (event.args as Record<string, unknown> | undefined)?.name }));
        const mainThread = threadRows.find(row => /CrBrowserMain|BrowserMain/i.test(String(row.name || ''))) || threadRows.find(row => row.pid === row.tid);
        const devtoolsThread = threadRows.find(row => /Chrome_DevTools/i.test(String(row.name || '')));
        const isThreadEvent = (event: Record<string, unknown>, thread: { pid?: unknown; tid?: unknown } | undefined): boolean => Boolean(thread && event.tid === thread.tid && event.pid === thread.pid);
        const sourceMatches = (event: Record<string, unknown>): boolean => /devtools_http_handler|OnJsonRequest|OnDiscoveryPageRequest|ServerWrapper/i.test(JSON.stringify({ name: event.name, cat: event.cat, args: event.args }));
        const eventSummary = (event: Record<string, unknown>): Record<string, unknown> => ({ ts: event.ts, dur: event.dur, name: event.name, cat: event.cat, ph: event.ph, args: event.args });
        const uiTopLevel = events.filter(event => isThreadEvent(event, mainThread) && String(event.cat || '').split(',').includes('toplevel'));
        const devtoolsTopLevel = events.filter(event => isThreadEvent(event, devtoolsThread) && String(event.cat || '').split(',').includes('toplevel'));
        const uiSourceHits = uiTopLevel.filter(sourceMatches).slice(-20).map(eventSummary);
        const devtoolsSourceHits = devtoolsTopLevel.filter(sourceMatches).slice(-20).map(eventSummary);
        log('guest.trace.capture.complete', {
          sandboxId: sandbox.sandboxId,
          tracePath,
          traceFormat,
          traceBytes: traceData.byteLength,
          traceEventCount: events.length,
          threadNames: JSON.stringify(threadRows.slice(0, 80)),
          mainThread: JSON.stringify(mainThread || null),
          devtoolsThread: JSON.stringify(devtoolsThread || null),
          mainThreadTopLevelCount: uiTopLevel.length,
          devtoolsThreadTopLevelCount: devtoolsTopLevel.length,
          mainThreadDevToolsSourceHitCount: uiTopLevel.filter(sourceMatches).length,
          devtoolsThreadDevToolsSourceHitCount: devtoolsTopLevel.filter(sourceMatches).length,
          mainThreadDevToolsSourceHits: redact(JSON.stringify(uiSourceHits)).slice(0, 8_000),
          devtoolsThreadDevToolsSourceHits: redact(JSON.stringify(devtoolsSourceHits)).slice(0, 8_000),
          mainThreadRecentTasks: redact(JSON.stringify(uiTopLevel.slice(-20).map(eventSummary))).slice(0, 6_000),
        });
      }
    } catch (error) {
      log('guest.trace.capture.failed', { sandboxId: sandbox.sandboxId, tracePath, error: redact(error instanceof Error ? error.message : String(error)) });
    }
  }
  try {
    log('guest.state.snapshot.start', { sandboxId: sandbox.sandboxId, files: 10, tailLinesPerFile: 20 });
    const stateSnapshot = await sandbox.commands.run(
      `for path in /var/lib/csa-desktop/bootstrap.status /var/lib/csa-desktop/bootstrap.pid /var/lib/csa-desktop/bootstrap.exitcode /run/csa-desktop/session.pid /var/lib/csa-desktop/bootstrap.log /tmp/csa-desktop-session.log /tmp/csa-fontconfig-prewarm.log /tmp/csa-xfce.log /tmp/csa-vnc.log /tmp/csa-websockify.log /tmp/csa-chromium.log; do
        if [ -r "$path" ]; then
          printf 'guest_state_file path=%s present=1 bytes=%s\\n' "$path" "$(wc -c <"$path" | tr -d ' ')"
          case "$path" in
            /var/lib/csa-desktop/bootstrap.status|/var/lib/csa-desktop/bootstrap.pid|/var/lib/csa-desktop/bootstrap.exitcode|/run/csa-desktop/session.pid) tail -n 2 "$path" ;;
            /var/lib/csa-desktop/bootstrap.log) tail -n 12 "$path" | cut -c1-600 ;;
            /tmp/csa-desktop-session.log) grep -E 'fontconfig\.cache\.prewarm' "$path" | tail -n 4; tail -n 10 "$path" | cut -c1-600 ;;
            /tmp/csa-fontconfig-prewarm.log) tail -n 10 "$path" | cut -c1-360 ;;
            /tmp/csa-chromium.log) grep -E '"stage":"(chrome\.process\.(spawned|spawn\.event|fd\.snapshot)|cdp\.command\.(start|write\.(start|queued|complete|failed)|response\.received|complete|timeout)|chrome\.browser-version\.ready|bridge\.(ready|failed)|cdp\.pipe\.(output\.(chunk|end|error)|invalid-json))"' "$path" | tail -n 60 | cut -c1-900; tail -n 30 "$path" | cut -c1-900 ;;
            *) tail -n 4 "$path" | cut -c1-360 ;;
          esac | sed -E 's/([Tt]oken|[Kk]ey|[Pp]assword|[Ss]ecret)=([^[:space:]]+)/\\1=[redacted]/g'
        else
          printf 'guest_state_file path=%s present=0\\n' "$path"
        fi
      done
      bootstrap_pid="$(cat /var/lib/csa-desktop/bootstrap.pid 2>/dev/null || true)"
      if [[ "$bootstrap_pid" =~ ^[0-9]+$ ]] && ((bootstrap_pid > 1)); then
        printf 'guest_bootstrap_process pid=%s ' "$bootstrap_pid"
        ps -p "$bootstrap_pid" -o pid=,ppid=,pgid=,stat=,etimes=,wchan=,comm= 2>&1 || true
        awk '/^(State|PPid|Uid|Threads):/ {print "guest_bootstrap_status " $0}' "/proc/$bootstrap_pid/status" 2>/dev/null || true
        ps -eo pid=,ppid=,pgid=,stat=,etimes=,wchan=,comm= | awk -v pid="$bootstrap_pid" '$1 == pid || $2 == pid {print "guest_bootstrap_tree " $0}'
      else
        printf 'guest_bootstrap_process pidfile_value=%s\\n' "\${bootstrap_pid:-missing}"
      fi`,
      { timeoutMs: 45_000 },
    );
    log('guest.state.snapshot.complete', {
      sandboxId: sandbox.sandboxId,
      exitCode: stateSnapshot.exitCode,
      output: redact(`${stateSnapshot.stdout || ''}${stateSnapshot.stderr || ''}`).slice(-20_000),
    });
  } catch (error) {
    log('guest.state.snapshot.failed', {
      sandboxId: sandbox.sandboxId,
      error: redact(error instanceof Error ? error.message : String(error)),
    });
  }
} catch (error) {
  const value = error instanceof Error ? error : new Error(String(error));
  const cause = value.cause instanceof Error ? value.cause : undefined;
  const causeCode = cause && 'code' in cause && typeof cause.code === 'string' ? cause.code : '';
  log('diagnostic.failed', { sandboxId: sandbox?.sandboxId || 'not-created', dataPlaneHost: sandbox?.getHost(49983) || '', errorName: value.name, error: redact(value.message), errorCauseName: cause?.name || '', errorCauseCode: causeCode, errorCause: cause ? redact(cause.message) : '' });
  process.exitCode = 1;
} finally {
  if (sandbox) {
    try {
      log('sandbox.cleanup.start', { sandboxId: sandbox.sandboxId });
      await sandbox.kill();
      log('sandbox.cleanup.complete', { sandboxId: sandbox.sandboxId });
    } catch (error) {
      log('sandbox.cleanup.failed', { sandboxId: sandbox.sandboxId, error: redact(error instanceof Error ? error.message : String(error)) });
      process.exitCode = 1;
    }
    sandbox.close();
  }
  process.stdout.write(`diagnostic_log=${logPath}\n`);
}
