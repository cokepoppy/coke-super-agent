import 'dotenv/config';
import { randomUUID } from 'node:crypto';
import { appendFileSync } from 'node:fs';
import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { Config, NEVER_TIMEOUT, Sandbox } from '@cubesandbox/sdk';

const templateId = process.env.CSA_CHROME_BRIDGE_TEMPLATE_ID || '';
const chromeTransport = process.env.CSA_DIAGNOSTIC_CHROME_TRANSPORT || 'pipe';
const cdpTimeoutSeconds = Number(process.env.CSA_DIAGNOSTIC_CDP_TIMEOUT_SECONDS || '360');
const apiUrl = process.env.CUBE_API_URL || '';
const apiKey = process.env.CUBE_API_KEY || undefined;
const apiHost = apiUrl ? new URL(apiUrl).hostname : '';
const localCubeApi = ['127.0.0.1', 'localhost', '::1'].includes(apiHost);
const proxyNodeIp = process.env.CUBE_PROXY_NODE_IP || (localCubeApi ? '127.0.0.1' : undefined);
const proxyPort = Number(process.env.CUBE_PROXY_PORT_HTTP || (localCubeApi ? '28080' : '80'));
const proxyScheme = process.env.CUBE_PROXY_SCHEME || 'http';
const sandboxDomain = process.env.CUBE_SANDBOX_DOMAIN || 'cube.app';
const runId = randomUUID();
const startedAt = Date.now();
const logDirectory = process.env.CSA_BUILD_LOG_DIR || join(homedir(), '.local/share/csa-cube-node/build-logs');
const logPath = join(logDirectory, `chrome-bridge-template-${new Date().toISOString().replace(/[:.]/g, '-')}-${runId}.jsonl`);
const sandboxIdPattern = /^[a-f0-9]{32}$/;
const sandboxShape = {
  writableLayerSize: 'template-default',
  vcpus: 'template-default',
  memory: 'template-default',
};

await mkdir(logDirectory, { recursive: true, mode: 0o700 });
await writeFile(logPath, '', { mode: 0o600 });
await chmod(logPath, 0o600);

function redact(value: string): string {
  return value
    .replace(/(https?:\/\/)[^/@\s]+:[^/@\s]+@/gi, '$1[redacted]@')
    .replace(/([?&](?:token|key|password|secret)=)[^&\s]+/gi, '$1[redacted]')
    .replace(/(DevTools listening on ws:\/\/)[^\s]+/g, '$1[redacted]')
    .replace(/(\/devtools\/browser\/)[A-Za-z0-9_-]+/g, '$1[redacted]');
}

function log(stage: string, fields: Record<string, unknown> = {}): void {
  const row = JSON.stringify({ timestamp: new Date().toISOString(), runId, elapsedMs: Date.now() - startedAt, stage, ...fields });
  process.stdout.write(row + '\n');
  appendFileSync(logPath, row + '\n', { mode: 0o600 });
}

function failMessage(error: unknown): string {
  return redact(error instanceof Error ? error.message : String(error)).slice(0, 1800);
}

