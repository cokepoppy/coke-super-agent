import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { Sandbox } from '@cubesandbox/sdk';
import { pool } from '../../src/server/db.ts';
import { cubeConfig } from '../../src/server/computer.ts';
import { decryptSandboxTrafficToken } from '../../src/server/token-crypto.ts';
import { runGuestPty } from '../../src/server/runtime-bundle.ts';

const tenantId = process.env.CSA_DIAGNOSTIC_TENANT_ID;
if (!tenantId) throw new Error('Set CSA_DIAGNOSTIC_TENANT_ID to an existing tenant UUID.');

const port = Number(process.env.CSA_CHROMIUM_CDP_PORT || '19350');
const startupTimeoutSeconds = Number(process.env.CSA_CHROMIUM_STARTUP_TIMEOUT_SECONDS || '160');
const probeIntervalSeconds = Number(process.env.CSA_CHROMIUM_PROBE_INTERVAL_SECONDS || '5');
const websocketStrace = process.env.CSA_CHROMIUM_WEBSOCKET_STRACE || '1';
const httpProbes = process.env.CSA_CHROMIUM_HTTP_PROBES || '1';
const threadSample = process.env.CSA_CHROMIUM_THREAD_SAMPLE || '0';
const gdbSample = process.env.CSA_CHROMIUM_GDB_SAMPLE || '0';
const gdbTimeoutSeconds = Number(process.env.CSA_CHROMIUM_GDB_TIMEOUT_SECONDS || '20');
const straceSample = process.env.CSA_CHROMIUM_STRACE_SAMPLE || '0';
const straceTimeoutSeconds = Number(process.env.CSA_CHROMIUM_STRACE_TIMEOUT_SECONDS || '4');
const dbusSession = process.env.CSA_CHROMIUM_DBUS_SESSION || '0';
const perfSample = process.env.CSA_CHROMIUM_PERF_SAMPLE || '0';
const perfBundlePath = process.env.CSA_CHROMIUM_PERF_BUNDLE_PATH
  || join(homedir(), '.local/share/csa-cube-node/runtime-cache/linux-perf-rootfs-minimal-bookworm-arm64.tar.gz');
const perfBundleSha256 = 'aafb31b32042acb4ae6533f222f3553d8735b6789807088750e95418799136de';
const websocketProbes = process.env.CSA_CHROMIUM_WEBSOCKET_PROBES || '1';
const traceStartup = process.env.CSA_CHROMIUM_TRACE_STARTUP || '0';
const noSandbox = process.env.CSA_CHROMIUM_NO_SANDBOX || '1';
const dumpDomOnly = process.env.CSA_CHROMIUM_DUMP_DOM_ONLY || '0';
const dumpDomTimeoutSeconds = Number(process.env.CSA_CHROMIUM_DUMP_DOM_TIMEOUT_SECONDS || '30');
const dumpDomUrl = process.env.CSA_CHROMIUM_DUMP_DOM_URL || 'about:blank';
const dumpDomSampleDelaySeconds = Number(process.env.CSA_CHROMIUM_DUMP_DOM_SAMPLE_DELAY_SECONDS || '5');
const dumpDomSampleGapSeconds = Number(process.env.CSA_CHROMIUM_DUMP_DOM_SAMPLE_GAP_SECONDS || '3');
const dumpDomSampleStacks = process.env.CSA_CHROMIUM_DUMP_DOM_SAMPLE_STACKS || '1';
const dumpDomIdentitySample = process.env.CSA_CHROMIUM_DUMP_DOM_IDENTITY_SAMPLE || '1';
const noZygote = process.env.CSA_CHROMIUM_NO_ZYGOTE || '0';
const diagnosticUser = process.env.CSA_DIAGNOSTIC_USER || 'user';
const chromeBinary = process.env.CSA_CHROMIUM_BIN || '/opt/google/chrome/chrome';
const traceExportName = process.env.CSA_CHROMIUM_TRACE_EXPORT_NAME || '';
if (!Number.isSafeInteger(port) || port < 1024 || port > 65535) throw new Error('Invalid diagnostic CDP port.');
if (!Number.isSafeInteger(startupTimeoutSeconds) || startupTimeoutSeconds < 10 || startupTimeoutSeconds > 180) {
  throw new Error('Invalid Chromium startup timeout.');
}
if (!Number.isSafeInteger(probeIntervalSeconds) || probeIntervalSeconds < 1 || probeIntervalSeconds > 9) {
  throw new Error('Invalid Chromium probe interval.');
}
if (websocketStrace !== '0' && websocketStrace !== '1') throw new Error('Invalid WebSocket strace flag.');
if (httpProbes !== '0' && httpProbes !== '1') throw new Error('Invalid HTTP probes flag.');
if (threadSample !== '0' && threadSample !== '1') throw new Error('Invalid thread sample flag.');
if (gdbSample !== '0' && gdbSample !== '1') throw new Error('Invalid GDB sample flag.');
if (!Number.isSafeInteger(gdbTimeoutSeconds) || gdbTimeoutSeconds < 5 || gdbTimeoutSeconds > 45) throw new Error('Invalid GDB timeout.');
if (straceSample !== '0' && straceSample !== '1') throw new Error('Invalid strace sample flag.');
if (!Number.isSafeInteger(straceTimeoutSeconds) || straceTimeoutSeconds < 2 || straceTimeoutSeconds > 8) throw new Error('Invalid strace timeout.');
if (dbusSession !== '0' && dbusSession !== '1') throw new Error('Invalid D-Bus session flag.');
if (perfSample !== '0' && perfSample !== '1') throw new Error('Invalid perf sample flag.');
if (perfSample === '1' && (dumpDomOnly === '1' || gdbSample === '1' || straceSample === '1')) {
  throw new Error('Perf sampling requires the CDP diagnostic and cannot be combined with GDB or strace.');
}
if (websocketProbes !== '0' && websocketProbes !== '1') throw new Error('Invalid WebSocket probes flag.');
if (traceStartup !== '0' && traceStartup !== '1') throw new Error('Invalid startup trace flag.');
if (noSandbox !== '0' && noSandbox !== '1') throw new Error('Invalid no-sandbox flag.');
if (dumpDomOnly !== '0' && dumpDomOnly !== '1') throw new Error('Invalid dump-dom-only flag.');
if (!['about:blank', 'data:text/html,CSA_RENDER_PROBE'].includes(dumpDomUrl)) throw new Error('Invalid dump-dom URL.');
if (!Number.isSafeInteger(dumpDomTimeoutSeconds) || dumpDomTimeoutSeconds < 10 || dumpDomTimeoutSeconds > 45) throw new Error('Invalid dump-dom timeout.');
if (!Number.isSafeInteger(dumpDomSampleDelaySeconds) || dumpDomSampleDelaySeconds < 5 || dumpDomSampleDelaySeconds > 15) throw new Error('Invalid dump-dom sample delay.');
if (!Number.isSafeInteger(dumpDomSampleGapSeconds) || dumpDomSampleGapSeconds < 3 || dumpDomSampleGapSeconds > 10 || dumpDomSampleDelaySeconds + dumpDomSampleGapSeconds >= dumpDomTimeoutSeconds - 2) throw new Error('Invalid dump-dom sample gap.');
if (dumpDomSampleStacks !== '0' && dumpDomSampleStacks !== '1') throw new Error('Invalid dump-dom stack-sample flag.');
if (dumpDomIdentitySample !== '0' && dumpDomIdentitySample !== '1') throw new Error('Invalid dump-dom identity-sample flag.');
if (noZygote !== '0' && noZygote !== '1') throw new Error('Invalid no-zygote flag.');
if (!/^[a-z_][a-z0-9_-]{0,30}\$?$/i.test(diagnosticUser)) throw new Error('Invalid diagnostic desktop username.');
if (!chromeBinary.startsWith('/') || chromeBinary.includes('\0')) throw new Error('CSA_CHROMIUM_BIN must be an absolute guest path.');
if (traceExportName && !/^[a-zA-Z0-9._-]{1,120}\.json$/.test(traceExportName)) throw new Error('Invalid trace export filename.');
const traceExportPath = traceExportName
  ? join(homedir(), '.local/share/csa-cube-node/build-logs', traceExportName)
  : '';
