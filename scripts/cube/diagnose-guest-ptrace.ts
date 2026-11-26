import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { Sandbox } from '@cubesandbox/sdk';
import { pool } from '../../src/server/db.ts';
import { cubeConfig } from '../../src/server/computer.ts';
import { decryptSandboxTrafficToken } from '../../src/server/token-crypto.ts';
import { runGuestPty } from '../../src/server/runtime-bundle.ts';

const tenantSlug = process.env.CSA_DIAGNOSTIC_TENANT_SLUG || 'beta';
const expectedSandboxId = process.env.CSA_DIAGNOSTIC_EXPECTED_SANDBOX_ID || '';
const desktopUser = process.env.CSA_DIAGNOSTIC_USER || 'user';
const bundlePath = process.env.CSA_CHROMIUM_STRACE_BUNDLE_PATH
  || join(homedir(), '.local/share/csa-cube-node/runtime-cache/strace_6.1-0.1_arm64.deb');
const expectedSha256 = '751817724af91cb95df566a21a154f9a7dcdd938e700e5cb9a5a47eb19752ea2';
const tag = `ptrace-selftest-${new Date().toISOString().replace(/[-:.TZ]/g, '').slice(0, 14)}`;
const shellQuote = (value: string): string => `'${value.replace(/'/g, `'\\''`)}'`;

if (!/^[a-z0-9-]{1,80}$/.test(tenantSlug)) throw new Error('Invalid diagnostic tenant slug.');
if (expectedSandboxId && !/^[a-zA-Z0-9_-]{1,80}$/.test(expectedSandboxId)) throw new Error('Invalid expected sandbox ID.');
if (!/^[a-z_][a-z0-9_-]{0,30}\$?$/i.test(desktopUser)) throw new Error('Invalid desktop username.');

const [rows] = await pool.query(
  `SELECT t.slug, c.sandbox_id, c.cube_traffic_token_ciphertext, c.state, c.desktop_state, c.generation,
          (SELECT COUNT(*) FROM runs r WHERE r.tenant_id = t.id AND r.status IN ('queued', 'working')) AS active_runs
     FROM tenants t JOIN computers c ON c.tenant_id = t.id WHERE t.slug = ? LIMIT 1`,
  [tenantSlug],
);
await pool.end();
const computer = (rows as Array<{
  slug: string;
  sandbox_id: string | null;
  cube_traffic_token_ciphertext: string | null;
  state: string;
  desktop_state: string;
  generation: number;
  active_runs: number;
}>)[0];
if (!computer?.sandbox_id || !computer.cube_traffic_token_ciphertext || computer.state !== 'running') {
  throw new Error('The selected tenant must have a running microVM and stored traffic token.');
}
if (expectedSandboxId && computer.sandbox_id !== expectedSandboxId) throw new Error('Sandbox ID changed; refusing the ptrace self-test.');
if (Number(computer.active_runs) !== 0) throw new Error('The selected tenant has an active Agent run; refusing the ptrace self-test.');

const bundle = await readFile(bundlePath);
const bundleSha256 = createHash('sha256').update(bundle).digest('hex');
if (bundleSha256 !== expectedSha256) throw new Error(`strace bundle hash mismatch: ${bundleSha256}`);
const remoteBundle = `/tmp/csa-${tag}.deb`;
const remoteRoot = `/tmp/csa-${tag}`;
const remoteScript = `/tmp/csa-${tag}.sh`;
const script = `#!/usr/bin/env bash
set -Eeuo pipefail
bundle=${shellQuote(remoteBundle)}
root=${shellQuote(remoteRoot)}
probe="/tmp/csa-${tag}-probe"
user=${shellQuote(desktopUser)}
target_pid=''
cleanup() {
  status=$?
  trap - EXIT
  if [[ "$target_pid" =~ ^[0-9]+$ ]] && kill -0 "$target_pid" 2>/dev/null; then
    target_comm="$(cat "/proc/$target_pid/comm" 2>/dev/null || true)"
    target_uid_now="$(awk '/^Uid:/ {print $2}' "/proc/$target_pid/status" 2>/dev/null || true)"
    if [[ "$target_comm" == sleep && "$target_uid_now" == "$user_uid" ]]; then
      kill -TERM "$target_pid" 2>/dev/null || true
      sleep 0.2
      if kill -0 "$target_pid" 2>/dev/null; then kill -KILL "$target_pid" 2>/dev/null || true; fi
      wait "$target_pid" 2>/dev/null || true
    else
      echo "stage=ptrace.selftest.cleanup.skip pid=$target_pid comm=$target_comm uid=$target_uid_now"
    fi
  fi
  if [[ -d "$probe" ]]; then find "$probe" -depth -delete || true; fi
  if [[ -d "$root" ]]; then find "$root" -depth -delete || true; fi
  printf 'stage=ptrace.selftest.cleanup exit_code=%s root=%s probe=%s\\n' "$status" "$([ -e "$root" ] && echo present || echo absent)" "$([ -e "$probe" ] && echo present || echo absent)"
}
trap cleanup EXIT
available_kb="$(df -Pk / | awk 'NR == 2 {print $4}')"
if [[ ! "$available_kb" =~ ^[0-9]+$ ]] || ((available_kb < 524288)); then echo "stage=ptrace.selftest.failed reason=disk-below-512MiB available_kb=$available_kb"; exit 91; fi
user_uid="$(id -u "$user")"
user_group="$(id -gn "$user")"
user_gid="$(id -g "$user")"
setpriv_bin="$(command -v setpriv || true)"
if [[ -z "$setpriv_bin" ]]; then echo 'stage=ptrace.selftest.failed reason=setpriv-missing'; exit 93; fi
install -d -m 0700 "$root"
echo "stage=ptrace.selftest.extract.start root=$root bytes=$(stat -c %s "$bundle")"
timeout --signal=TERM --kill-after=1s 15s dpkg-deb -x "$bundle" "$root"
chmod 0755 "$root"
strace_bin="$root/usr/bin/strace"
if [[ ! -x "$strace_bin" ]]; then echo 'stage=ptrace.selftest.failed reason=strace-binary-missing'; exit 92; fi
install -d -o "$user" -g "$user_group" -m 0700 "$probe"
trace_log="$probe/trace.log"
error_log="$probe/stderr.log"
version_log="$probe/version.log"
: >"$trace_log"
: >"$error_log"
: >"$version_log"
chown "$user:$user_group" "$trace_log" "$error_log" "$version_log"
echo "stage=ptrace.selftest.version.start desktop_uid=$user_uid timeout_seconds=10"
set +e
timeout --signal=TERM --kill-after=1s 10s runuser -u "$user" -- "$strace_bin" --version >"$version_log" 2>"$error_log"
version_status=$?
set -e
echo "stage=ptrace.selftest.version.result exit_code=$version_status bytes=$(wc -c <"$version_log" | tr -d ' ')"
sed -n '1,4p' "$version_log" | while IFS= read -r line; do echo "stage=ptrace.selftest.version.line $line"; done
if [[ "$version_status" == 0 ]]; then
  echo "stage=ptrace.selftest.start desktop_uid=$user_uid command=usr-bin-true tracer_uid=$user_uid"
  set +e
  timeout --signal=TERM --kill-after=1s 5s "$setpriv_bin" --reuid="$user_uid" --regid="$user_gid" --clear-groups -- "$strace_bin" -f -tt -T -s 96 -e trace=execve,exit_group -o "$trace_log" /usr/bin/true 2>"$error_log"
  trace_status=$?
  set -e