async function captureGuestFailureDetails(stage: string): Promise<void> {
  if (!sandbox) return;
  const command = String.raw`set +e
printf 'failure_stage=%s\n' '${stage}'
printf 'desktop_state='; for path in /var/lib/csa-desktop/ready /var/lib/csa-desktop/bootstrap.exitcode /var/lib/csa-desktop/bootstrap.pid /var/lib/csa-desktop/session.pid; do if [ -e "$path" ]; then printf '%s=' "$path"; cat "$path" 2>/dev/null | head -c 300; printf '\n'; else printf '%s=missing\n' "$path"; fi; done
printf '\nlisteners=\n'; ss -lntp 2>/dev/null | awk 'NR == 1 || $4 ~ /:(6080|5900|9222)$/ { print }' | head -20
printf '\nprocesses=\n'; ps -eo pid,ppid,stat,etimes,args | awk '/csa-desktop-session|chrome-cdp-pipe-bridge|google\/chrome\/chrome|\/opt\/google\/chrome\/chrome/ && !/awk/ { print }' | head -30
for path in /var/lib/csa-desktop/bootstrap.status /var/lib/csa-desktop/bootstrap.log /tmp/csa-desktop-session.log /tmp/csa-chromium.log; do if [ -f "$path" ]; then printf '\n--- %s ---\n' "$path"; tail -n 100 "$path"; fi; done
printf '\ncdp_probe='; curl --noproxy '*' -sS --connect-timeout 1 --max-time 4 -o /tmp/csa-failure-version.json -w 'http=%{http_code} time=%{time_total}s\n' http://127.0.0.1:9222/json/version 2>&1; cat /tmp/csa-failure-version.json 2>/dev/null | sed -E 's#ws://127.0.0.1:9222/devtools/browser/[^\"]+#ws://127.0.0.1:9222/devtools/browser/[redacted]#g'
exit 0`;
  try {
    const result = await sandbox.commands.run(command, { timeoutMs: 30_000 });
    log('guest.failure.capture', {
      sandboxId: sandbox.sandboxId,
      stage,
      exitCode: result.exitCode,
      outputTail: redact(`${result.stdout || ''}${result.stderr || ''}`).trim().slice(-10_000),
    });
  } catch (error) {
    log('guest.failure.capture.failed', { sandboxId: sandbox.sandboxId, stage, error: failMessage(error) });
  }
}

if (!templateId || !/^tpl-[a-z0-9]+$/.test(templateId)) throw new Error('Set CSA_CHROME_BRIDGE_TEMPLATE_ID to a READY Cube template ID.');
if (!apiUrl) throw new Error('Set CUBE_API_URL in the external environment file.');
if (!Number.isSafeInteger(proxyPort) || proxyPort < 1 || proxyPort > 65535) throw new Error('CUBE_PROXY_PORT_HTTP must be a valid TCP port.');
if (!['pipe', 'legacy-http'].includes(chromeTransport)) throw new Error('CSA_DIAGNOSTIC_CHROME_TRANSPORT must be pipe or legacy-http.');
if (!Number.isSafeInteger(cdpTimeoutSeconds) || cdpTimeoutSeconds < 30 || cdpTimeoutSeconds > 3600) throw new Error('CSA_DIAGNOSTIC_CDP_TIMEOUT_SECONDS must be between 30 and 3600.');

