#!/usr/bin/env bash
set -Eeuo pipefail

build_started_at=$SECONDS
umask 077
script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
package_source="$script_dir/pi-runtime"
computer_source="$script_dir/dsh-runtime/computer-plugin.mjs"
cache_root="${CSA_AGENT_RUNTIME_CACHE_DIR:-$HOME/.cache/csa-cube-node/runtime-cache}"
log_root="${CSA_BUILD_LOG_DIR:-$HOME/.local/share/csa-cube-node/build-logs}"
proxy="${CSA_NPM_HTTP_PROXY:-http://127.0.0.1:7890}"
runtime_key="${CSA_EXPECTED_RUNTIME_KEY:-}"
mkdir -p "$cache_root" "$log_root"
log_path="$log_root/pi-runtime-build-$(date -u +%Y-%m-%dT%H-%M-%SZ)-$$.log"
: > "$log_path"
chmod 0600 "$log_path"
exec 3>&1 4>&2
exec > >(tee -a "$log_path" >&4)
exec 2> >(tee -a "$log_path" >&4)

log_stage() {
  printf 'runtime_bundle_stage stage=%s elapsed_seconds=%s timestamp=%s %s\n' \
    "$1" "$((SECONDS - build_started_at))" "$(date -u +%FT%TZ)" "$2" >&2
}

if [[ ! "$runtime_key" =~ ^[a-f0-9]{64}$ ]]; then
  echo "CSA_EXPECTED_RUNTIME_KEY must contain a SHA-256 runtime key." >&2
  exit 1
fi
if [[ ! -s "$package_source/package.json" || ! -s "$package_source/package-lock.json" || ! -s "$package_source/run-task.mjs" || ! -s "$computer_source" || ! -s "$package_source/runtime-manifest.json" ]]; then
  echo "Pi runtime source package is incomplete." >&2
  exit 1
fi
if [[ ! "$proxy" =~ ^https?://[^[:space:]]+$ ]]; then
  echo "Pi runtime npm HTTP proxy is invalid." >&2
  exit 1
fi

archive="$cache_root/pi-runtime-linux-arm64-$runtime_key.tar.gz"
checksum_path="$archive.sha256"
if [[ -s "$archive" && -s "$checksum_path" ]]; then
  expected_sha="$(cat "$checksum_path")"
  actual_sha="$(shasum -a 256 "$archive" | awk '{print $1}')"
  if [[ "$actual_sha" == "$expected_sha" ]]; then
    log_stage cache.hit "runtime_key=${runtime_key:0:16} bytes=$(wc -c < "$archive" | tr -d ' ') sha256=$actual_sha"
    printf '%s\t%s\t%s\n' "$archive" "$runtime_key" "$actual_sha" >&3
    exit 0
  fi
  rm -f "$archive" "$checksum_path"
  log_stage cache.invalidate "runtime_key=${runtime_key:0:16} reason=checksum_mismatch"
fi

log_stage build.start "runtime_key=${runtime_key:0:16} package=@mariozechner/pi-coding-agent version=0.73.1 proxy_configured=true"
df -Pk "$cache_root" >&2
work_dir="$(mktemp -d "$cache_root/.pi-runtime.XXXXXX")"
cleanup() { rm -rf "$work_dir"; }
trap cleanup EXIT
runtime_dir="$work_dir/runtime"
mkdir -p "$runtime_dir"
cp "$package_source/package.json" "$package_source/package-lock.json" "$package_source/runtime-manifest.json" "$package_source/run-task.mjs" "$runtime_dir/"
cp "$computer_source" "$runtime_dir/computer-plugin.mjs"
chmod 0644 "$runtime_dir/package.json" "$runtime_dir/package-lock.json" "$runtime_dir/runtime-manifest.json" "$runtime_dir/run-task.mjs" "$runtime_dir/computer-plugin.mjs"

export HTTP_PROXY="$proxy" HTTPS_PROXY="$proxy" http_proxy="$proxy" https_proxy="$proxy"
export npm_config_proxy="$proxy" npm_config_https_proxy="$proxy"
export npm_config_os=linux npm_config_cpu=arm64 npm_config_libc=glibc
export npm_config_fetch_retries=5 npm_config_fetch_timeout=900000 npm_config_maxsockets=3
npm_config_cache="${CSA_NPM_CACHE_DIR:-$cache_root/npm-cache}"
export npm_config_cache
export NO_PROXY= no_proxy=
mkdir -p "$npm_config_cache"

log_stage npm-ci.start "package=@mariozechner/pi-coding-agent proxy=$proxy"
umask 022
npm ci --prefix "$runtime_dir" --no-audit --no-fund --ignore-scripts --omit=dev --loglevel=http >&2 &
npm_pid=$!
npm_started_at=$SECONDS
while kill -0 "$npm_pid" 2>/dev/null; do
  sleep 20
  if kill -0 "$npm_pid" 2>/dev/null; then
    log_stage npm-ci.heartbeat "elapsed_seconds=$((SECONDS - npm_started_at))"
  fi
done
if wait "$npm_pid"; then
  log_stage npm-ci.complete "elapsed_seconds=$((SECONDS - npm_started_at))"
else
  npm_status=$?
  log_stage npm-ci.failed "exit_code=$npm_status"
  exit "$npm_status"
fi
umask 077

pi_manifest="$runtime_dir/node_modules/@mariozechner/pi-coding-agent/package.json"
if [[ ! -s "$pi_manifest" ]]; then
  log_stage verify.failed "reason=pi_sdk_package_missing"
  exit 1
fi
pi_version="$(node -p 'require(process.argv[1]).version' "$pi_manifest")"
if [[ "$pi_version" != "0.73.1" ]]; then
  log_stage verify.failed "reason=pi_sdk_version_mismatch actual=$pi_version"
  exit 1
fi
log_stage verify.complete "package_version=$pi_version package_count=$(find "$runtime_dir/node_modules" -mindepth 1 -maxdepth 1 | wc -l | tr -d ' ')"

if command -v xattr >/dev/null 2>&1; then
  log_stage archive.metadata-cleanup.start "remove_macos_provenance=true staging_directory=$runtime_dir"
  xattr -cr "$runtime_dir"
  log_stage archive.metadata-cleanup.complete "remove_macos_provenance=true"
fi

tmp_archive="$archive.tmp-$$"
log_stage archive.start "destination=$archive"
tar -czf "$tmp_archive" -C "$runtime_dir" package.json package-lock.json runtime-manifest.json run-task.mjs computer-plugin.mjs node_modules
archive_bytes="$(wc -c < "$tmp_archive" | tr -d ' ')"
archive_sha="$(shasum -a 256 "$tmp_archive" | awk '{print $1}')"
mv "$tmp_archive" "$archive"
printf '%s\n' "$archive_sha" > "$checksum_path"
chmod 0600 "$archive" "$checksum_path"
log_stage archive.complete "bytes=$archive_bytes sha256=$archive_sha elapsed_seconds=$((SECONDS - build_started_at))"
df -Pk "$cache_root" >&2
printf '%s\t%s\t%s\n' "$archive" "$runtime_key" "$archive_sha" >&3
