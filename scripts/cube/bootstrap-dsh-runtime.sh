#!/usr/bin/env bash
set -Eeuo pipefail

runtime_dir=/opt/csa-agent-runtime
state_dir=/var/lib/csa-agent-runtime
lock_hash_file="$state_dir/package-lock.sha256"
wheel_hash_file="$state_dir/runtime-wheel.sha256"
runtime_key_file="$state_dir/runtime-key.sha256"
runtime_key_expected_file="$state_dir/runtime-key.expected.sha256"
ready_file="$state_dir/ready"
phase_file="$state_dir/install.phase"
node_bin="$runtime_dir/bin/node"
dsh_executable="$runtime_dir/dsh-runtime-bin/runtime/deepseek-harness-sdk-runtime-linux-arm64"
dsh_rg="$dsh_executable-rg"
runtime_payload="$runtime_dir/dsh-runtime-bin"
bundle_file=/tmp/csa-dsh-runtime-linux-arm64.tar.gz
bundle_hash_file="$bundle_file.sha256"
install_started_at=$SECONDS
current_phase=starting

log_guest_capacity() {
  local stage="$1"
  printf 'dsh_runtime_capacity tenant_id=%s run_id=%s stage=%s timestamp=%s\n' "${CSA_TENANT_ID:-unknown}" "${CSA_RUN_ID:-none}" "$stage" "$(date -u +%FT%TZ)"
  df -B1 -P "$runtime_dir" /tmp 2>&1 | tail -n +2 | while IFS= read -r line; do
    printf 'dsh_runtime_capacity_filesystem tenant_id=%s run_id=%s stage=%s %s\n' "${CSA_TENANT_ID:-unknown}" "${CSA_RUN_ID:-none}" "$stage" "$line"
  done
  if [[ -r /proc/meminfo ]]; then
    awk -v tenant_id="${CSA_TENANT_ID:-unknown}" -v run_id="${CSA_RUN_ID:-none}" '/^(MemAvailable|MemTotal):/ { printf "dsh_runtime_capacity_memory tenant_id=%s run_id=%s stage=%s %s=%s kB\n", tenant_id, run_id, stage, $1, $2 }' stage="$stage" /proc/meminfo
  fi
}

mark_phase() {
  current_phase="$1"
  local now
  now="$(date -u +%FT%TZ)"
  printf '%s\t%s\n' "$now" "$current_phase" > "$phase_file"
  printf 'dsh_runtime_phase tenant_id=%s run_id=%s stage=%s timestamp=%s elapsed_seconds=%s\n' "${CSA_TENANT_ID:-unknown}" "${CSA_RUN_ID:-none}" "$current_phase" "$now" "$((SECONDS - install_started_at))"
}

on_error() {
  local status=$?
  trap - ERR
  current_phase="failed:${current_phase}"
  local now
  now="$(date -u +%FT%TZ 2>/dev/null || true)"
  printf '%s\t%s\n' "$now" "$current_phase" > "$phase_file" 2>/dev/null || true
  printf 'dsh_runtime_step_failed tenant_id=%s run_id=%s stage=%s exit_code=%s line=%s command=%q timestamp=%s elapsed_seconds=%s\n' "${CSA_TENANT_ID:-unknown}" "${CSA_RUN_ID:-none}" "$current_phase" "$status" "${BASH_LINENO[0]:-unknown}" "${BASH_COMMAND:-unknown}" "$now" "$((SECONDS - install_started_at))" >&2
  exit "$status"
}
trap on_error ERR

install -d -m 0755 "$runtime_dir" "$state_dir"
mark_phase preflight
log_guest_capacity preflight
if [[ ! -s "$runtime_dir/package.json" || ! -s "$runtime_dir/package-lock.json" || ! -s "$runtime_dir/runtime-manifest.json" ]]; then
  echo "DeepSeek Harness runtime manifests were not provided." >&2
  exit 1
