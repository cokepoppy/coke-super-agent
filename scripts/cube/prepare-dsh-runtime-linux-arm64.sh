#!/usr/bin/env bash
set -Eeuo pipefail

build_started_at=$SECONDS
build_stage=starting
umask 077
build_log_directory="${CSA_BUILD_LOG_DIR:-$HOME/.local/share/csa-cube-node/build-logs}"
mkdir -p "$build_log_directory"
build_log_path="$build_log_directory/dsh-runtime-build-$(date -u +%Y-%m-%dT%H-%M-%SZ)-$$.log"
: > "$build_log_path"
chmod 0600 "$build_log_path"
# Preserve the caller's stdout for the final tab-separated bundle result. All
# build output is mirrored to the caller's stderr and the private log file.
exec 3>&1 4>&2
exec > >(tee -a "$build_log_path" >&4)
exec 2> >(tee -a "$build_log_path" >&4)

log_stage() {
  build_stage="$1"
  shift
  printf 'runtime_bundle_stage stage=%s elapsed_seconds=%s timestamp=%s log_file=%s %s\n' \
    "$build_stage" "$((SECONDS - build_started_at))" "$(date -u +%FT%TZ)" "$build_log_path" "$*" >&2
}
log_disk_space() {
  local label="$1" path="$2" snapshot
  snapshot="$(df -Pk "$path" 2>/dev/null | awk 'NR == 2 { printf "total_bytes=%.0f used_bytes=%.0f available_bytes=%.0f mount=%s", $2 * 1024, $3 * 1024, $4 * 1024, $NF }')"
  if [[ -n "$snapshot" ]]; then
    log_stage storage.snapshot label="$label" path="$path" "$snapshot"
  else
    log_stage storage.snapshot.failed label="$label" path="$path"
  fi
}
safe_build_command() {
  local value="$1"
  value="${value//$'\n'/ }"
  value="${value//$'\r'/ }"
  value="$(printf '%s' "$value" | sed -E \
    -e 's#(https?://)[^/@:]+:[^/@]+@#\1[redacted]@#g' \
    -e 's/((api[_-]?key|token|password|secret)[[:space:]]*[:=][[:space:]]*)[^,[:space:]"'"'"'`]+/\1[redacted]/Ig' \
    -e 's/((Bearer|Basic)[[:space:]]+)[^[:space:]"'"'"'`]+/\1[redacted]/Ig')"
  printf '%s' "${value:0:600}"
}
on_error() {
  local status=$?
  trap - ERR
  local command
  command="$(safe_build_command "${BASH_COMMAND:-unknown}")"
  printf 'runtime_bundle_stage_failed stage=%s exit_code=%s line=%s elapsed_seconds=%s timestamp=%s log_file=%s command=%q\n' \
    "$build_stage" "$status" "${BASH_LINENO[0]:-unknown}" "$((SECONDS - build_started_at))" "$(date -u +%FT%TZ)" "$build_log_path" "$command" >&2
  exit "$status"
}
trap on_error ERR
log_stage preflight.start pid=$$ platform="$(uname -s)" architecture="$(uname -m)"

repo_root="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$repo_root"
package_dir="$repo_root/scripts/cube/dsh-runtime"
cache_root="${CSA_AGENT_RUNTIME_CACHE_DIR:-$HOME/.cache/csa-cube-node/runtime-cache}"
proxy="${CSA_NPM_HTTP_PROXY:-}"

if [[ -z "$proxy" ]]; then
  if [[ "$(uname -s)" == Darwin ]]; then
    proxy=http://127.0.0.1:7890
  else
    echo "Set CSA_NPM_HTTP_PROXY to the host-side HTTP proxy for npm downloads." >&2
    exit 1
  fi
fi
if [[ ! -s "$package_dir/package.json" || ! -s "$package_dir/package-lock.json" || ! -s "$package_dir/runtime-manifest.json" ]]; then
  echo "DeepSeek Harness runtime manifests were not found." >&2
  exit 1