const config = new Config({ apiUrl, apiKey, proxyNodeIp, proxyPort, proxyScheme, sandboxDomain, requestTimeoutMs: 30_000 });
const scripts = [
  ['/tmp/csa-desktop-bootstrap.sh', await readFile(new URL('./bootstrap-linux-desktop.sh', import.meta.url), 'utf8')],
  ['/tmp/csa-launch-desktop-bootstrap.sh', await readFile(new URL('./launch-linux-desktop-bootstrap.sh', import.meta.url), 'utf8')],
  ['/tmp/csa-desktop-session.sh', await readFile(new URL('./csa-desktop-session.sh', import.meta.url), 'utf8')],
] as const;
const browserProbe = String.raw`const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
const base = 'http://127.0.0.1:9222';
if (typeof WebSocket !== 'function') throw new Error('Node.js WebSocket is unavailable.');
const versionResponse = await fetch(base + '/json/version', { signal: AbortSignal.timeout(7000) });
if (!versionResponse.ok) throw new Error('CDP /json/version returned HTTP ' + versionResponse.status);
const version = await versionResponse.json();
const listResponse = await fetch(base + '/json/list', { signal: AbortSignal.timeout(7000) });
if (!listResponse.ok) throw new Error('CDP /json/list returned HTTP ' + listResponse.status);
const targets = await listResponse.json();
if (!Array.isArray(targets)) throw new Error('CDP target list is not an array.');
const createResponse = await fetch(base + '/json/new?url=' + encodeURIComponent('about:blank'), { method: 'PUT', signal: AbortSignal.timeout(20000) });
if (!createResponse.ok) throw new Error('CDP /json/new returned HTTP ' + createResponse.status);
const page = await createResponse.json();
if (!page.webSocketDebuggerUrl) throw new Error('CDP page target did not include a WebSocket URL.');
const socket = new WebSocket(page.webSocketDebuggerUrl);
const pending = new Map();
let nextId = 0;
socket.addEventListener('message', event => {
  let message;
  try { message = JSON.parse(String(event.data)); } catch { return; }
  if (!Number.isSafeInteger(message.id)) return;
  const entry = pending.get(message.id);
  if (!entry) return;
  pending.delete(message.id);
  clearTimeout(entry.timer);
  if (message.error) entry.reject(new Error('CDP ' + entry.method + ' failed: ' + String(message.error.message || message.error.code)));
  else entry.resolve(message.result || {});
});
const opened = new Promise((resolve, reject) => {
  const timer = setTimeout(() => reject(new Error('Page WebSocket open timed out.')), 10000);
  socket.addEventListener('open', () => { clearTimeout(timer); resolve(); }, { once: true });
  socket.addEventListener('error', () => { clearTimeout(timer); reject(new Error('Page WebSocket connection failed.')); }, { once: true });
});
await opened;
function command(method, params = {}, timeoutMs = 15000) {
  const id = ++nextId;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { pending.delete(id); reject(new Error('CDP ' + method + ' timed out.')); }, timeoutMs);
    pending.set(id, { method, timer, resolve, reject });
    socket.send(JSON.stringify({ id, method, params }));
  });
}
try {
  await command('Page.enable');
  await command('Runtime.enable');
  await command('Page.navigate', { url: 'data:text/html,<title>CSA%20Bridge%20E2E</title><body>bridge%20ok</body>' });
  let rendered = '';
  for (let attempt = 0; attempt < 30; attempt++) {
    const result = await command('Runtime.evaluate', { expression: 'document.title + "|" + document.body.innerText', returnByValue: true, awaitPromise: true });
    rendered = String(result.result?.value || '');
    if (rendered === 'CSA Bridge E2E|bridge ok') break;
    await wait(200);
  }
  if (rendered !== 'CSA Bridge E2E|bridge ok') throw new Error('Rendered page content did not match the browser-control probe.');
  const screenshot = await command('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
  const screenshotBytes = Buffer.from(String(screenshot.data || ''), 'base64').byteLength;
  if (screenshotBytes < 1000) throw new Error('CDP screenshot was unexpectedly small.');
  console.log(JSON.stringify({ stage: 'browser.bridge.websocket.complete', product: version.Browser, protocolVersion: version['Protocol-Version'], initialTargetCount: targets.length, pageTargetCreated: true, rendered, screenshotBytes }));
} finally {
  socket.close();
}`;