fi

expected_lock_hash="$(sha256sum "$runtime_dir/package-lock.json" | cut -d' ' -f1)"
expected_wheel_hash="$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["runtimeWheelSha256"])' "$runtime_dir/runtime-manifest.json")"
runtime_version="$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["deepseekHarnessVersion"])' "$runtime_dir/runtime-manifest.json")"
expected_runtime_key="$(cat "$runtime_key_expected_file" 2>/dev/null || true)"
current_lock_hash="$(cat "$lock_hash_file" 2>/dev/null || true)"
current_wheel_hash="$(cat "$wheel_hash_file" 2>/dev/null || true)"
current_runtime_key="$(cat "$runtime_key_file" 2>/dev/null || true)"
if [[ "$expected_runtime_key" =~ ^[a-f0-9]{64}$ && "$current_lock_hash" == "$expected_lock_hash" && "$current_wheel_hash" == "$expected_wheel_hash" && "$current_runtime_key" == "$expected_runtime_key" && -s "$ready_file" && -x "$node_bin" && -s "$runtime_dir/chrome-cdp-pipe-bridge.cjs" && -s "$runtime_dir/dsh-sdk-client/dist/run-task.bundle.mjs" && -s "$runtime_dir/dsh-sdk-client/package.json" && -s "$runtime_dir/dsh-runtime-launcher.mjs" && -x "$dsh_executable" && -x "$dsh_rg" ]]; then
  mark_phase verify-reuse
  if "$node_bin" -e 'const [major, minor] = process.versions.node.split(".").map(Number); process.exit(major > 24 || (major === 24 && minor >= 9) ? 0 : 1)' >/dev/null 2>&1; then
    echo "DeepSeek Harness runtime already installed."
    mark_phase complete
    exit 0
  fi
fi

mark_phase stage-inputs
rm -f "$ready_file"
if [[ ! "$expected_runtime_key" =~ ^[a-f0-9]{64}$ ]]; then
  echo "The expected runtime key was not provided by the control plane." >&2
  exit 1
fi
archive_runtime_key="$(cat "$runtime_dir/runtime-key.sha256" 2>/dev/null || true)"
archive_wheel_hash="$(cat "$runtime_dir/runtime-wheel.sha256" 2>/dev/null || true)"
if [[ "$archive_runtime_key" == "$expected_runtime_key" && "$archive_wheel_hash" == "$expected_wheel_hash" \
  && -x "$node_bin" && -s "$runtime_dir/dsh-sdk-client/dist/run-task.bundle.mjs" \
  && -s "$runtime_dir/dsh-sdk-client/package.json" && -s "$runtime_dir/chrome-cdp-pipe-bridge.cjs" && -s "$runtime_dir/dsh-runtime-launcher.mjs" \
  && -x "$dsh_executable" && -x "$dsh_rg" \
  && -s "$runtime_payload/runtime/linux-arm64/downloads.json" ]]; then
  echo "Reusing the previously extracted, checksum-matched runtime files: $(date -u +%FT%TZ)."