fi
runtime_version="$(node -p 'require(process.argv[1]).deepseekHarnessVersion' "$package_dir/runtime-manifest.json")"
wheel_filename="$(node -p 'require(process.argv[1]).runtimeWheelFilename' "$package_dir/runtime-manifest.json")"
wheel_sha256="$(node -p 'require(process.argv[1]).runtimeWheelSha256' "$package_dir/runtime-manifest.json")"
wheel_url="$(node -p 'require(process.argv[1]).runtimeWheelUrl' "$package_dir/runtime-manifest.json")"
if [[ "$runtime_version" != "0.2.2-rc.2" || ! "$wheel_sha256" =~ ^[a-f0-9]{64}$ || "$wheel_filename" != *manylinux_2_28_aarch64.whl ]]; then
  echo "The pinned official Linux ARM64 DeepSeek Harness runtime manifest is invalid." >&2
  exit 1
fi

lock_hash="$(shasum -a 256 "$package_dir/package-lock.json" | cut -d' ' -f1)"
runtime_key="$(cat "$package_dir/package-lock.json" <(printf '\0') "$package_dir/runtime-manifest.json" <(printf '\0') "$0" <(printf '\0') "$package_dir/run-task.mjs" <(printf '\0') "$package_dir/session-budget.mjs" <(printf '\0') "$package_dir/computer-plugin.mjs" <(printf '\0') "$package_dir/chrome-cdp-pipe-bridge.mjs" <(printf '\0') "$package_dir/dsh-runtime-launcher.mjs" <(printf '\0') "$repo_root/scripts/cube/bootstrap-dsh-runtime.sh" <(printf '\0') "$repo_root/scripts/cube/run-dsh-runtime-bootstrap.sh" | shasum -a 256 | cut -d' ' -f1)"
mkdir -p "$cache_root"
log_disk_space preflight "$cache_root"
archive="$cache_root/dsh-runtime-linux-arm64-${runtime_key}.tar.gz"
if [[ -s "$archive" ]] && tar -tzf "$archive" >/dev/null 2>&1; then
  archive_sha256="$(shasum -a 256 "$archive" | cut -d' ' -f1)"
  log_stage cache-hit archive="$archive" archive_bytes="$(stat -f%z "$archive" 2>/dev/null || wc -c < "$archive" | tr -d ' ')" sha256="$archive_sha256" runtime_key="${runtime_key:0:16}"
  printf '%s\t%s\t%s\n' "$archive" "$runtime_key" "$archive_sha256" >&3
  exit 0
fi
rm -f "$archive"

log_stage npm-registry-probe proxy_configured=true
echo "Checking npm registry through the host HTTP proxy..." >&2
if ! curl --proxy "$proxy" --connect-timeout 5 --max-time 20 -fsS \
  -o /dev/null https://registry.npmjs.org/@deepseek-ai%2Fdsh-sdk-client; then
  echo "The configured HTTP proxy probe timed out; npm will continue with its local cache and use the proxy for any missing packages." >&2
else
  echo "npm registry is reachable through the host HTTP proxy." >&2
fi

work_dir="$(mktemp -d "$cache_root/.dsh-runtime.XXXXXX")"
cleanup() { rm -rf "$work_dir"; }
trap cleanup EXIT
runtime_dir="$work_dir/runtime"
mkdir -p "$runtime_dir"
cp "$package_dir/package.json" "$package_dir/package-lock.json" "$package_dir/runtime-manifest.json" "$runtime_dir/"
cp -R "$package_dir/dsh-cli-stub" "$runtime_dir/dsh-cli-stub"