else
  trace_status=$version_status
fi
echo "stage=ptrace.selftest.result exit_code=$trace_status trace_bytes=$(wc -c <"$trace_log" | tr -d ' ') stderr_bytes=$(wc -c <"$error_log" | tr -d ' ')"
od -An -v -tx1c "$error_log" | sed -n '1,8p' | while IFS= read -r line; do echo "stage=ptrace.selftest.stderr.hex $line"; done
sed -n '1,12p' "$trace_log" | while IFS= read -r line; do echo "stage=ptrace.selftest.trace $line"; done
if [[ -s "$trace_log" && "$trace_status" == 0 ]]; then echo 'stage=ptrace.selftest.complete result=child-traced'; else echo 'stage=ptrace.selftest.complete result=child-not-traced'; fi
echo "stage=ptrace.selftest.attach.start target=same-uid-sibling command=sleep-2 tracer_uid=$user_uid"
"$setpriv_bin" --reuid="$user_uid" --regid="$user_gid" --clear-groups -- /usr/bin/sleep 2 &
target_pid=$!
for attempt in $(seq 1 20); do
  target_comm="$(cat "/proc/$target_pid/comm" 2>/dev/null || true)"
  [[ "$target_comm" == sleep ]] && break
  sleep 0.1
done
target_uid_now="$(awk '/^Uid:/ {print $2}' "/proc/$target_pid/status" 2>/dev/null || true)"
if [[ "$target_comm" != sleep || "$target_uid_now" != "$user_uid" ]]; then
  echo "stage=ptrace.selftest.attach.failed reason=target-identity pid=$target_pid comm=$target_comm uid=$target_uid_now"