else
  mark_phase verify-archive
  if [[ ! -s "$bundle_file" ]]; then
    echo "Pre-downloaded Linux ARM64 DeepSeek Harness dependencies were not provided." >&2
    exit 1
  fi
  expected_archive_hash="$(cat "$bundle_hash_file" 2>/dev/null || true)"
  if [[ ! "$expected_archive_hash" =~ ^[a-f0-9]{64}$ ]]; then
    echo "The runtime dependency archive checksum was not provided." >&2
    exit 1
  fi
  archive_hash_started_at=$SECONDS
  echo "dsh_runtime_archive_checksum_start expected_sha256=$expected_archive_hash timestamp=$(date -u +%FT%TZ)"
  actual_archive_hash="$(sha256sum "$bundle_file" | cut -d' ' -f1)"
  echo "dsh_runtime_archive_checksum_complete actual_sha256=$actual_archive_hash elapsed_seconds=$((SECONDS - archive_hash_started_at)) timestamp=$(date -u +%FT%TZ)"
  if [[ "$actual_archive_hash" != "$expected_archive_hash" ]]; then
    echo "The runtime dependency archive checksum does not match." >&2
    exit 1
  fi
  echo "Preparing compact runtime paths without traversing inherited npm directories: $(date -u +%FT%TZ)."
  install -d -m 0755 "$runtime_dir/bin" "$runtime_dir/dsh-runtime-bin"
  echo "The bundled worker is self-contained; inherited node_modules are not on its execution path."
  rm -f "$runtime_dir/runtime-wheel.whl"
  mark_phase extract-archive
  archive_bytes="$(stat -c %s "$bundle_file")"
  extract_started_at=$SECONDS
  log_guest_capacity before-archive-extract
  echo "dsh_runtime_archive_extract_start bytes=$archive_bytes timestamp=$(date -u +%FT%TZ) progress_interval_seconds=30"
  tar -xzf "$bundle_file" --no-same-owner -C "$runtime_dir" &
  tar_pid=$!
  (
    while kill -0 "$tar_pid" 2>/dev/null; do
      sleep 30
      kill -0 "$tar_pid" 2>/dev/null || break
      archive_read_bytes=unknown
      archive_write_bytes=unknown
      archive_rss_kb=unknown
      if [[ -r "/proc/$tar_pid/io" ]]; then
        archive_read_bytes="$(awk '$1 == "rchar:" { print $2 }' "/proc/$tar_pid/io" 2>/dev/null || true)"
        archive_write_bytes="$(awk '$1 == "write_bytes:" { print $2 }' "/proc/$tar_pid/io" 2>/dev/null || true)"
      fi
      if [[ -r "/proc/$tar_pid/status" ]]; then
        archive_rss_kb="$(awk '$1 == "VmRSS:" { print $2 }' "/proc/$tar_pid/status" 2>/dev/null || true)"
      fi
      node_bytes=0
      [[ ! -f "$node_bin" ]] || node_bytes="$(stat -c %s "$node_bin" 2>/dev/null || echo unknown)"
      printf 'dsh_runtime_archive_extract_progress pid=%s archive_read_bytes=%s archive_bytes=%s extracted_write_bytes=%s node_binary_bytes=%s rss_kb=%s elapsed_seconds=%s timestamp=%s\n' \
        "$tar_pid" "${archive_read_bytes:-unknown}" "$archive_bytes" "${archive_write_bytes:-unknown}" "$node_bytes" "${archive_rss_kb:-unknown}" "$((SECONDS - extract_started_at))" "$(date -u +%FT%TZ)"
    done
  ) &
  extract_progress_pid=$!
  if wait "$tar_pid"; then
    extract_status=0
  else
    extract_status=$?
  fi
  kill "$extract_progress_pid" 2>/dev/null || true
  wait "$extract_progress_pid" 2>/dev/null || true
  if ((extract_status != 0)); then
    printf 'dsh_runtime_archive_extract_failed exit_code=%s elapsed_seconds=%s timestamp=%s\n' "$extract_status" "$((SECONDS - extract_started_at))" "$(date -u +%FT%TZ)" >&2
    exit "$extract_status"
  fi
  echo "dsh_runtime_archive_extract_complete bytes=$archive_bytes elapsed_seconds=$((SECONDS - extract_started_at)) timestamp=$(date -u +%FT%TZ)"
  log_guest_capacity after-archive-extract
  archive_runtime_key="$(cat "$runtime_dir/runtime-key.sha256" 2>/dev/null || true)"
  archive_wheel_hash="$(cat "$runtime_dir/runtime-wheel.sha256" 2>/dev/null || true)"
fi
desktop_user="$(getent passwd 1000 | cut -d: -f1)"
if [[ -z "$desktop_user" ]]; then
  echo "The Linux desktop user with UID 1000 is missing." >&2
  exit 1