wheel_cache="$cache_root/$wheel_filename"
wheel_cache_hit=false
if [[ ! -s "$wheel_cache" ]] || [[ "$(shasum -a 256 "$wheel_cache" | cut -d' ' -f1)" != "$wheel_sha256" ]]; then
  log_disk_space before-wheel-download "$cache_root"
  log_stage runtime-wheel-download.start version="$runtime_version" url_host="$(python3 -c 'import sys,urllib.parse; print(urllib.parse.urlparse(sys.argv[1]).hostname or "unknown")' "$wheel_url")" expected_sha256="$wheel_sha256"
  tmp_wheel="$work_dir/runtime-wheel.whl"
  curl_metrics="$work_dir/runtime-wheel-download.metrics"
  curl_errors="$work_dir/runtime-wheel-download.stderr"
  echo "Downloading the pinned official DeepSeek Harness Linux ARM64 runtime through the host HTTP proxy..." >&2
  curl --proxy "$proxy" --connect-timeout 10 --max-time 600 --retry 4 --retry-all-errors --silent --show-error --fail \
    --write-out 'http_code=%{http_code} downloaded_bytes=%{size_download} elapsed_seconds=%{time_total}' \
    "$wheel_url" -o "$tmp_wheel" >"$curl_metrics" 2>"$curl_errors" &
  curl_pid=$!
  curl_started_at=$SECONDS
  while kill -0 "$curl_pid" 2>/dev/null; do
    sleep 15
    if kill -0 "$curl_pid" 2>/dev/null; then
      log_stage runtime-wheel-download.heartbeat pid="$curl_pid" elapsed_seconds="$((SECONDS - curl_started_at))"
    fi
  done
  if wait "$curl_pid"; then
    wheel_download_metrics="$(cat "$curl_metrics")"
    log_stage runtime-wheel-download.complete "$wheel_download_metrics"
  else
    curl_status=$?
    curl_error_tail="$(tail -n 20 "$curl_errors" | tr '\n' ' ' | cut -c1-1200)"
    log_stage runtime-wheel-download.failed exit_code="$curl_status" elapsed_seconds="$((SECONDS - curl_started_at))" error="$curl_error_tail"
    exit "$curl_status"
  fi
  if [[ "$(shasum -a 256 "$tmp_wheel" | cut -d' ' -f1)" != "$wheel_sha256" ]]; then
    actual_wheel_sha256="$(shasum -a 256 "$tmp_wheel" | cut -d' ' -f1)"
    log_stage runtime-wheel-download.checksum-failed expected_sha256="$wheel_sha256" actual_sha256="$actual_wheel_sha256" bytes="$(wc -c < "$tmp_wheel" | tr -d ' ')"
    echo "The downloaded DeepSeek Harness runtime wheel failed its SHA-256 check." >&2
    exit 1
  fi
  mv "$tmp_wheel" "$wheel_cache"
else
  wheel_cache_hit=true
fi
cp "$wheel_cache" "$runtime_dir/runtime-wheel.whl"
log_stage runtime-wheel-ready sha256="$wheel_sha256" cache_hit="$wheel_cache_hit" bytes="$(wc -c < "$wheel_cache" | tr -d ' ')"

export HTTP_PROXY="$proxy" HTTPS_PROXY="$proxy" http_proxy="$proxy" https_proxy="$proxy"
export npm_config_proxy="$proxy" npm_config_https_proxy="$proxy"
export npm_config_os=linux npm_config_cpu=arm64 npm_config_libc=glibc
export npm_config_fetch_retries=5 npm_config_fetch_timeout=900000 npm_config_maxsockets=3 npm_config_loglevel=http
export npm_config_cache="${CSA_NPM_CACHE_DIR:-$cache_root/npm-cache}"
export NO_PROXY= no_proxy=
mkdir -p "$npm_config_cache"

log_disk_space before-npm-ci "$cache_root"
log_stage npm-ci-start os=linux cpu=arm64 cache="$npm_config_cache"
echo "Installing the version-matched TypeScript SDK and Linux ARM64 Node runtime through the host HTTP proxy..." >&2
npm ci --prefix "$runtime_dir" --no-audit --no-fund --loglevel=http \
  --ignore-scripts --force --os=linux --cpu=arm64 --libc=glibc >&2 &