const tag = `websocket-${new Date().toISOString().replace(/[-:.TZ]/g, '').slice(0, 14)}`;
const gdbBundlePath = process.env.CSA_CHROMIUM_GDB_BUNDLE_PATH || '';
const gdbBundleSha256 = '33c0188b5165b050feedd732e109149803aadd722fbabbab4fdba633848e1b04';
const straceBundlePath = process.env.CSA_CHROMIUM_STRACE_BUNDLE_PATH || join(homedir(), '.local/share/csa-cube-node/runtime-cache/strace_6.1-0.1_arm64.deb');
const straceBundleSha256 = '751817724af91cb95df566a21a154f9a7dcdd938e700e5cb9a5a47eb19752ea2';
let gdbBundleBytes: Buffer | undefined;
if (gdbBundlePath) {
  if (gdbSample !== '1') throw new Error('Set CSA_CHROMIUM_GDB_SAMPLE=1 to use the offline GDB bundle.');
  gdbBundleBytes = await readFile(gdbBundlePath);
  const actualSha256 = createHash('sha256').update(gdbBundleBytes).digest('hex');
  if (actualSha256 !== gdbBundleSha256) throw new Error(`GDB bundle SHA-256 mismatch: expected ${gdbBundleSha256}, got ${actualSha256}.`);
}
let straceBundleBytes: Buffer | undefined;
if (straceSample === '1') {
  if (dumpDomOnly !== '1') throw new Error('Strace sampling is currently scoped to the no-CDP dump-dom probe.');
  if (gdbSample === '1') throw new Error('Choose one ptrace sampler at a time.');
  straceBundleBytes = await readFile(straceBundlePath);
  const actualSha256 = createHash('sha256').update(straceBundleBytes).digest('hex');
  if (actualSha256 !== straceBundleSha256) throw new Error(`strace package SHA-256 mismatch: expected ${straceBundleSha256}, got ${actualSha256}.`);
}
let perfBundleBytes: Buffer | undefined;
if (perfSample === '1') {
  perfBundleBytes = await readFile(perfBundlePath);
  const actualSha256 = createHash('sha256').update(perfBundleBytes).digest('hex');
  if (actualSha256 !== perfBundleSha256) throw new Error(`perf bundle SHA-256 mismatch: expected ${perfBundleSha256}, got ${actualSha256}.`);
}
const remoteGdbBundlePath = '/tmp/csa-chromium-gdb-rootfs.tar.gz';
const remoteStraceBundlePath = '/tmp/csa-chromium-strace_6.1-0.1_arm64.deb';
const remotePerfBundlePath = '/tmp/csa-linux-perf-rootfs-minimal-bookworm-arm64.tar.gz';
const remoteGdbSetup = gdbBundleBytes ? String.raw`gdb_bundle='${remoteGdbBundlePath}'
gdb_root=''
cleanup_csa_gdb() {
  rm -f -- "$gdb_bundle" /tmp/gdb '/tmp/csa-${tag}.sh'
  if [ -n "$gdb_root" ] && [ -d "$gdb_root" ]; then find "$gdb_root" -depth -delete; fi
}
trap cleanup_csa_gdb EXIT
if [ ! -s "$gdb_bundle" ]; then echo 'gdb.bundle.missing'; exit 90; fi
gdb_available_kb="$(df -Pk / | awk 'NR == 2 {print $4}')"
if [[ ! "$gdb_available_kb" =~ ^[0-9]+$ ]] || ((gdb_available_kb < 524288)); then echo "stage=gdb.bundle.failed phase=preflight reason=disk-below-512MiB available_kb=$gdb_available_kb"; exit 92; fi
gdb_root="/tmp/csa-chromium-gdb-${tag}"
install -d -m 0700 "$gdb_root"
echo "stage=gdb.bundle.extract.start root=$gdb_root available_kb=$gdb_available_kb"
gdb_extract_started=$SECONDS
timeout --signal=TERM --kill-after=2s 45s tar --no-same-owner -xzf "$gdb_bundle" -C "$gdb_root"
echo "stage=gdb.bundle.extract.complete elapsed_seconds=$((SECONDS - gdb_extract_started))"
gdb_binary="$gdb_root/gdb-rootfs/usr/bin/gdb"
gdb_data="$gdb_root/gdb-rootfs/usr/share/gdb"
gdb_libraries="$gdb_root/gdb-rootfs/usr/lib/aarch64-linux-gnu:$gdb_root/gdb-rootfs/lib/aarch64-linux-gnu:$gdb_root/gdb-rootfs/usr/lib:$gdb_root/gdb-rootfs/lib"
cat >/tmp/gdb <<CSA_GDB_WRAPPER
#!/bin/sh
export LD_LIBRARY_PATH='$gdb_libraries'
exec '$gdb_binary' --data-directory '$gdb_data' "\$@"
CSA_GDB_WRAPPER
chmod 0700 /tmp/gdb
echo 'stage=gdb.bundle.version-check.start'
gdb_version_started=$SECONDS
if timeout --signal=INT --kill-after=2s 30s /tmp/gdb --version >"$gdb_root/version-check.log" 2>&1; then echo "stage=gdb.bundle.ready elapsed_seconds=$((SECONDS - gdb_version_started)) version=$(head -n 1 "$gdb_root/version-check.log")"; else gdb_version_status=$?; sed -n '1,16p' "$gdb_root/version-check.log"; echo "stage=gdb.bundle.failed phase=version-check exit_code=$gdb_version_status"; exit 91; fi
PATH="/tmp:$PATH"; export PATH` : '';
const remoteStraceSetup = straceBundleBytes ? String.raw`strace_bundle='${remoteStraceBundlePath}'
strace_root="/tmp/csa-chromium-strace-${tag}"
cleanup_csa_strace() {
  rm -f -- "$strace_bundle"
  if [ -d "$strace_root" ]; then find "$strace_root" -depth -delete; fi
}
trap cleanup_csa_strace EXIT
strace_available_kb="$(df -Pk / | awk 'NR == 2 {print $4}')"
if [[ ! "$strace_available_kb" =~ ^[0-9]+$ ]] || ((strace_available_kb < 524288)); then echo "stage=strace.bundle.failed reason=disk-below-512MiB available_kb=$strace_available_kb"; exit 92; fi
if ! command -v dpkg-deb >/dev/null 2>&1; then echo 'stage=strace.bundle.failed reason=dpkg-deb-missing'; exit 93; fi
install -d -m 0700 "$strace_root"
echo "stage=strace.bundle.extract.start root=$strace_root bytes=$(stat -c %s "$strace_bundle")"
timeout --signal=TERM --kill-after=1s 15s dpkg-deb -x "$strace_bundle" "$strace_root"
strace_binary="$strace_root/usr/bin/strace"
if [[ ! -x "$strace_binary" ]]; then echo 'stage=strace.bundle.failed reason=binary-missing'; exit 94; fi
strace_version_started=$SECONDS
echo 'stage=strace.bundle.version-check.start timeout_seconds=10'
if timeout --signal=TERM --kill-after=1s 10s "$strace_binary" --version >"$strace_root/version.log" 2>&1; then echo "stage=strace.bundle.ready elapsed_seconds=$((SECONDS - strace_version_started)) version=$(head -n 1 "$strace_root/version.log")"; else strace_status=$?; sed -n '1,8p' "$strace_root/version.log"; echo "stage=strace.bundle.failed phase=version-check exit_code=$strace_status elapsed_seconds=$((SECONDS - strace_version_started))"; exit 95; fi
PATH="$strace_root/usr/bin:$PATH"; export PATH` : '';
const remotePerfSetup = perfBundleBytes ? String.raw`perf_bundle='${remotePerfBundlePath}'
perf_root="/tmp/csa-chromium-perf-${tag}"
perf_cleanup() {
  if [ -d "$perf_root" ]; then find "$perf_root" -depth -delete; fi
  if [ -f "$perf_bundle" ]; then find "$perf_bundle" -maxdepth 0 -delete; fi
}
trap perf_cleanup EXIT
perf_available_kb="$(df -Pk / | awk 'NR == 2 {print $4}')"
if [[ ! "$perf_available_kb" =~ ^[0-9]+$ ]] || ((perf_available_kb < 524288)); then echo "stage=perf.bundle.failed reason=disk-below-512MiB available_kb=$perf_available_kb"; exit 92; fi
perf_actual_sha256="$(sha256sum "$perf_bundle" | awk '{print $1}')"
if [[ "$perf_actual_sha256" != '${perfBundleSha256}' ]]; then echo "stage=perf.bundle.failed reason=guest-checksum-mismatch actual_sha256=$perf_actual_sha256"; exit 96; fi
if ! command -v tar >/dev/null 2>&1; then echo 'stage=perf.bundle.failed reason=tar-missing'; exit 97; fi
install -d -m 0700 "$perf_root"
echo "stage=perf.bundle.extract.start path=$perf_root bytes=$(stat -c %s "$perf_bundle") available_kb=$perf_available_kb source=bookworm-rootfs"
perf_extract_started=$SECONDS
perf_extract_exit=0
timeout --signal=TERM --kill-after=2s 30s tar --no-same-owner -xzf "$perf_bundle" -C "$perf_root" >"$perf_root/extract.stdout" 2>"$perf_root/extract.stderr" || perf_extract_exit=$?
if ((perf_extract_exit != 0)); then sed -n '1,20p' "$perf_root/extract.stderr"; echo "stage=perf.bundle.failed reason=extract exit_code=$perf_extract_exit"; exit 93; fi
echo "stage=perf.bundle.extract.complete elapsed_seconds=$((SECONDS - perf_extract_started))"
perf_binary="$perf_root/perf-root/usr/bin/perf"
perf_compat_libs="$perf_root/compat-libraries"
if [[ ! -x "$perf_binary" ]]; then echo 'stage=perf.bundle.failed reason=binary-missing'; exit 94; fi
install -d -m 0700 "$perf_compat_libs"
for perf_library_dir in "$perf_root/perf-root/usr/lib/aarch64-linux-gnu" "$perf_root/perf-root/lib/aarch64-linux-gnu" "$perf_root/perf-root/usr/lib" "$perf_root/perf-root/lib"; do
  [[ -d "$perf_library_dir" ]] || continue
  for perf_library in "$perf_library_dir"/*; do
    [[ -e "$perf_library" ]] || continue
    perf_library_name="$(basename "$perf_library")"
    case "$perf_library_name" in libstdc++.so.6|libgcc_s.so.1|libcrypt.so.1|libexpat.so.1) continue ;; esac
    ln -sfn "$perf_library" "$perf_compat_libs/$perf_library_name"
  done
done
perf_ldd_exit=0
perf_ldd="$(env LD_LIBRARY_PATH="$perf_compat_libs" ldd "$perf_binary" 2>&1)" || perf_ldd_exit=$?
perf_missing_libraries="$(printf '%s\n' "$perf_ldd" | awk '$2 == "=>" && $3 == "not" && $4 == "found" {print $1}' | tr '\n' ',')"
perf_missing_symbols="$(printf '%s\n' "$perf_ldd" | grep -o 'version .\{1,40\} not found' | tr '\n' ',')"
if ((perf_ldd_exit != 0)) || [[ -n "$perf_missing_libraries" || -n "$perf_missing_symbols" ]]; then echo "stage=perf.bundle.failed reason=library-compatibility ldd_exit_code=$perf_ldd_exit missing_libraries=$perf_missing_libraries missing_symbols=$perf_missing_symbols detail=$(printf '%s' "$perf_ldd" | tr '\n' ' ' | cut -c1-1200)"; exit 98; fi
perf_version_exit=0
perf_version="$(timeout --signal=TERM --kill-after=1s 8s env LD_LIBRARY_PATH="$perf_compat_libs" PAGER=cat PERF_PAGER=cat "$perf_binary" --version 2>&1)" || perf_version_exit=$?
if ((perf_version_exit != 0)) || [[ "$perf_version" != *'perf version 6.1.192'* ]]; then echo "stage=perf.bundle.failed reason=version-check exit_code=$perf_version_exit output=$(printf '%s' "$perf_version" | tr '\n' ' ' | cut -c1-320)"; exit 95; fi
install -d -m 0700 "$perf_root/bin"
cat >"$perf_root/bin/perf" <<CSA_PERF_WRAPPER
#!/bin/sh
export LD_LIBRARY_PATH='$perf_compat_libs'
exec '$perf_binary' "\$@"
CSA_PERF_WRAPPER
chmod 0700 "$perf_root/bin/perf"
PATH="$perf_root/bin:$PATH"; export PATH
echo "stage=perf.bundle.ready version=$(printf '%s' "$perf_version" | head -n 1) path=$perf_binary"` : '';