fi
desktop_uid="$(id -u "$desktop_user")"
desktop_gid="$(id -g "$desktop_user")"
echo "dsh_runtime_permissions_normalize_start runtime_dir=$runtime_dir desktop_uid=$desktop_uid timestamp=$(date -u +%FT%TZ)"
# The runtime runs as the desktop user, while the Cube guest installer runs as
# root with a private umask. Set only the known runtime directories and files
# needed by UID 1000, avoiding an unbounded recursive chmod on an inherited VM.
permission_started_at=$SECONDS
chmod 0755 \
  "$runtime_dir" \
  "$runtime_dir/bin" \
  "$runtime_dir/dsh-sdk-client" \
  "$runtime_dir/dsh-sdk-client/dist" \
  "$runtime_payload" \
  "$runtime_payload/runtime" \
  "$runtime_payload/runtime/linux-arm64"
echo "dsh_runtime_permissions_directories_complete elapsed_seconds=$((SECONDS - permission_started_at)) timestamp=$(date -u +%FT%TZ)"
chmod 0644 \
  "$runtime_dir/package.json" \
  "$runtime_dir/package-lock.json" \
  "$runtime_dir/runtime-manifest.json" \
  "$runtime_dir/computer-plugin.mjs" \
  "$runtime_dir/chrome-cdp-pipe-bridge.cjs" \
  "$runtime_dir/dsh-sdk-client/package.json" \
  "$runtime_dir/dsh-sdk-client/dist/run-task.bundle.mjs" \
  "$runtime_dir/dsh-runtime-launcher.mjs" \
  "$runtime_payload/deepseek-harness-runtime.json" \
  "$runtime_payload/LICENSE" \
  "$runtime_payload/THIRD_PARTY_NOTICES.md" \
  "$runtime_payload/runtime/linux-arm64/downloads.json" \
  "$runtime_dir/runtime-key.sha256" \
  "$runtime_dir/runtime-wheel.sha256"
echo "dsh_runtime_permissions.files_complete elapsed_seconds=$((SECONDS - permission_started_at)) timestamp=$(date -u +%FT%TZ)"
chmod 0755 "$node_bin" "$dsh_executable" "$dsh_rg"
echo "dsh_runtime_permissions_normalize_complete runtime_dir=$runtime_dir desktop_uid=$desktop_uid elapsed_seconds=$((SECONDS - permission_started_at)) timestamp=$(date -u +%FT%TZ)"
run_as_desktop_user() {
  setpriv --reuid="$desktop_uid" --regid="$desktop_gid" --init-groups -- "$@"
}
mark_phase verify-runtime-files
echo "dsh_runtime_manifest_verified runtime_version=$runtime_version runtime_key_prefix=${archive_runtime_key:0:16} wheel_sha256_prefix=${archive_wheel_hash:0:16} timestamp=$(date -u +%FT%TZ)"
if [[ "$archive_runtime_key" != "$expected_runtime_key" ]]; then
  echo "The runtime bundle key does not match the version prepared by the control plane." >&2
  exit 1
fi
if [[ "$archive_wheel_hash" != "$expected_wheel_hash" ]]; then
  echo "The runtime bundle wheel checksum does not match the pinned official wheel." >&2
  exit 1
fi
mark_phase activate-runtime
echo "Activating the pre-expanded DeepSeek Harness ${runtime_version} runtime: $(date -u +%FT%TZ)."
chmod 0755 "$dsh_executable" "$dsh_rg"
chmod 0755 "$node_bin"
rm -f "$bundle_file" "$bundle_hash_file"

export PATH="$runtime_dir/bin:$runtime_dir:$PATH"
if [[ ! -x "$node_bin" ]]; then
  echo "The pinned Node.js runtime did not install." >&2
  exit 1