npm_pid=$!
npm_started_at=$SECONDS
while kill -0 "$npm_pid" 2>/dev/null; do
  sleep 20
  if kill -0 "$npm_pid" 2>/dev/null; then
    elapsed=$((SECONDS - npm_started_at))
    echo "npm ci is still running through the host HTTP proxy (${elapsed}s elapsed; stage=${build_stage})." >&2
  fi
done
wait "$npm_pid"
log_stage npm-ci-complete elapsed_seconds="$((SECONDS - npm_started_at))"

log_stage verify-native-runtime
node_bin="$runtime_dir/node_modules/node-linux-arm64/bin/node"
if [[ ! -x "$node_bin" || "$(od -An -t x1 -N 4 "$node_bin" | xargs)" != "7f 45 4c 46" ]]; then
  echo "npm did not produce a Linux ELF Node.js runtime." >&2
  exit 1
fi
node_package_manifest="$runtime_dir/node_modules/node-linux-arm64/package.json"
if [[ ! -s "$node_package_manifest" ]]; then
  echo "The Linux ARM64 Node.js package manifest was not installed." >&2
  exit 1
fi
node_package_version="$(node -p 'require(process.argv[1]).version' "$node_package_manifest")"
node_binary_info="$(file -b "$node_bin" 2>/dev/null || true)"
if [[ "$node_package_version" != 24.* || "$node_binary_info" != *'ELF 64-bit'* || "$node_binary_info" != *'ARM aarch64'* ]]; then
  log_stage verify-native-runtime.failed node_package_version="$node_package_version" node_binary_info="$node_binary_info"
  echo "The staged Node.js executable must be a Linux ARM64 Node 24 binary." >&2
  exit 1
fi
if [[ ! -s "$runtime_dir/node_modules/@deepseek-ai/dsh-sdk-client/package.json" || ! -s "$runtime_dir/dsh-cli-stub/package.json" ]]; then
  echo "The TypeScript SDK client or its explicit-runtime stub was not installed." >&2
  exit 1
fi
if [[ "$(node -p 'require(process.argv[1]).version' "$runtime_dir/node_modules/@deepseek-ai/dsh-sdk-client/package.json")" != "$runtime_version" ]]; then
  echo "The TypeScript SDK client version does not match the official runtime wheel." >&2
  exit 1
fi
if [[ "$(shasum -a 256 "$runtime_dir/runtime-wheel.whl" | cut -d' ' -f1)" != "$wheel_sha256" ]]; then
  echo "The staged DeepSeek Harness runtime wheel failed its SHA-256 check." >&2
  exit 1
fi
log_stage verify-native-runtime.complete node_package_version="$node_package_version" node_binary_info="$node_binary_info" sdk_version="$(node -p 'require(process.argv[1]).version' "$runtime_dir/node_modules/@deepseek-ai/dsh-sdk-client/package.json")" node_bytes="$(wc -c < "$node_bin" | tr -d ' ')" sdk_dependency_count="$(node -p 'Object.keys(require(process.argv[1]).dependencies || {}).length' "$runtime_dir/node_modules/@deepseek-ai/dsh-sdk-client/package.json")"

log_stage sdk-worker-bundle
echo "Bundling the TypeScript SDK worker into a single guest module..." >&2
mkdir -p "$runtime_dir/dsh-sdk-client/dist"
cp "$runtime_dir/node_modules/@deepseek-ai/dsh-sdk-client/package.json" "$runtime_dir/dsh-sdk-client/package.json"
CSA_RUNTIME_SOURCE="$package_dir/run-task.mjs" CSA_RUNTIME_OUTPUT="$runtime_dir/dsh-sdk-client/dist/run-task.bundle.mjs" CSA_RUNTIME_NODE_MODULES="$runtime_dir/node_modules" \
  node --input-type=module <<'NODE'
import { spawnSync } from 'node:child_process';
import { stat } from 'node:fs/promises';
import { build } from 'esbuild';