let sandbox: Sandbox | undefined;
try {
  log('sandbox.create.start', { templateId, ...sandboxShape, internetAccess: true, publicTraffic: false, disposable: true });
  sandbox = await Sandbox.create({
    config,
    template: templateId,
    timeout: NEVER_TIMEOUT,
    allowInternetAccess: true,
    network: { allowPublicTraffic: false, allowOut: ['0.0.0.0/0'] },
    extra: { restartPolicy: 'Never' },
    metadata: { csa_chrome_bridge_diagnostic: 'true', csa_diagnostic_run: runId },
  });
  const info = await sandbox.getInfo();
  if (!sandboxIdPattern.test(sandbox.sandboxId)) throw new Error('Cube returned an invalid diagnostic sandbox ID.');
  log('sandbox.create.complete', { sandboxId: sandbox.sandboxId, templateId: sandbox.templateId, state: String(info.state || 'unknown'), proxyNodeIp, proxyPort });

  const envdDeadline = Date.now() + 120_000;
  let envdReady = false;
  while (Date.now() < envdDeadline) {
    try {
      const probe = await sandbox.commands.run('printf "csa_envd_command_ready\\n"', { timeoutMs: 10_000 });
      const output = redact(`${probe.stdout || ''}${probe.stderr || ''}`).trim();
      if (probe.exitCode === 0 && output.includes('csa_envd_command_ready')) {
        envdReady = true;
        log('guest.envd.ready', { sandboxId: sandbox.sandboxId, elapsedMs: Date.now() - startedAt });
        break;
      }
      log('guest.envd.probe', { sandboxId: sandbox.sandboxId, exitCode: probe.exitCode, output: output.slice(-500) });
    } catch (error) {
      log('guest.envd.probe.retry', { sandboxId: sandbox.sandboxId, error: failMessage(error) });
    }
    await new Promise(resolve => setTimeout(resolve, 3_000));
  }
  if (!envdReady) throw new Error('Cube returned a running sandbox, but its envd command API did not become ready within two minutes.');

  const preflight = await sandbox.commands.run(
    'set +e; for path in /etc/csa-super-agent/desktop-image.json /opt/csa-agent-runtime/chrome-cdp-pipe-bridge.cjs /usr/local/bin/csa-desktop-session /opt/csa-agent-runtime/bin/node; do if [ -s "$path" ] || [ -x "$path" ]; then printf "present %s\\n" "$path"; else printf "missing %s\\n" "$path"; fi; done; google-chrome-stable --version 2>&1; /opt/csa-agent-runtime/bin/node --version 2>&1; exit 0',
    { timeoutMs: 30_000 },
  );
  const preflightOutput = redact(`${preflight.stdout || ''}${preflight.stderr || ''}`).trim();
  log('guest.image.preflight', { sandboxId: sandbox.sandboxId, exitCode: preflight.exitCode, output: preflightOutput.slice(-1500) });
  if (preflight.exitCode !== 0 || preflightOutput.includes('missing ')) {
    throw new Error('The READY template does not contain the preinstalled desktop and Chrome pipe bridge.');
  }

  for (const [path, contents] of scripts) {
    log('guest.script.stage.start', { path, bytes: Buffer.byteLength(contents) });
    await sandbox.files.write(path, contents);
    log('guest.script.stage.complete', { path });
  }
  const probePath = '/tmp/csa-chrome-bridge-websocket-probe.mjs';
  await sandbox.files.write(probePath, browserProbe);
  if (chromeTransport === 'legacy-http') {
    log('guest.chrome.transport-control.start', { sandboxId: sandbox.sandboxId, transport: chromeTransport, action: 'hide-bridge-in-disposable-clone' });
    const transportControl = await sandbox.commands.run(
      'mv /opt/csa-agent-runtime/chrome-cdp-pipe-bridge.cjs /opt/csa-agent-runtime/chrome-cdp-pipe-bridge.cjs.diagnostic-disabled',
      { timeoutMs: 10_000 },
    );
    log('guest.chrome.transport-control.complete', { sandboxId: sandbox.sandboxId, exitCode: transportControl.exitCode });
    if (transportControl.exitCode !== 0) throw new Error('Could not select the standard Chrome remote-debugging-port control path.');
  }
  const guestEnvironment = {
    CSA_TENANT_ID: 'bridge-diagnostic',
    CSA_CUBE_SANDBOX_ID: sandbox.sandboxId,
    CSA_COMPUTER_GENERATION: '1',
    CSA_RUN_ID: runId,
    CSA_FORCE_DESKTOP_BOOTSTRAP: '1',
    CSA_DESKTOP_CHROME_CDP_TIMEOUT_SECONDS: String(cdpTimeoutSeconds),
    COKE_DESKTOP_RESOLUTION: '1280x800',
  };
  log('desktop.bootstrap.launch.start', { sandboxId: sandbox.sandboxId, envNames: Object.keys(guestEnvironment).sort().join(','), cdpTimeoutSeconds, chromeTransport });
  const launch = await sandbox.commands.run(
    `env ${Object.entries(guestEnvironment).map(([key, value]) => `${key}='${value}'`).join(' ')} bash /tmp/csa-launch-desktop-bootstrap.sh`,
    { timeoutMs: 30_000 },
  );
  log('desktop.bootstrap.launch.complete', { sandboxId: sandbox.sandboxId, exitCode: launch.exitCode, outputTail: redact(`${launch.stdout || ''}${launch.stderr || ''}`).trim().slice(-1200) });
  if (launch.exitCode !== 0) throw new Error('The product desktop bootstrap launcher did not start.');

  const desktopDeadline = Date.now() + 8 * 60_000;
  let lastHeartbeatAt = 0;
  let ready = false;
  while (Date.now() < desktopDeadline) {
    if (await sandbox.files.exists('/var/lib/csa-desktop/ready')) {
      ready = true;
      log('desktop.bootstrap.ready-marker', { sandboxId: sandbox.sandboxId, elapsedMs: Date.now() - startedAt });
      break;
    }
    if (await sandbox.files.exists('/var/lib/csa-desktop/bootstrap.exitcode')) {
      const exitCode = String(await sandbox.files.read('/var/lib/csa-desktop/bootstrap.exitcode')).trim();
      const [bootstrapLog, sessionLog, chromeLog, imageManifest] = await Promise.all([
        sandbox.files.read('/var/lib/csa-desktop/bootstrap.log').catch(() => ''),
        sandbox.files.read('/tmp/csa-desktop-session.log').catch(() => ''),
        sandbox.files.read('/tmp/csa-chromium.log').catch(() => ''),
        sandbox.files.read('/etc/csa-super-agent/desktop-image.json').catch(() => ''),
      ]);
      log('desktop.bootstrap.failed', {
        sandboxId: sandbox.sandboxId,
        exitCode,
        imageManifest: redact(String(imageManifest)).slice(0, 1200),
        bootstrapLogTail: redact(String(bootstrapLog)).slice(-5000),
        sessionLogTail: redact(String(sessionLog)).slice(-5000),
        chromeLogTail: redact(String(chromeLog)).slice(-5000),
      });
      await captureGuestFailureDetails('desktop.bootstrap.failed');
      throw new Error(`Desktop bootstrap exited with ${exitCode || 'an unknown code'}.`);
    }
    if (Date.now() - lastHeartbeatAt >= 30_000) {
      const status = await sandbox.files.read('/var/lib/csa-desktop/bootstrap.status').catch(() => 'status file not written yet');
      log('desktop.bootstrap.heartbeat', { sandboxId: sandbox.sandboxId, elapsedMs: Date.now() - startedAt, status: redact(String(status)).trim().slice(-700) });
      lastHeartbeatAt = Date.now();
    }
    await new Promise(resolve => setTimeout(resolve, 5_000));
  }
  if (!ready) throw new Error('Product desktop bootstrap exceeded its bounded 8 minute diagnostic window.');

  const bridgeProbe = await sandbox.commands.run(`/opt/csa-agent-runtime/bin/node ${probePath}`, { timeoutMs: 90_000, cwd: '/tmp' });
  const bridgeOutput = redact(`${bridgeProbe.stdout || ''}${bridgeProbe.stderr || ''}`).trim();
  log('browser.bridge.websocket.probe', { sandboxId: sandbox.sandboxId, exitCode: bridgeProbe.exitCode, output: bridgeOutput.slice(-2000) });
  if (bridgeProbe.exitCode !== 0 || !bridgeOutput.includes('browser.bridge.websocket.complete')) {
    await captureGuestFailureDetails('browser.bridge.websocket.probe');
    throw new Error('HTTP and WebSocket CDP browser-control verification did not complete.');
  }
  log('diagnostic.complete', { sandboxId: sandbox.sandboxId, templateId, chromeTransport, browserControl: 'HTTP discovery, page WebSocket, navigate, evaluate and screenshot' });
} catch (error) {
  log('diagnostic.failed', { sandboxId: sandbox?.sandboxId || 'not-created', error: failMessage(error) });
  process.exitCode = 1;
} finally {
  if (sandbox) {
    try {
      log('sandbox.cleanup.start', { sandboxId: sandbox.sandboxId });
      await sandbox.kill();
      log('sandbox.cleanup.complete', { sandboxId: sandbox.sandboxId });
    } catch (error) {
      log('sandbox.cleanup.failed', { sandboxId: sandbox.sandboxId, error: failMessage(error) });
      process.exitCode = 1;
    }
    sandbox.close();
  }
  log('diagnostic.log', { path: logPath });
}