const shellQuote = (value: string): string => "'" + value.replace(/'/g, "'\\''") + "'";

const [rows] = await pool.query(
  `SELECT c.sandbox_id, c.cube_traffic_token_ciphertext, c.state, c.desktop_state, c.generation,
          (SELECT COUNT(*) FROM runs r WHERE r.tenant_id = c.tenant_id AND r.status IN ('queued', 'working')) AS active_runs
     FROM computers c WHERE c.tenant_id = ? LIMIT 1`,
  [tenantId],
);
await pool.end();

const computer = (rows as Array<{
  sandbox_id: string | null;
  cube_traffic_token_ciphertext: string | null;
  state: string;
  desktop_state: string;
  generation: number;
  active_runs: number;
}>)[0];
if (!computer?.sandbox_id || computer.state !== 'running' || !computer.cube_traffic_token_ciphertext) {
  throw new Error('The selected tenant must have a running microVM and a stored traffic token.');
}
if (Number(computer.active_runs) !== 0) throw new Error('The selected tenant has an active Agent run; refusing Chromium diagnostics.');
process.stdout.write(`diagnostic.preflight tenant_id=${tenantId} sandbox_id=${computer.sandbox_id} state=${computer.state} desktop_state=${computer.desktop_state} generation=${computer.generation} active_runs=${computer.active_runs}\n`);

const script = await readFile(new URL(dumpDomOnly === '1' ? './diagnose-chromium-dump-dom.sh' : './diagnose-chromium-headless.sh', import.meta.url));
const remoteScript = `/tmp/csa-${tag}.sh`;
const encodedScript = script.toString('base64');
const cleanupCommands = [`rm -f -- ${remoteScript}`];
if (gdbBundleBytes) cleanupCommands.push('cleanup_csa_gdb');
if (straceBundleBytes) cleanupCommands.push('cleanup_csa_strace');
if (perfBundleBytes) cleanupCommands.push('perf_cleanup');
const remoteCleanupTrap = `trap ${shellQuote(cleanupCommands.join('; '))} EXIT`;
const guestInvocation = dumpDomOnly === '1'
  ? `CSA_DIAGNOSTIC_USER=${shellQuote(diagnosticUser)} CSA_CHROMIUM_BIN=${shellQuote(chromeBinary)} CSA_CHROMIUM_DIAGNOSTIC_TAG='${tag}' CSA_CHROMIUM_DUMP_DOM_URL=${shellQuote(dumpDomUrl)} CSA_CHROMIUM_DUMP_DOM_TIMEOUT_SECONDS='${dumpDomTimeoutSeconds}' CSA_CHROMIUM_DUMP_DOM_SAMPLE_DELAY_SECONDS='${dumpDomSampleDelaySeconds}' CSA_CHROMIUM_DUMP_DOM_SAMPLE_GAP_SECONDS='${dumpDomSampleGapSeconds}' CSA_CHROMIUM_DUMP_DOM_SAMPLE_STACKS='${dumpDomSampleStacks}' CSA_CHROMIUM_DUMP_DOM_IDENTITY_SAMPLE='${dumpDomIdentitySample}' CSA_CHROMIUM_NO_ZYGOTE='${noZygote}' CSA_CHROMIUM_NO_SANDBOX='${noSandbox}' CSA_CHROMIUM_GDB_SAMPLE='${gdbSample}' CSA_CHROMIUM_GDB_TIMEOUT_SECONDS='${gdbTimeoutSeconds}' CSA_CHROMIUM_STRACE_SAMPLE='${straceSample}' CSA_CHROMIUM_STRACE_TIMEOUT_SECONDS='${straceTimeoutSeconds}' bash '${remoteScript}'`
  : `CSA_DIAGNOSTIC_USER=${shellQuote(diagnosticUser)} CSA_CHROMIUM_BIN=${shellQuote(chromeBinary)} CSA_CHROMIUM_TRACE_STARTUP='${traceStartup}' CSA_CHROMIUM_NO_SANDBOX='${noSandbox}' CSA_CHROMIUM_DIAGNOSTIC_TAG='${tag}' CSA_CHROMIUM_CDP_PORT='${port}' CSA_CHROMIUM_STARTUP_TIMEOUT_SECONDS='${startupTimeoutSeconds}' CSA_CHROMIUM_PROBE_INTERVAL_SECONDS='${probeIntervalSeconds}' CSA_CHROMIUM_HTTP_STRACE=0 CSA_CHROMIUM_WEBSOCKET_STRACE='${websocketStrace}' CSA_CHROMIUM_HTTP_PROBES='${httpProbes}' CSA_CHROMIUM_THREAD_SAMPLE='${threadSample}' CSA_CHROMIUM_GDB_SAMPLE='${gdbSample}' CSA_CHROMIUM_GDB_TIMEOUT_SECONDS='${gdbTimeoutSeconds}' CSA_CHROMIUM_DBUS_SESSION='${dbusSession}' bash '${remoteScript}'`;
const remoteCommand = [
  'set -eu',
  remoteGdbSetup,
  remoteStraceSetup,
  remotePerfSetup,
  remoteCleanupTrap,
  "export CSA_CHROMIUM_PERF_SAMPLE='" + perfSample + "'",
  "export CSA_CHROMIUM_WEBSOCKET_PROBES='" + websocketProbes + "'",
  `printf '%s' '${encodedScript}' | base64 -d > '${remoteScript}'`,
  `chmod 700 '${remoteScript}'`,
  guestInvocation,
].join('\n');

let sandbox = await Sandbox.connect(computer.sandbox_id, { config: cubeConfig() });
if (!sandbox.trafficAccessToken) {
  const authenticated = new Sandbox({
    sandboxID: sandbox.sandboxId,
    templateID: sandbox.templateId,
    domain: sandbox.domain,
    trafficAccessToken: decryptSandboxTrafficToken(computer.cube_traffic_token_ciphertext),
    envdAccessToken: sandbox.envdAccessToken,
  }, sandbox.config);
  sandbox.close();
  sandbox = authenticated;
}
if (gdbBundleBytes) {
  process.stdout.write(`gdb.bundle.stage.start sandbox_id=${sandbox.sandboxId} path=${remoteGdbBundlePath} bytes=${gdbBundleBytes.byteLength} sha256=${gdbBundleSha256}\n`);
  await sandbox.files.write(remoteGdbBundlePath, gdbBundleBytes);
  process.stdout.write(`gdb.bundle.stage.complete sandbox_id=${sandbox.sandboxId} path=${remoteGdbBundlePath}\n`);
}
if (straceBundleBytes) {
  process.stdout.write(`strace.bundle.stage.start sandbox_id=${sandbox.sandboxId} path=${remoteStraceBundlePath} bytes=${straceBundleBytes.byteLength} sha256=${straceBundleSha256}\n`);
  await sandbox.files.write(remoteStraceBundlePath, straceBundleBytes);
  process.stdout.write(`strace.bundle.stage.complete sandbox_id=${sandbox.sandboxId} path=${remoteStraceBundlePath}\n`);
}
if (perfBundleBytes) {
  process.stdout.write(`perf.bundle.stage.start sandbox_id=${sandbox.sandboxId} path=${remotePerfBundlePath} bytes=${perfBundleBytes.byteLength} sha256=${perfBundleSha256}\n`);
  await sandbox.files.write(remotePerfBundlePath, perfBundleBytes);
  process.stdout.write(`perf.bundle.stage.complete sandbox_id=${sandbox.sandboxId} path=${remotePerfBundlePath}\n`);
}

const stripAnsi = (value: string): string => value.replace(/\u001b\[[0-9;?]*[A-Za-z]/g, '');
const redacted = (value: string): string => stripAnsi(value)
  .replace(/(DevTools listening on ws:\/\/)[^\s]+/g, '$1[redacted]')
  .replace(/(\/devtools\/browser\/)[A-Za-z0-9_-]+/g, '$1[redacted]');
const stageLine = /(?:diagnostic\.preflight|stage=(?:preflight\.(?:ready|failed)|(?:gdb|strace|perf)\.bundle\.[a-z.]+|chrome\.launch|chrome\.trace\.[a-z.]+|chrome\.dump\.[a-z.]+|process\.sample|thread\.sample|cdp\.listener\.(?:ready|probe|failed)|http\.client\.result|http\.probes\.skipped|thread\.cpu\.[a-z.]+|gdb\.stack\.[a-z.]+|perf\.(?:record|report|stack|top)\.[a-z.]+|cdp\.websocket\.[a-z.]+|chrome\.result|cleanup\.(?:complete|failed|term)|diagnostic\.failed|sequence\.complete))\b/;

if (process.env.CSA_CHROMIUM_CLEAN_PERF_HELPERS === '1') {
  const command = String.raw`set -eu
ps -eo pid=,pgid=,stat=,comm=,args= | awk '$4 == "perf" && ($0 ~ /perf top -h/ || $0 ~ /perf report --stdio --no-children --sort=symbol --percent-limit=1 --max-stack=24 -i \/tmp\/csa-perf-sigint-probe\.data/ || $0 ~ /perf record -h/) {print $1, $2}' | sort -u | while read -r pid pgid; do
  [ -n "$pid" ] || continue
  cmdline="$(tr '\0' ' ' <"/proc/$pid/cmdline" 2>/dev/null || true)"
  case "$cmdline" in
    *"perf top -h"*|*"perf report --stdio --no-children --sort=symbol --percent-limit=1 --max-stack=24 -i /tmp/csa-perf-sigint-probe.data"*|*"perf record -h"*) ;;
    *) printf 'cleanup.skip pid=%s reason=command-changed\n' "$pid"; continue ;;
  esac
  members="$(ps -eo pid=,pgid=,stat=,comm=,args= | awk -v group="$pgid" '$2 == group && $3 !~ /Z|X/')"
  unsafe="$(printf '%s\n' "$members" | awk '$4 !~ /^(perf|sh|pager|less|cat)$/ {print}')"
  printf 'cleanup.group pid=%s pgid=%s members=%s\n' "$pid" "$pgid" "$(printf '%s\n' "$members" | tr '\n' ';' | cut -c1-320)"
  if [ -n "$unsafe" ] || [ -z "$members" ]; then printf 'cleanup.skip pgid=%s reason=unexpected-members\n' "$pgid"; continue; fi
  kill -TERM -- "-$pgid" 2>/dev/null || true
  sleep 1
  remaining="$(ps -eo pid=,pgid=,stat=,comm= | awk -v group="$pgid" '$2 == group && $3 !~ /Z|X/')"
  if [ -n "$remaining" ]; then kill -KILL -- "-$pgid" 2>/dev/null || true; sleep 0.2; fi
  remaining="$(ps -eo pid=,pgid=,stat=,comm= | awk -v group="$pgid" '$2 == group && $3 !~ /Z|X/')"
  printf 'cleanup.result pgid=%s remaining=%s\n' "$pgid" "$(printf '%s' "$remaining" | tr '\n' ';')"
done
ps -eo pid,ppid,pgid,stat,rss,comm | awk '$6 == "perf" || $6 == "pager" {print}'`;
  const result = await runGuestPty(sandbox, command, '/', {}, line => process.stdout.write(`${redacted(line)}\n`), 30_000);
  process.stdout.write(`guest.exit_code=${result.exitCode}\n`);
  sandbox.close();
  process.exit(0);
}

if (process.env.CSA_CHROMIUM_INSPECT_PERF_PROCESSES === '1') {
  const command = String.raw`set +e
ps -eo pid,ppid,pgid,stat,rss,comm,args | awk 'NR == 1 || $6 == "perf" || $6 == "pager" || $0 ~ /perf top/'
for pid in $(ps -eo pid=,comm=,stat= | awk '$2 == "perf" && $3 !~ /Z|X/ {print $1}'); do
  printf 'process.cmdline pid=%s value=' "$pid"
  tr '\0' ' ' <"/proc/$pid/cmdline" 2>/dev/null || true
  printf '\n'
done`;
  const result = await runGuestPty(sandbox, command, '/', {}, line => process.stdout.write(`${redacted(line)}\n`), 30_000);
  process.stdout.write(`guest.exit_code=${result.exitCode}\n`);
  sandbox.close();
  process.exit(0);
}

if (process.env.CSA_CHROMIUM_INSPECT_PERF === '1') {
  const command = String.raw`set +e
printf 'perf.version='; perf --version 2>&1 | head -n 1
PAGER=cat PERF_PAGER=cat perf top -h 2>&1 | grep -E -i 'proc-map-timeout|Usage: perf top|call-graph' | head -n 12
for path in /sys/fs/cgroup/cpu.max /sys/fs/cgroup/cpu.stat /sys/fs/cgroup/memory.current /sys/fs/cgroup/memory.max /sys/fs/cgroup/memory.events /sys/fs/cgroup/pids.current /sys/fs/cgroup/pids.max; do
  if [ -r "$path" ]; then printf 'cgroup.path=%s=' "$path"; tr '\n' ' ' <"$path"; printf '\n'; fi
done
ps -eo stat= | awk '{total++; if ($1 ~ /Z/) zombie++; else live++} END {printf "processes.total=%d live=%d zombie=%d\n", total, live, zombie}'
ps -eo stat=,comm= | awk '$2 == "chromium" {total++; if ($1 ~ /Z/) zombie++; else live++} END {printf "chromium.total=%d live=%d zombie=%d\n", total, live, zombie}'
if [ -r /sys/fs/cgroup/memory.stat ]; then awk '$1 ~ /^(anon|file|kernel|kernel_stack|pagetables|sock|shmem|inactive_file|active_file|slab)$/ {print "memory.stat." $1 "=" $2}' /sys/fs/cgroup/memory.stat; fi
ps -eo pid,ppid,stat,rss,comm | awk 'NR == 1 || $3 !~ /Z|X/' | head -n 30
cat /proc/loadavg
df -h /`;
  const inspectionCommand = ["set -eu", remotePerfSetup, command].join('\n');
  const result = await runGuestPty(sandbox, inspectionCommand, '/', {}, line => process.stdout.write(`${redacted(line)}\n`), 45_000);
  process.stdout.write(`guest.exit_code=${result.exitCode}\n`);
  sandbox.close();
  process.exit(0);
}

if (process.env.CSA_CHROMIUM_INSPECT_CPU === '1') {
  const command = String.raw`set -eu
date -u +%FT%TZ
uname -a
if [ -x /usr/bin/google-chrome ] && command -v timeout >/dev/null 2>&1; then
  chrome_version="$(timeout --kill-after=1s 5s /usr/bin/google-chrome --version 2>&1 | head -n 1 || true)"
  printf 'guest.chrome.version=%s\n' "$chrome_version"
fi
printf 'guest.cpu.count='; nproc
awk '/^(processor|model name|CPU architecture|CPU implementer|CPU part|Features)/ {print}' /proc/cpuinfo | head -n 16
printf 'guest.cpu.online='; cat /sys/devices/system/cpu/online 2>/dev/null || true
printf 'guest.cmdline='; cat /proc/cmdline
for clock_file in /sys/devices/system/clocksource/clocksource0/current_clocksource /sys/devices/system/clocksource/clocksource0/available_clocksource; do
  if [ -r "$clock_file" ]; then printf 'guest.clock.%s=' "$(basename "$clock_file")"; cat "$clock_file"; fi
done
if [ -r /proc/timer_list ]; then
  printf 'guest.timer_list.readable=yes\n'
  awk '/^cpu: / {cpu=$0} /[.]resolution:|hres_active|event_handler:|Tick Device|clock event device|^now at/ {print cpu, $0; n++; if (n >= 32) exit}' /proc/timer_list
else
  printf 'guest.timer_list.readable=no\n'
fi
kernel_config="/boot/config-$(uname -r)"
if [ -r "$kernel_config" ]; then grep -E '^CONFIG_HIGH_RES_TIMERS=' "$kernel_config" || true; fi
printf 'guest.cpu.max='; cat /sys/fs/cgroup/cpu.max 2>/dev/null || true
cat /sys/fs/cgroup/cpu.stat 2>/dev/null
printf 'guest.memory.max='; cat /sys/fs/cgroup/memory.max 2>/dev/null || true
cat /proc/pressure/cpu /proc/pressure/memory`;
  const result = await runGuestPty(sandbox, command, '/', {}, line => process.stdout.write(`${redacted(line)}\n`), 30_000);
  process.stdout.write(`guest.exit_code=${result.exitCode}\n`);
  sandbox.close();
  process.exit(0);
}

if (process.env.CSA_CHROMIUM_INSPECT_CAPABILITIES === '1') {
  const command = String.raw`set +e
uname -a
if [ -r /etc/os-release ]; then . /etc/os-release; printf 'os=%s version=%s\n' "$ID" "$VERSION_ID"; fi
for tool in perf gdb; do
  if command -v "$tool" >/dev/null 2>&1; then
    printf 'tool.%s=%s\n' "$tool" "$(command -v "$tool")"
    if [ "$tool" = gdb ] && declare -p gdb_root >/dev/null 2>&1 && [ -s "$gdb_root/version-check.log" ]; then
      head -n 1 "$gdb_root/version-check.log"
    else
      timeout --signal=INT --kill-after=2s 30s "$tool" --version 2>&1 | head -n 1
    fi
  else
    printf 'tool.%s=missing\n' "$tool"
  fi
done
for path in /proc/sys/kernel/perf_event_paranoid /proc/sys/kernel/kptr_restrict /sys/fs/cgroup/cpu.max /sys/fs/cgroup/memory.max; do
  if [ -r "$path" ]; then printf '%s=' "$path"; cat "$path"; fi
done
grep -E '^(CapEff|CapBnd|NoNewPrivs):' /proc/self/status
if command -v dbus-run-session >/dev/null 2>&1; then printf 'tool.dbus-run-session=%s\n' "$(command -v dbus-run-session)"; else echo 'tool.dbus-run-session=missing'; fi
if command -v apt-cache >/dev/null 2>&1; then apt-cache policy linux-perf linux-tools-common 2>&1 | sed -n '1,32p'; fi
df -h /
awk '$2 == "/dev/shm" || $2 == "/tmp" {printf "mount.path=%s fstype=%s options=%s\n", $2, $3, $4}' /proc/mounts
df -h /tmp /dev/shm 2>/dev/null
ps -eo pid,ppid,stat,comm,args | awk '$4 == "apt-get" || $4 == "dpkg" || $4 == "unattended-upgr" {print}'
for path in /var/lib/dpkg/lock /var/lib/dpkg/lock-frontend /var/lib/apt/lists/lock; do
  if [ -e "$path" ]; then stat -c 'lock.path=%n mode=%a size=%s' "$path"; if command -v fuser >/dev/null 2>&1; then fuser -v "$path" 2>&1 || true; fi; fi
done
dpkg --audit; printf 'dpkg.audit.exit=%s\n' "$?"`;
  const inspectionCommand = ["set -eu", remoteGdbSetup, command].join('\n');
  const result = await runGuestPty(sandbox, inspectionCommand, '/', {}, line => process.stdout.write(`${redacted(line)}\n`), 60_000);
  process.stdout.write(`guest.exit_code=${result.exitCode}\n`);
  sandbox.close();
  process.exit(0);
}

if (process.env.CSA_CHROMIUM_INSTALL_GDB === '1') {
  const command = String.raw`set -Eeuo pipefail
available_kb="$(df -Pk / | awk 'NR == 2 {print $4}')"
printf 'guest.stage=preflight disk_available_kb=%s\n' "$available_kb"
if ((available_kb < 1048576)); then echo 'guest.stage=preflight.failed reason=disk-below-1GiB'; exit 8; fi
active_package_managers="$(ps -eo stat=,comm=,pid= | awk '($2 == "apt-get" || $2 == "dpkg" || $2 == "unattended-upgr") && $1 !~ /Z|X/ {print $2 ":" $3}')"
if [[ -n "$active_package_managers" ]]; then printf 'guest.stage=preflight.failed reason=package-manager-active processes=%s\n' "$active_package_managers"; exit 9; fi
for lock in /var/lib/dpkg/lock /var/lib/dpkg/lock-frontend /var/lib/apt/lists/lock; do
  if command -v fuser >/dev/null 2>&1 && fuser -s "$lock" 2>/dev/null; then echo "guest.stage=preflight.failed reason=package-lock-held path=$lock"; exit 10; fi
done
export DEBIAN_FRONTEND=noninteractive
echo 'guest.stage=apt-index.start package=gdb'
apt-get -o Acquire::Retries=1 -o Acquire::http::Timeout=25 -o Acquire::https::Timeout=25 update
echo 'guest.stage=gdb.install.start'
apt-get install -y --no-install-recommends gdb
echo "guest.stage=gdb.install.complete version=$(gdb --version | head -n 1)"
df -h /`;
  const result = await runGuestPty(sandbox, command, '/', {}, line => {
    const safeLine = redacted(line);
    if (/guest\.stage=|^(Hit:|Get:|Fetched |Reading package lists|Building dependency tree|Reading state information|The following|Need to get|After this operation|Setting up|Processing triggers|Unpacking|Selecting previously|Preparing to unpack|Filesystem|overlay2)/.test(safeLine)) {
      process.stdout.write(`${safeLine}\n`);
    }
  }, 240_000);
  process.stdout.write(`guest.exit_code=${result.exitCode}\n`);
  sandbox.close();
  process.exit(0);
}

if (process.env.CSA_CHROMIUM_INSPECT_LIVE === '1') {
  const inspectPort = Number(process.env.CSA_CHROMIUM_CDP_PORT || '19355');
  const inspectTag = process.env.CSA_CHROMIUM_DIAGNOSTIC_TAG || 'websocket-20261123055009';
  if (!Number.isSafeInteger(inspectPort) || inspectPort < 1024 || inspectPort > 65535) throw new Error('Invalid live inspection port.');
  if (!/^[a-zA-Z0-9-]{1,80}$/.test(inspectTag)) throw new Error('Invalid live inspection tag.');
  const directory = `/tmp/csa-chromium-headless-${inspectTag}`;
  const command = String.raw`set +e
printf 'guest.live.port=%s\n' '${inspectPort}'
ss -lntp 2>/dev/null | awk -v suffix=':${inspectPort}' 'NR == 1 || substr($4, length($4)-length(suffix)+1) == suffix'
if [ -r '${directory}/chromium.pgid' ]; then
  group="$(cat '${directory}/chromium.pgid')"
  printf 'guest.live.chrome_pgid=%s\n' "$group"
  ps -eo pid,ppid,pgid,stat,comm | awk -v group="$group" 'NR == 1 || $3 == group'
fi
ps -eo pid,ppid,pgid,stat,comm | awk '$5 == "gdb" || $5 == "tar" || $5 == "chrome" || $5 == "chromium" {print}'
for path in /tmp/csa-chromium-gdb-rootfs.tar.gz /tmp/gdb /tmp/csa-chromium-gdb-${inspectTag} /tmp/csa-${inspectTag}.sh; do
  if [ -e "$path" ]; then printf 'guest.live.path.present path=%s\n' "$path"; else printf 'guest.live.path.absent path=%s\n' "$path"; fi
done
if [ -r '${directory}/run.log' ]; then grep -E 'stage=(gdb\.stack|cdp\.websocket|chrome\.result|cleanup\.|sequence\.complete)' '${directory}/run.log' | tail -n 30; fi
df -h /`;
  const result = await runGuestPty(sandbox, command, '/', {}, line => process.stdout.write(`${redacted(line)}\n`), 30_000);
  process.stdout.write(`guest.exit_code=${result.exitCode}\n`);
  sandbox.close();
  process.exit(0);
}

if (process.env.CSA_CHROMIUM_INSPECT_DUMP_DOM === '1') {
  const inspectTag = process.env.CSA_CHROMIUM_DIAGNOSTIC_TAG || '';
  const clean = process.env.CSA_CHROMIUM_CLEAN_DUMP_DOM === '1';
  if (!/^[a-zA-Z0-9-]{1,80}$/.test(inspectTag)) throw new Error('Invalid dump-dom diagnostic tag.');
  const directory = `/tmp/csa-chrome-dump-${inspectTag}`;
  const profile = `${directory}/profile`;
  const command = String.raw`set +e
profile='${profile}'
strace_root='/tmp/csa-chromium-strace-${inspectTag}'
list_profile_processes() {
  ps -eo pid=,ppid=,pgid=,stat=,comm=,args= | awk -v user_data="--user-data-dir=$profile" '($5 == "chrome" || $5 == "chrome_crashpad") && index($0, user_data) {print}'
}
printf 'guest.dump-dom.processes.before=%s\n' "$(list_profile_processes | tr '\n' ';')"
for path in /tmp/csa-chromium-strace_6.1-0.1_arm64.deb "$strace_root" /tmp/csa-websocket-${inspectTag}.sh; do
  if [[ -e "$path" ]]; then printf 'guest.dump-dom.temp.present path=%s\n' "$path"; else printf 'guest.dump-dom.temp.absent path=%s\n' "$path"; fi
done
ps -eo pid,ppid,stat,comm,args | awk -v tag='${inspectTag}' '($4 == "strace" || $4 == "dpkg-deb" || $4 == "timeout") && index($0, tag) {print}'
grep -E '^(Name|Uid|Gid|CapEff|CapBnd|NoNewPrivs|Seccomp|Seccomp_filters):' /proc/self/status
printf 'guest.kernel.clk_tck='; getconf CLK_TCK
for path in /proc/sys/kernel/yama/ptrace_scope /proc/sys/kernel/perf_event_paranoid; do
  if [ -r "$path" ]; then printf 'guest.kernel.path=%s value=' "$path"; tr '\n' ' ' <"$path"; printf '\n'; else printf 'guest.kernel.path=%s unreadable\n' "$path"; fi
done
live_pids="$(list_profile_processes | awk '$4 !~ /Z|X/ {print $1}')"
if [[ '${clean ? '1' : '0'}' == 1 && -n "$live_pids" ]]; then
  printf 'guest.dump-dom.cleanup.term pids=%s\n' "$(printf '%s' "$live_pids" | tr '\n' ',')"
  kill -TERM $live_pids 2>/dev/null || true
  sleep 1
  live_pids="$(list_profile_processes | awk '$4 !~ /Z|X/ {print $1}')"
  if [[ -n "$live_pids" ]]; then kill -KILL $live_pids 2>/dev/null || true; sleep 0.2; fi
  live_pids="$(list_profile_processes | awk '$4 !~ /Z|X/ {print $1}')"
fi
if [[ '${clean ? '1' : '0'}' == 1 && -z "$live_pids" ]]; then
  for path in "$profile" '${directory}/home' '${directory}/cache'; do
    if [[ -d "$path" ]]; then find "$path" -depth -delete; fi
  done
  printf 'guest.dump-dom.cleanup.complete remaining=none\n'
fi
printf 'guest.dump-dom.processes.after=%s\n' "$(list_profile_processes | tr '\n' ';')"
df -h /`;
  const result = await runGuestPty(sandbox, command, '/', {}, line => process.stdout.write(`${redacted(line)}\n`), 30_000);
  process.stdout.write(`guest.exit_code=${result.exitCode}\n`);
  for (const file of ['run.log', 'chrome.log', 'strace-main.log', 'strace-main.stderr', 'threads-one.tsv', 'threads-two.tsv']) {
    const contents = String(await sandbox.files.read(`${directory}/${file}`).catch(() => ''));
    const lines = contents.split(/\r?\n/).filter(line => line.trim());
    process.stdout.write(`guest.dump-dom.artifact file=${file} lines=${lines.length}\n`);
    for (const line of lines.slice(-40)) process.stdout.write(`${redacted(line)}\n`);
  }
  sandbox.close();
  process.exit(0);
}

if (process.env.CSA_CHROMIUM_INSPECT_PROFILE === '1') {
  const profileScript = await readFile(new URL('./inspect-chromium-profile.sh', import.meta.url));
  const result = await runGuestPty(sandbox, profileScript.toString(), '/', {}, line => {
    process.stdout.write(redacted(line) + '\n');
  }, 30_000);
  process.stdout.write('guest.exit_code=' + result.exitCode + '\n');
  sandbox.close();
  process.exit(0);
}

const inspectTag = process.env.CSA_CHROMIUM_INSPECT_TAG;
if (inspectTag) {
  if (!/^[a-zA-Z0-9-]{1,80}$/.test(inspectTag)) throw new Error('Invalid diagnostic tag.');
  const directory = `/tmp/csa-chromium-headless-${inspectTag}`;
  for (const file of ['gdb-main-thread.log', 'perf-record.log', 'perf-report.txt', 'perf-top.txt', 'chromium.log', 'chrome-startup-trace.json', 'websocket-strace.stderr', 'websocket-client.log', 'websocket-handshake.headers', 'websocket-handshake.body', 'websocket-strace.log', 'http-strace.log', 'run.log']) {
    if (file === 'chrome-startup-trace.json') {
      const rawTrace = await sandbox.files.read(`${directory}/${file}`, { format: 'bytes' }).catch(() => new Uint8Array());
      const traceBytes = Buffer.from(rawTrace);
      if (traceBytes.length === 0) {
        process.stdout.write(`guest.artifact.missing file=${file}\n`);
      } else if (traceExportPath) {
        await mkdir(join(homedir(), '.local/share/csa-cube-node/build-logs'), { recursive: true, mode: 0o700 });
        await writeFile(traceExportPath, traceBytes, { flag: 'wx', mode: 0o600 });
        let eventCount = 'unknown';
        try {
          const trace = JSON.parse(traceBytes.toString('utf8')) as { traceEvents?: unknown[] };
          eventCount = String(Array.isArray(trace.traceEvents) ? trace.traceEvents.length : 'unknown');
        } catch {}
        process.stdout.write(`guest.artifact.exported file=${file} bytes=${traceBytes.length} events=${eventCount} host_path=${traceExportPath}\n`);
      } else {
        process.stdout.write(`guest.artifact.available file=${file} bytes=${traceBytes.length} set_CSA_CHROMIUM_TRACE_EXPORT_NAME_to_export\n`);
      }
      continue;
    }
    const contents = String(await sandbox.files.read(`${directory}/${file}`).catch(() => ''));
    const lines = contents.split(/\r?\n/).filter(line => line.trim());
    let filtered = lines.slice(-20);
    if (file === 'gdb-main-thread.log') {
      filtered = lines.slice(-80);
    } else if (file === 'perf-report.txt' || file === 'perf-top.txt') {
      filtered = lines.slice(-80);
    } else if (file === 'perf-record.log' || file === 'chromium.log') {
      filtered = lines.slice(-40);
    } else if (file === 'websocket-strace.log') {
      const handshake = lines.filter(line => /accept4?\(|bind\(|listen\(|\/devtools\/browser|Upgrade:|GET \/|HTTP\/1\.[01]/.test(line)).slice(-30);
      const io = lines.filter(line => /read\(|write\(/.test(line)).slice(-15);
      filtered = [...handshake, ...io];
      process.stdout.write(`guest.log matches file=${file} accepts=${lines.filter(line => /accept4?\(/.test(line)).length} websocket_paths=${lines.filter(line => /\/devtools\/browser|Upgrade:/.test(line)).length} http_requests=${lines.filter(line => /GET \/|\/json\/version/.test(line)).length}\n`);
    } else if (file === 'websocket-strace.stderr') {
      filtered = [...lines.slice(0, 8), ...lines.slice(-4)];
    } else if (file === 'run.log') {
      filtered = lines.filter(line => /stage=(?:preflight\.failed|process\.sample|thread\.sample|cdp\.listener\.(?:probe|ready|failed)|http\.client\.result|cdp\.websocket|chrome\.result|cleanup\.(?:complete|failed)|diagnostic\.failed|sequence\.complete)/.test(line)).slice(-100);
    }
    process.stdout.write(`guest.log file=${file} lines=${lines.length}\n`);
    for (const line of filtered) process.stdout.write(`${redacted(line)}\n`);
  }
  const entries = await sandbox.files.list(directory).catch(() => []);
  const clientTraceNames = entries
    .map(entry => typeof entry?.name === 'string' ? entry.name : typeof entry?.path === 'string' ? entry.path : '')
    .filter(name => /websocket-client-strace(?:\.|$)/.test(name));
  for (const name of clientTraceNames) {
    const path = name.startsWith('/') ? name : `${directory}/${name}`;
    const contents = String(await sandbox.files.read(path).catch(() => ''));
    const lines = contents.split(/\r?\n/).filter(line => line.trim());
    process.stdout.write(`guest.log file=${name} lines=${lines.length} connect_calls=${lines.filter(line => /connect\(/.test(line)).length}\n`);
    for (const line of lines.slice(-20)) process.stdout.write(`${redacted(line).replace(/(Sec-WebSocket-Key: )[A-Za-z0-9+/=]+/gi, '$1[redacted]')}\n`);
    await sandbox.files.remove(path).catch(() => undefined);
    process.stdout.write(`guest.log.cleaned file=${name}\n`);
  }
  sandbox.close();
  process.exit(0);
}

try {
  let completedExitCode: number | undefined;
  let guestExitCode: number | undefined;
  const guestOutputTail: string[] = [];
  try {
    const result = await runGuestPty(sandbox, remoteCommand, '/', {}, line => {
    const safeLine = redacted(line);
    guestOutputTail.push(safeLine.length > 500 ? `${safeLine.slice(0, 220)}...[omitted ${safeLine.length - 220} characters]` : safeLine);
    if (guestOutputTail.length > 80) guestOutputTail.shift();
    const completeMatch = safeLine.match(/stage=sequence\.complete exit_code=(\d+)/);
    if (completeMatch) completedExitCode = Number(completeMatch[1]);
    if (stageLine.test(safeLine)) process.stdout.write(`${safeLine}\n`);
    }, dumpDomOnly === '1' ? (gdbSample === '1' ? 180_000 : straceSample === '1' ? 150_000 : 90_000) : 300_000);
    guestExitCode = result.exitCode;
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    process.stdout.write(`diagnostic.host-pty.failed error=${JSON.stringify(redacted(errorMessage))} completed_exit_code=${completedExitCode ?? 'missing'}\n`);
    if (completedExitCode === undefined) {
      for (const line of guestOutputTail.slice(-30)) process.stdout.write(`diagnostic.guest-output.tail ${line.slice(0, 800)}\n`);
    }
    const exitMatch = errorMessage.match(/exit status (\d+)/);
    if (!exitMatch || completedExitCode === undefined) throw error;
    guestExitCode = Number(exitMatch[1]);
  }
  process.stdout.write(`guest.exit_code=${guestExitCode}\n`);
  if (guestExitCode !== 0) process.exitCode = guestExitCode;
} finally {
  sandbox.close();
}