const startedAt = Date.now();
process.stderr.write(`sdk_bundle.start entry=${process.env.CSA_RUNTIME_SOURCE} target=node24\n`);
await build({
  entryPoints: [process.env.CSA_RUNTIME_SOURCE],
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node24',
  nodePaths: [process.env.CSA_RUNTIME_NODE_MODULES],
  outfile: process.env.CSA_RUNTIME_OUTPUT,
  logLevel: 'info',
});
const bundlePath = process.env.CSA_RUNTIME_OUTPUT;
const bundleStat = await stat(bundlePath);
process.stderr.write(`sdk_bundle.complete bytes=${bundleStat.size} duration_ms=${Date.now() - startedAt}\n`);
const smokeStartedAt = Date.now();
process.stderr.write('sdk_bundle.import_smoke.start\n');
const smoke = spawnSync(process.execPath, [bundlePath], {
  encoding: 'utf8',
  maxBuffer: 1024 * 1024,
  env: { PATH: process.env.PATH || '/usr/bin:/bin', CSA_DSH_BUNDLE_IMPORT_SMOKE: '1' },
});
if (smoke.status !== 0 || !String(smoke.stdout || '').includes('dsh_sdk_client_import_smoke_ok')) {
  throw new Error(`The bundled DSH SDK import smoke failed (status=${smoke.status}, signal=${smoke.signal || 'none'}): ${String(smoke.stderr || smoke.stdout || '').slice(-1000)}`);
}
process.stderr.write(`sdk_bundle.import_smoke.complete duration_ms=${Date.now() - smokeStartedAt}\n`);
NODE
log_stage sdk-worker-bundle.complete bytes="$(wc -c < "$runtime_dir/dsh-sdk-client/dist/run-task.bundle.mjs" | tr -d ' ')"
log_stage sdk-worker-syntax-check.start
node --check "$runtime_dir/dsh-sdk-client/dist/run-task.bundle.mjs"
log_stage sdk-worker-syntax-check.complete
log_stage chrome-pipe-bridge-bundle.start
CSA_CHROME_BRIDGE_SOURCE="$package_dir/chrome-cdp-pipe-bridge.mjs" CSA_CHROME_BRIDGE_OUTPUT="$runtime_dir/chrome-cdp-pipe-bridge.cjs" CSA_RUNTIME_NODE_MODULES="$runtime_dir/node_modules" \
  node --input-type=module <<'NODE'
import { spawnSync } from 'node:child_process';
import { stat } from 'node:fs/promises';
import { build } from 'esbuild';

const startedAt = Date.now();
process.stderr.write(`chrome_pipe_bridge_bundle.start entry=${process.env.CSA_CHROME_BRIDGE_SOURCE} target=node24\n`);
await build({
  entryPoints: [process.env.CSA_CHROME_BRIDGE_SOURCE],
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node24',
  nodePaths: [process.env.CSA_RUNTIME_NODE_MODULES],
  outfile: process.env.CSA_CHROME_BRIDGE_OUTPUT,
  logLevel: 'info',
});
const outputPath = process.env.CSA_CHROME_BRIDGE_OUTPUT;
const outputStat = await stat(outputPath);
process.stderr.write(`chrome_pipe_bridge_bundle.complete bytes=${outputStat.size} duration_ms=${Date.now() - startedAt}\n`);
const syntax = spawnSync(process.execPath, ['--check', outputPath], { encoding: 'utf8', maxBuffer: 1024 * 1024 });
if (syntax.status !== 0) throw new Error(`Chrome pipe bridge bundle syntax check failed: ${String(syntax.stderr || syntax.stdout || '').slice(-1000)}`);
process.stderr.write('chrome_pipe_bridge_bundle.syntax_check.complete\n');
const smoke = spawnSync(process.execPath, [outputPath], {
  encoding: 'utf8',
  maxBuffer: 1024 * 1024,
  env: { PATH: process.env.PATH || '/usr/bin:/bin', CSA_CHROME_CDP_PIPE_IMPORT_SMOKE: '1' },
});
if (smoke.status !== 0 || !String(smoke.stdout || '').includes('chrome_cdp_pipe_bridge_import_smoke_ok')) {
  const smokeOutput = String(smoke.stderr || smoke.stdout || 'No smoke output.');
  throw new Error(`Chrome pipe bridge import smoke failed (status=${smoke.status}, signal=${smoke.signal || 'none'}): ${smokeOutput.slice(0, 1400)}${smokeOutput.length > 1400 ? '\n...\n' + smokeOutput.slice(-600) : ''}`);
}
process.stderr.write('chrome_pipe_bridge_bundle.import_smoke.complete\n');
NODE
log_stage chrome-pipe-bridge-bundle.complete bytes="$(wc -c < "$runtime_dir/chrome-cdp-pipe-bridge.cjs" | tr -d ' ')"
log_stage runtime-launcher-copy.start
cp "$package_dir/dsh-runtime-launcher.mjs" "$runtime_dir/dsh-runtime-launcher.mjs"
log_stage runtime-launcher-copy.complete bytes="$(wc -c < "$runtime_dir/dsh-runtime-launcher.mjs" | tr -d ' ')"