else
  : >"$trace_log"
  : >"$error_log"
  set +e
  timeout --signal=INT --kill-after=1s 4s "$setpriv_bin" --reuid="$user_uid" --regid="$user_gid" --clear-groups -- "$strace_bin" -tt -T -s 96 -p "$target_pid" -e trace=clock_nanosleep,nanosleep -o "$trace_log" 2>"$error_log"
  attach_status=$?
  set -e
  echo "stage=ptrace.selftest.attach.result exit_code=$attach_status target_pid=$target_pid target_uid=$target_uid_now trace_bytes=$(wc -c <"$trace_log" | tr -d ' ') stderr_bytes=$(wc -c <"$error_log" | tr -d ' ')"
  sed -n '1,12p' "$error_log" | while IFS= read -r line; do echo "stage=ptrace.selftest.attach.stderr $line"; done
  od -An -v -tx1c "$error_log" | sed -n '1,8p' | while IFS= read -r line; do echo "stage=ptrace.selftest.attach.stderr.hex $line"; done
  sed -n '1,12p' "$trace_log" | while IFS= read -r line; do echo "stage=ptrace.selftest.attach.trace $line"; done
fi
df -h /
`;
const encodedScript = Buffer.from(script).toString('base64');
const remoteCommand = `set -eu\nremote_bundle=${shellQuote(remoteBundle)}\nremote_script=${shellQuote(remoteScript)}\nremote_root=${shellQuote(remoteRoot)}\ncleanup_outer() { rm -f -- "$remote_bundle" "$remote_script"; if [ -d "$remote_root" ]; then find "$remote_root" -depth -delete || true; fi; }\ntrap cleanup_outer EXIT\nprintf '%s' '${encodedScript}' | base64 -d > "$remote_script"\nchmod 700 "$remote_script"\nbash "$remote_script"`;

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

try {
  process.stdout.write(`ptrace.selftest.preflight tenant=${tenantSlug} sandbox_id=${computer.sandbox_id} state=${computer.state} desktop_state=${computer.desktop_state} generation=${computer.generation} active_runs=${computer.active_runs} bundle_bytes=${bundle.byteLength} sha256=${bundleSha256}\n`);
  await sandbox.files.write(remoteBundle, bundle);
  process.stdout.write(`ptrace.selftest.bundle.staged sandbox_id=${sandbox.sandboxId} path=${remoteBundle}\n`);
  const result = await runGuestPty(sandbox, remoteCommand, '/', {}, line => {
    const cleanLine = line.replace(/\u001b\[[0-9;?]*[A-Za-z]/g, '');
    if (/stage=ptrace\.selftest\.|Operation not permitted|ptrace\(/.test(cleanLine)) process.stdout.write(`${cleanLine}\n`);
  }, 60_000);
  process.stdout.write(`ptrace.selftest.guest_exit_code=${result.exitCode}\n`);
  const verifyCommand = `set +e\nfor path in ${shellQuote(remoteBundle)} ${shellQuote(remoteRoot)} ${shellQuote(remoteScript)} ${shellQuote(`/tmp/csa-${tag}-probe`)}; do if [ -e "$path" ]; then printf 'stage=ptrace.selftest.verify path=%s state=present\\n' "$path"; else printf 'stage=ptrace.selftest.verify path=%s state=absent\\n' "$path"; fi; done\nps -eo pid=,stat=,comm=,args= | awk -v tag=${shellQuote(tag)} '($3 == "strace" || $3 == "sleep" || $3 == "runuser" || $3 == "timeout") && index($0, tag) {print "stage=ptrace.selftest.process " $0}'\ndf -h /`;
  const verify = await runGuestPty(sandbox, verifyCommand, '/', {}, line => {
    const cleanLine = line.replace(/\u001b\[[0-9;?]*[A-Za-z]/g, '');
    if (/stage=ptrace\.selftest\.verify|stage=ptrace\.selftest\.process|Filesystem|overlay2/.test(cleanLine)) process.stdout.write(`${cleanLine}\n`);
  }, 30_000);
  process.stdout.write(`ptrace.selftest.verify_exit_code=${verify.exitCode}\n`);
} finally {
  sandbox.close();
}