fi
if ! "$node_bin" -e 'const [major, minor] = process.versions.node.split(".").map(Number); process.exit(major > 24 || (major === 24 && minor >= 9) ? 0 : 1)'; then
  echo "DeepSeek Harness requires Node.js 24.9.0 or newer." >&2
  exit 1
fi
if [[ ! -s "$runtime_dir/dsh-runtime-launcher.mjs" ]]; then
  echo "The TypeScript runtime launcher was not staged." >&2
  exit 1
fi
if [[ ! -s "$runtime_dir/chrome-cdp-pipe-bridge.cjs" ]]; then
  echo "The Chrome CDP pipe bridge was not staged." >&2
  exit 1
fi
if [[ ! -s "$runtime_dir/dsh-sdk-client/dist/run-task.bundle.mjs" || ! -s "$runtime_dir/dsh-sdk-client/package.json" ]]; then
  echo "The bundled TypeScript SDK worker was not installed." >&2
  exit 1
fi
sdk_client_version="$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["version"])' "$runtime_dir/dsh-sdk-client/package.json")"
if [[ "$sdk_client_version" != "$runtime_version" ]]; then
  echo "The bundled worker package manifest does not match the pinned SDK runtime version." >&2
  exit 1
fi
if [[ ! -s "$runtime_payload/runtime/linux-arm64/downloads.json" ]]; then
  echo "The official runtime platform manifest was not installed." >&2
  exit 1
fi

mark_phase sdk-import-smoke
node_version="$("$node_bin" --version)"
echo "dsh_runtime_sdk_smoke_start sdk_version=$runtime_version node_version=$node_version timestamp=$(date -u +%FT%TZ)"
echo "Starting bundled DSH SDK client import smoke check: $(date -u +%FT%TZ)."
if ! run_as_desktop_user env CSA_DSH_BUNDLE_IMPORT_SMOKE=1 "$node_bin" "$runtime_dir/dsh-sdk-client/dist/run-task.bundle.mjs"; then
  echo "The bundled DSH SDK client failed its import smoke check." >&2
  exit 1
fi
echo "Bundled DSH SDK client import smoke check passed: $(date -u +%FT%TZ)."

smoke_home="$(mktemp -d /tmp/csa-dsh-profile-smoke.XXXXXX)"
chown "$desktop_uid:$desktop_gid" "$smoke_home"
chmod 0700 "$smoke_home"
mark_phase profile-smoke
echo "Starting offline DSH profile smoke check with a 540 second limit: $(date -u +%FT%TZ)."
if ! timeout 540s setpriv --reuid="$desktop_uid" --regid="$desktop_gid" --init-groups -- \
  env DSH_HOME="$smoke_home" CSA_DSH_RUNTIME_EXECUTABLE="$dsh_executable" \
  "$node_bin" "$runtime_dir/dsh-runtime-launcher.mjs" --profile sdk-minimal --dump-default-config >/dev/null; then
  rm -rf "$smoke_home"
  echo "DeepSeek Harness sdk-minimal profile failed or timed out during its offline startup check." >&2
  exit 1
fi
rm -rf "$smoke_home"
echo "Offline DSH profile smoke check passed: $(date -u +%FT%TZ)."
rm -f "$runtime_dir/run-task.bundle.mjs"

mark_phase write-ready-markers
printf '%s\n' "$expected_lock_hash" > "$lock_hash_file"
printf '%s\n' "$expected_wheel_hash" > "$wheel_hash_file"
printf '%s\n' "$expected_runtime_key" > "$runtime_key_file"
chmod 0644 "$lock_hash_file" "$wheel_hash_file" "$runtime_key_file"
printf '%s\n' "$(date -u +%FT%TZ)" > "$ready_file"
chmod 0644 "$ready_file"
printf 'dsh_runtime_ready node=%s dsh=%s\n' "$("$node_bin" --version)" "$runtime_version"
mark_phase complete