install -d "$runtime_dir/bin"
cp "$node_bin" "$runtime_dir/bin/node"
chmod 0755 "$runtime_dir/bin/node"

runtime_payload="$runtime_dir/dsh-runtime-bin"
log_stage expand-official-runtime-wheel version="$runtime_version"
echo "Expanding the pinned official runtime wheel on the Mac host..." >&2
python3 - "$runtime_dir/runtime-wheel.whl" "$runtime_payload" <<'PY'
import time
import sys
import zipfile
from pathlib import Path

wheel_path = Path(sys.argv[1])
target = Path(sys.argv[2])
started = time.monotonic()
members = {
    "deepseek_harness_runtime/deepseek-harness-runtime.json": "deepseek-harness-runtime.json",
    "deepseek_harness_runtime/runtime/deepseek-harness-sdk-runtime-linux-arm64": "runtime/deepseek-harness-sdk-runtime-linux-arm64",
    "deepseek_harness_runtime/runtime/deepseek-harness-sdk-runtime-linux-arm64-rg": "runtime/deepseek-harness-sdk-runtime-linux-arm64-rg",
    "deepseek_harness_runtime/runtime/linux-arm64/downloads.json": "runtime/linux-arm64/downloads.json",
    "deepseek_harness_runtime_bin-0.2.2rc2.dist-info/licenses/LICENSE": "LICENSE",
    "deepseek_harness_runtime_bin-0.2.2rc2.dist-info/licenses/THIRD_PARTY_NOTICES.md": "THIRD_PARTY_NOTICES.md",
}
target.mkdir(parents=True, exist_ok=True)
with zipfile.ZipFile(wheel_path) as archive:
    available = set(archive.namelist())
    missing = sorted(set(members) - available)
    if missing:
        raise SystemExit("Required official runtime wheel files are missing: " + ", ".join(missing))
    for source, relative in members.items():
        file_started = time.monotonic()
        info = archive.getinfo(source)
        destination = target / relative
        destination.parent.mkdir(parents=True, exist_ok=True)
        print(f"runtime_wheel_extract.file.start source={source} bytes={info.file_size}", flush=True)
        copied = 0
        next_report = 32 * 1024 * 1024
        with archive.open(source) as source_file, destination.open("wb") as target_file:
            while chunk := source_file.read(8 * 1024 * 1024):
                target_file.write(chunk)
                copied += len(chunk)
                if copied >= next_report and copied < info.file_size:
                    print(f"runtime_wheel_extract.file.progress source={source} copied_bytes={copied} total_bytes={info.file_size}", flush=True)
                    next_report += 32 * 1024 * 1024
        print(f"runtime_wheel_extract.file.complete target={relative} bytes={copied} duration_seconds={time.monotonic() - file_started:.3f}", flush=True)
