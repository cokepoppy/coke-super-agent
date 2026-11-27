#!/usr/bin/env bash
set -Eeuo pipefail

started_at=$SECONDS
umask 077
repo_root="$(cd "$(dirname "$0")/../.." && pwd)"
cache_root="${CSA_AGENT_RUNTIME_CACHE_DIR:-$HOME/.local/share/csa-cube-node/runtime-cache}"
log_directory="${CSA_BUILD_LOG_DIR:-$HOME/.local/share/csa-cube-node/build-logs}"
base_image="${CSA_DOCKER_DESKTOP_BASE_IMAGE:-csa-super-agent-desktop:20261127.1}"
image_tag="${CSA_DOCKER_DESKTOP_BUILD_TAG:-csa-super-agent-desktop:20261127.8}"
mkdir -p "$log_directory"
build_log="$log_directory/docker-desktop-build-$(date -u +%Y-%m-%dT%H-%M-%SZ)-$$.log"
: > "$build_log"
chmod 0600 "$build_log"
exec 3>&1 4>&2
exec > >(tee -a "$build_log" >&4)
exec 2> >(tee -a "$build_log" >&4)

build_stage=preflight
build_context=""
on_error() {
  local status=$?
  trap - ERR
  printf 'docker_desktop_build.failed stage=%s exit_code=%s line=%s elapsed_seconds=%s log_file=%s\n' \
    "$build_stage" "$status" "${BASH_LINENO[0]:-unknown}" "$((SECONDS - started_at))" "$build_log" >&2
  exit "$status"
}
cleanup() {
  if [[ -n "$build_context" && -d "$build_context" ]]; then
    rm -rf "$build_context"
    printf 'docker_desktop_build.context.cleaned path=%s\n' "$build_context" >&2
  fi
}
trap on_error ERR
trap cleanup EXIT

log_stage() {
  build_stage="$1"
  shift
  printf 'docker_desktop_build.stage stage=%s elapsed_seconds=%s timestamp=%s log_file=%s %s\n' \
    "$build_stage" "$((SECONDS - started_at))" "$(date -u +%FT%TZ)" "$build_log" "$*" >&2
}

if ! docker image inspect "$base_image" >/dev/null 2>&1; then
  log_stage base-image.missing image="$base_image"
  echo "The local desktop base image is not available: $base_image" >&2
  exit 1
fi
if docker image inspect "$image_tag" >/dev/null 2>&1; then
  log_stage output-tag.exists image="$image_tag"
  echo "Refusing to overwrite an existing local image tag: $image_tag" >&2
  exit 1
fi
base_info="$(docker image inspect --format '{{.Id}} {{.Os}}/{{.Architecture}} {{.Size}}' "$base_image")"
log_stage preflight.complete base_image="$base_image" base_info="$base_info" output_image="$image_tag" cache_root="$cache_root"
df -h "$cache_root" >&2

build_stage=runtime-bundle.prepare
log_stage runtime-bundle.prepare.start proxy_configured="$([[ -n "${CSA_NPM_HTTP_PROXY:-}" || "$(uname -s)" == Darwin ]] && echo true || echo false)"
bundle_info="$(CSA_AGENT_RUNTIME_CACHE_DIR="$cache_root" bash "$repo_root/scripts/cube/prepare-dsh-runtime-linux-arm64.sh")"
IFS=$'\t' read -r bundle_path runtime_key bundle_sha256 <<< "$bundle_info"
if [[ ! -s "$bundle_path" || ! "$runtime_key" =~ ^[a-f0-9]{64}$ || ! "$bundle_sha256" =~ ^[a-f0-9]{64}$ ]]; then
  echo "The DSH runtime builder did not return a valid archive, key, and checksum." >&2
  exit 1
fi
actual_sha256="$(shasum -a 256 "$bundle_path" | awk '{print $1}')"
if [[ "$actual_sha256" != "$bundle_sha256" ]]; then
  echo "The cached DSH runtime bundle checksum does not match its build record." >&2
  exit 1
fi
log_stage runtime-bundle.prepare.complete runtime_key="${runtime_key:0:16}" archive_bytes="$(stat -f%z "$bundle_path" 2>/dev/null || wc -c < "$bundle_path" | tr -d ' ')" sha256="$bundle_sha256"

build_context="$(mktemp -d "${TMPDIR:-/tmp}/csa-docker-desktop-build.XXXXXX")"
chmod 0700 "$build_context"
mkdir -p "$build_context/runtime"
cp "$repo_root/images/coke-super-agent-docker-desktop/Dockerfile" "$build_context/Dockerfile"
cp "$repo_root/images/coke-super-agent-docker-desktop/start-csa-desktop.sh" "$build_context/start-csa-desktop.sh"
cp "$repo_root/scripts/cube/dsh-runtime/computer-plugin.mjs" "$build_context/computer-plugin.mjs"
cp "$repo_root/scripts/cube/dsh-runtime/remote-terminal-plugin.mjs" "$build_context/remote-terminal-plugin.mjs"
log_stage runtime-bundle.extract.start archive="$bundle_path"
tar -xzf "$bundle_path" -C "$build_context/runtime"
# The bundle is normalized before archiving, but this build runs with umask
# 077. Restore the archive's public read/traverse bits before Docker snapshots
# the context so DSH UID 1001 can load the runtime and CDP bridge.
chmod -R a+rX "$build_context/runtime"
test -s "$build_context/runtime/bin/node"
test -s "$build_context/runtime/dsh-sdk-client/dist/run-task.bundle.mjs"
test -s "$build_context/runtime/runtime-key.sha256"
test "$(cat "$build_context/runtime/runtime-key.sha256")" = "$runtime_key"
test -s "$build_context/runtime/dsh-runtime-bin/runtime/deepseek-harness-sdk-runtime-linux-arm64"
log_stage runtime-bundle.extract.complete runtime_key="${runtime_key:0:16}" staged_bytes="$(du -sk "$build_context" | awk '{print $1 * 1024}')"

build_stage=docker.build
log_stage docker.build.start image="$image_tag" context_bytes="$(du -sk "$build_context" | awk '{print $1 * 1024}')"
docker build --pull=false --progress=plain \
  --build-arg "CSA_DESKTOP_BASE_IMAGE=$base_image" \
  --label "com.coke-super-agent.dsh-runtime-key=$runtime_key" \
  --tag "$image_tag" "$build_context"
image_info="$(docker image inspect --format '{{.Id}} {{.Os}}/{{.Architecture}} {{.Size}}' "$image_tag")"
log_stage docker.build.complete image="$image_tag" image_info="$image_info"
log_stage complete elapsed_seconds="$((SECONDS - started_at))" log_file="$build_log"
printf '%s\n' "$image_tag"