print(f"runtime_wheel_extract.complete file_count={len(members)} duration_seconds={time.monotonic() - started:.3f}", flush=True)
PY
chmod 0755 "$runtime_payload/runtime/deepseek-harness-sdk-runtime-linux-arm64" "$runtime_payload/runtime/deepseek-harness-sdk-runtime-linux-arm64-rg"
log_stage runtime-payload.verify.start
for required_path in \
  "$runtime_payload/deepseek-harness-runtime.json" \
  "$runtime_payload/runtime/deepseek-harness-sdk-runtime-linux-arm64" \
  "$runtime_payload/runtime/deepseek-harness-sdk-runtime-linux-arm64-rg" \
  "$runtime_payload/runtime/linux-arm64/downloads.json" \
  "$runtime_payload/LICENSE" \
  "$runtime_payload/THIRD_PARTY_NOTICES.md"; do
  if [[ ! -s "$required_path" ]]; then
    echo "A required official runtime payload file is missing or empty: $required_path" >&2
    exit 1
  fi
  log_stage runtime-payload.file.verified path="${required_path#"$runtime_payload"/}" bytes="$(wc -c < "$required_path" | tr -d ' ')"
done
log_stage runtime-payload.verify.complete
printf '%s\n' "$runtime_key" > "$runtime_dir/runtime-key.sha256"
printf '%s\n' "$wheel_sha256" > "$runtime_dir/runtime-wheel.sha256"

log_stage runtime-permissions.normalize.start
# This package is installed by root but its worker and runtime execute as UID
# 1000 in each tenant microVM. Normalize the non-secret payload before the
# archive is created so its intended reader can traverse every directory.
chmod -R a+rX "$runtime_dir"
log_stage runtime-permissions.normalize.complete

tmp_archive="$work_dir/runtime.tar.gz"
log_disk_space before-archive-create "$cache_root"
log_stage archive-create.start source_bytes="$(du -sk "$runtime_dir" | awk '{print $1 * 1024}')"
tar_options=(--no-xattrs)
if tar --help 2>&1 | grep -q -- '--no-mac-metadata'; then
tar_options+=(--no-mac-metadata)
fi
COPYFILE_DISABLE=1 tar "${tar_options[@]}" -czf "$tmp_archive" -C "$runtime_dir" bin/node chrome-cdp-pipe-bridge.cjs dsh-sdk-client dsh-runtime-launcher.mjs dsh-runtime-bin runtime-key.sha256 runtime-wheel.sha256
log_stage archive-create.complete archive_bytes="$(wc -c < "$tmp_archive" | tr -d ' ')"
log_disk_space after-archive-create "$cache_root"
entry_count="$(tar -tzf "$tmp_archive" | wc -l | tr -d ' ')"
if [[ ! "$entry_count" =~ ^[0-9]+$ || "$entry_count" -gt 50 ]]; then
  echo "The compact DeepSeek runtime bundle contains an unexpected number of files: $entry_count." >&2
  exit 1
fi
tar -tzf "$tmp_archive" | grep -qx 'bin/node'
tar -tzf "$tmp_archive" | grep -qx 'chrome-cdp-pipe-bridge.cjs'
tar -tzf "$tmp_archive" | grep -qx 'dsh-sdk-client/dist/run-task.bundle.mjs'
tar -tzf "$tmp_archive" | grep -qx 'dsh-runtime-bin/runtime/deepseek-harness-sdk-runtime-linux-arm64'
mv "$tmp_archive" "$archive"
log_stage archive-verify entries="$entry_count" bytes="$(stat -f%z "$archive" 2>/dev/null || wc -c < "$archive" | tr -d ' ')"
archive_sha256="$(shasum -a 256 "$archive" | cut -d' ' -f1)"
printf 'bundle_entries=%s\n' "$entry_count" >&2
log_stage complete sha256="$archive_sha256" runtime_key="${runtime_key:0:16}"
printf '%s\t%s\t%s\n' "$archive" "$runtime_key" "$archive_sha256" >&3
