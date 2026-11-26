#!/usr/bin/env bash
set -Eeuo pipefail

export DEBIAN_FRONTEND=noninteractive
export LANG=C.UTF-8
unset HTTP_PROXY HTTPS_PROXY ALL_PROXY http_proxy https_proxy all_proxy
state_dir=/var/lib/csa-desktop
apt_log="$state_dir/apt.log"
bootstrap_started_at=$SECONDS
bootstrap_phase=starting
desktop_user=
desktop_uid=
session_group_pid=
session_launcher_pid=
keep_session=0

install -d -m 0755 "$state_dir"

read_monotonic_centiseconds() {
  local target_name="$1" uptime_raw uptime_idle whole_seconds fractional_seconds
  read -r uptime_raw uptime_idle </proc/uptime || return 1
  whole_seconds="${uptime_raw%%.*}"
  fractional_seconds="${uptime_raw#*.}"
  fractional_seconds="${fractional_seconds}00"
  fractional_seconds="${fractional_seconds:0:2}"
  [[ "$whole_seconds" =~ ^[0-9]+$ && "$fractional_seconds" =~ ^[0-9]+$ ]] || return 1
  printf -v "$target_name" '%d' "$((10#$whole_seconds * 100 + 10#$fractional_seconds))"
}

log_event() {
  local stage="$1"
  local line status_tmp
  shift
  line="$(printf 'desktop_bootstrap timestamp=%s elapsed_seconds=%s tenant_id=%s sandbox_id=%s generation=%s run_id=%s phase=%s stage=%s %s' \
    "$(date -u +%FT%TZ)" "$((SECONDS - bootstrap_started_at))" "${CSA_TENANT_ID:-unknown}" "${CSA_CUBE_SANDBOX_ID:-unknown}" "${CSA_COMPUTER_GENERATION:-unknown}" "${CSA_RUN_ID:-none}" "$bootstrap_phase" "$stage" "$*")"
  printf '%s\n' "$line"
  status_tmp="$state_dir/bootstrap.status.$$"
  printf '%s\n' "$line" >"$status_tmp"
  mv -f "$status_tmp" "$state_dir/bootstrap.status"
}

mark_phase() {
  bootstrap_phase="$1"
  log_event phase.start
}

log_capacity() {
  local stage="$1"
  local disk memory
  disk="$(df -Pk / | awk 'NR == 2 { printf "total_bytes=%.0f used_bytes=%.0f available_bytes=%.0f mount=%s", $2 * 1024, $3 * 1024, $4 * 1024, $NF }')"
  memory="$(awk '/^(MemTotal|MemAvailable):/ { printf "%s=%s_kB ", $1, $2 }' /proc/meminfo 2>/dev/null || true)"
  log_event "$stage" "$disk" "$memory"
}

on_error() {
  local status=$?
  trap - ERR
  local command
  printf -v command '%q' "${BASH_COMMAND:-unknown}"
  log_event failed "exit_code=$status line=${BASH_LINENO[0]:-unknown} command=${command:0:500}"
  if [[ -s "$apt_log" ]]; then
    log_event apt-log.tail.begin
    tail -n 30 "$apt_log" >&2 || true
    log_event apt-log.tail.end
  fi
  if [[ -s /tmp/csa-desktop-session.log ]]; then
    log_event desktop-session-log.tail.begin
    tail -n 30 /tmp/csa-desktop-session.log >&2 || true
    log_event desktop-session-log.tail.end
  fi
  exit "$status"
}

session_group_has_identity() {
  local pid command uid
  [[ "$session_group_pid" =~ ^[0-9]+$ && "$desktop_uid" =~ ^[0-9]+$ ]] || return 1
  while read -r pid; do
    [[ "$pid" =~ ^[0-9]+$ && -r "/proc/$pid/cmdline" ]] || continue
    command="$(tr '\0' ' ' <"/proc/$pid/cmdline" 2>/dev/null || true)"
    uid="$(awk '/^Uid:/ {print $2; exit}' "/proc/$pid/status" 2>/dev/null || true)"
    [[ "$uid" == "$desktop_uid" && "$command" == *csa-desktop-session* ]] && return 0
  done < <(ps -eo pid=,pgid= | awk -v pgid="$session_group_pid" '$2 == pgid {print $1}')
  return 1
}

session_group_live_members() {
  ps -eo pid=,pgid=,stat= | awk -v pgid="$session_group_pid" '$2 == pgid && $3 !~ /Z|X/ {print $1}'
}

stop_desktop_session_group() {
  local members attempt
  [[ "$session_group_pid" =~ ^[0-9]+$ ]] || return 0
  if ! session_group_has_identity; then
    log_event desktop-session.cleanup.skipped "reason=process-group-identity-mismatch pgid=$session_group_pid"
    return 0
  fi
  log_event desktop-session.cleanup.term "pgid=$session_group_pid members=$(session_group_live_members | tr '\n' ',')"
  kill -TERM -- "-$session_group_pid" 2>/dev/null || true
  for attempt in $(seq 1 30); do
    members="$(session_group_live_members)"
    [[ -n "$members" ]] || break
    sleep 0.2
  done
  if [[ -n "$(session_group_live_members)" ]] && session_group_has_identity; then
    members="$(session_group_live_members | tr '\n' ',')"
    log_event desktop-session.cleanup.kill "pgid=$session_group_pid live_pids=${members%,}"
    kill -KILL -- "-$session_group_pid" 2>/dev/null || true
  fi
  if [[ -n "$session_launcher_pid" ]]; then wait "$session_launcher_pid" 2>/dev/null || true; fi
  log_event desktop-session.cleanup.complete "pgid=$session_group_pid remaining=$(ps -eo pid=,pgid=,stat=,comm= | awk -v pgid="$session_group_pid" '$2 == pgid {print $1 ":" $3 ":" $4}' | tr '\n' ',')"
  session_group_pid=
}

on_exit() {
  local status=$?
  if [[ "$keep_session" != 1 ]]; then stop_desktop_session_group; fi
  return "$status"
}

start_desktop_session_group() {
  local pidfile=/run/csa-desktop/bootstrap-session.pgid attempt group_id
  rm -f /run/csa-desktop/session.pid
  printf '\n' >"$pidfile"
  setsid bash -c 'pidfile=$1; log_path=$2; shift 2; printf "%s\n" "$$" >"$pidfile"; exec "$@" </dev/null >"$log_path" 2>&1' \
    csa-desktop-session "$pidfile" /tmp/csa-desktop-session.log \
    runuser -u "$desktop_user" -- env HOME="$desktop_home" DISPLAY=:1 \
      COKE_DESKTOP_RESOLUTION="${COKE_DESKTOP_RESOLUTION:-1280x800}" \
      CSA_TENANT_ID="${CSA_TENANT_ID:-unknown}" CSA_RUN_ID="${CSA_RUN_ID:-none}" \
      CSA_DESKTOP_CHROME_TRACE_STARTUP="${CSA_DESKTOP_CHROME_TRACE_STARTUP:-0}" \
      COKE_DESKTOP_CHROME_BIN="$chrome_bin" COKE_DESKTOP_START_URL=about:blank \
      CSA_DESKTOP_CHROME_CDP_TIMEOUT_SECONDS="${CSA_DESKTOP_CHROME_CDP_TIMEOUT_SECONDS:-360}" \
      CSA_CHROME_CDP_PIPE_BRIDGE_PATH="${CSA_CHROME_CDP_PIPE_BRIDGE_PATH:-}" \
      CSA_DESKTOP_FONT_CACHE_PREWARM="${CSA_DESKTOP_FONT_CACHE_PREWARM:-0}" \
      /usr/local/bin/csa-desktop-session &
  session_launcher_pid=$!
  for attempt in $(seq 1 20); do
    group_id="$(cat "$pidfile" 2>/dev/null || true)"
    if [[ "$group_id" =~ ^[0-9]+$ ]] && [[ "$(ps -o pgid= -p "$group_id" 2>/dev/null | tr -d ' ')" == "$group_id" ]]; then
      session_group_pid="$group_id"
      break
    fi
    sleep 0.1
  done
  if [[ -z "$session_group_pid" ]]; then
    log_event desktop-session.launch.failed "reason=process-group-not-confirmed launcher_pid=$session_launcher_pid pidfile=$pidfile"
    return 1
  fi
  log_event desktop-session.launch.started "pid=$session_group_pid pgid=$session_group_pid launcher_pid=$session_launcher_pid log=/tmp/csa-desktop-session.log"
}

trap on_error ERR
trap on_exit EXIT

desktop_packages_available() {
  local executable
  for executable in dbus-uuidgen google-chrome-stable curl dbus-run-session flock node npm pip3 python3 runuser scrot sudo timeout visudo websockify Xvfb xdpyinfo x11vnc xdotool xfce4-session; do
    command -v "$executable" >/dev/null 2>&1 || return 1
  done
  return 0
}

websockify_listener_ready() {
  awk '$4 == "0A" { split($2, endpoint, ":"); if (toupper(endpoint[2]) == "17C0") found = 1 } END { exit !found }' /proc/net/tcp /proc/net/tcp6 2>/dev/null
}

ensure_system_bus() {
  local output attempt status socket_path=/run/dbus/system_bus_socket
  if ! command -v dbus-send >/dev/null 2>&1; then
    log_event desktop.system-dbus.probe-binary.missing
    return 127
  fi
  if timeout --kill-after=1s 5s dbus-send --system \
    --dest=org.freedesktop.DBus \
    --type=method_call \
    --print-reply \
    /org/freedesktop/DBus \
    org.freedesktop.DBus.ListNames >/dev/null 2>&1; then
    log_event desktop.system-dbus.ready "socket=$socket_path probe=dbus-list-names source=responsive"
    return 0
  fi

  if [[ -S "$socket_path" ]]; then
    if command -v ss >/dev/null 2>&1 && ss -xlpn 2>/dev/null | grep -Fq "$socket_path"; then
      log_event desktop.system-dbus.unresponsive "socket=$socket_path listener=present probe=dbus-list-names"
      return 1
    fi
    log_event warning desktop.system-dbus.socket.stale "socket=$socket_path listener=absent action=remove"
    if output="$(rm -f -- "$socket_path" 2>&1)"; then
      log_event desktop.system-dbus.socket.removed "path=$socket_path"
    else
      status=$?
      log_event desktop.system-dbus.socket.remove.failed "exit_code=$status output=$(printf '%q' "$output")"
      return "$status"
    fi
  else
    log_event warning desktop.system-dbus.socket.missing "path=$socket_path action=start"
  fi

  install -d -m 0755 /run/dbus
  if output="$(timeout --kill-after=1s 10s dbus-daemon --system --fork --nopidfile --print-address=1 2>&1)"; then
    log_event desktop.system-dbus.launch "address=$(printf '%q' "$output")"
  else
    local status=$?
    log_event desktop.system-dbus.launch.failed "exit_code=$status output=$(printf '%q' "$output")"
    return "$status"
  fi
  for attempt in $(seq 1 25); do
    if timeout --kill-after=1s 5s dbus-send --system \
      --dest=org.freedesktop.DBus \
      --type=method_call \
      --print-reply \
      /org/freedesktop/DBus \
      org.freedesktop.DBus.ListNames >/dev/null 2>&1; then
      log_event desktop.system-dbus.ready "socket=$socket_path probe=dbus-list-names attempt=$attempt"
      return 0
    fi
    sleep 0.2
  done
  log_event desktop.system-dbus.failed "reason=system-bus-method-call-unresponsive socket_exists=$([[ -S "$socket_path" ]] && printf 1 || printf 0)"
  return 1
}

run_apt_stage() {
  local stage="$1"
  shift
  local started_at=$SECONDS pid status apt_bytes apt_tail process_sample
  mark_phase "$stage"
  log_capacity "$stage.capacity.before"
  "$@" >>"$apt_log" 2>&1 &
  pid=$!
  log_event "$stage.process.start" "pid=$pid apt_log=$apt_log"
  while kill -0 "$pid" 2>/dev/null; do
    sleep 15
    if kill -0 "$pid" 2>/dev/null; then
      apt_bytes="$(wc -c <"$apt_log" | tr -d ' ')"
      apt_tail="$(tail -c 8192 "$apt_log" 2>/dev/null | tr '\r' '\n' | tail -n 5 | tr '\n' ' ' | cut -c1-800)"
      process_sample="$(ps -eo pid=,ppid=,stat=,wchan:20,pcpu=,pmem=,etime=,time=,comm= 2>/dev/null | awk -v root="$pid" '
        BEGIN { descendant[root] = 1 }
        { rows[NR] = $0; process_id[NR] = $1; parent_id[NR] = $2 }
        END {
          for (pass = 0; pass < 32; pass++) {
            changed = 0
            for (i = 1; i <= NR; i++) {
              if (descendant[parent_id[i]] && !descendant[process_id[i]]) {
                descendant[process_id[i]] = 1
                changed = 1
              }
            }
            if (!changed) break
          }
          for (i = 1; i <= NR; i++) if (descendant[process_id[i]]) printf "%s;", rows[i]
        }
      ' | cut -c1-1600)"
      log_event "$stage.heartbeat" "pid=$pid elapsed_seconds=$((SECONDS - started_at)) apt_log_bytes=$apt_bytes process_sample=$(printf '%q' "$process_sample") apt_log_tail=$(printf '%q' "$apt_tail")"
    fi
  done
  if wait "$pid"; then
    log_event "$stage.process.complete" "pid=$pid exit_code=0 duration_seconds=$((SECONDS - started_at)) apt_log_bytes=$(wc -c <"$apt_log" | tr -d ' ')"
    log_capacity "$stage.capacity.after"
  else
    status=$?
    apt_tail="$(tail -n 30 "$apt_log" 2>/dev/null | tr '\n' ' ' | cut -c1-1600)"
    log_event "$stage.process.failed" "pid=$pid exit_code=$status duration_seconds=$((SECONDS - started_at)) apt_log_tail=$(printf '%q' "$apt_tail")"
    return "$status"
  fi
}

install_chrome_browser() {
  local architecture chrome_url package=/tmp/google-chrome-stable.deb package_arch package_version package_bytes package_sha256
  if command -v google-chrome-stable >/dev/null 2>&1; then
    log_event browser.chrome.reuse "path=$(command -v google-chrome-stable) version=$(google-chrome-stable --version 2>/dev/null | head -n 1 || true)"
    return 0
  fi

  architecture="$(dpkg --print-architecture 2>/dev/null || uname -m)"
  case "$architecture" in
    arm64) chrome_url=https://dl.google.com/linux/direct/google-chrome-stable_current_arm64.deb ;;
    amd64) chrome_url=https://dl.google.com/linux/direct/google-chrome-stable_current_amd64.deb ;;
    *)
      log_event browser.chrome.unsupported-architecture "architecture=$architecture"
      echo "Google Chrome's official Debian package is not configured for guest architecture $architecture." >&2
      return 1
      ;;
  esac

  log_event browser.chrome.download.start "architecture=$architecture host=dl.google.com package=google-chrome-stable_current_${architecture}.deb"
  run_apt_stage browser-chrome-download curl --proto '=https' --proto-redir '=https' --fail --silent --show-error --location \
    --retry 5 --connect-timeout 20 --max-time 600 --output "$package" \
    --write-out 'http_status=%{http_code} downloaded_bytes=%{size_download} total_seconds=%{time_total}\n' "$chrome_url"
  package_arch="$(dpkg-deb --field "$package" Architecture)"
  package_version="$(dpkg-deb --field "$package" Version)"
  package_bytes="$(stat -c '%s' "$package")"
  package_sha256="$(sha256sum "$package" | awk '{print $1}')"
  if [[ "$package_arch" != "$architecture" ]]; then
    log_event browser.chrome.package.invalid "expected_architecture=$architecture package_architecture=$package_arch version=$package_version bytes=$package_bytes sha256=$package_sha256"
    echo "Downloaded Google Chrome package architecture $package_arch does not match guest architecture $architecture." >&2
    return 1
  fi
  log_event browser.chrome.package.verified "architecture=$package_arch version=$package_version bytes=$package_bytes sha256=$package_sha256"
  run_apt_stage browser-chrome-install apt-get "${apt_options[@]}" --show-progress install -y --no-install-recommends "$package"
  if ! command -v google-chrome-stable >/dev/null 2>&1; then
    log_event browser.chrome.install.failed reason=google-chrome-stable-command-missing
    echo "Google Chrome package installed without the expected google-chrome-stable command." >&2
    return 1
  fi
  rm -f -- "$package"
  log_event browser.chrome.install.complete "path=$(command -v google-chrome-stable) version=$(google-chrome-stable --version 2>/dev/null | head -n 1 || true)"
}

repair_guest_system_packages() {
  local -a packages=()
  local package_summary
  if [[ ! -f /usr/share/dbus-1/system.conf ]] || ! command -v dbus-daemon >/dev/null 2>&1; then
    packages+=(dbus dbus-daemon)
  fi
  if ! command -v dbus-launch >/dev/null 2>&1; then
    packages+=(dbus-x11)
  fi
  if ! command -v dbus-send >/dev/null 2>&1; then
    packages+=(dbus-bin)
  fi
  if ! command -v ip >/dev/null 2>&1 || ! command -v ss >/dev/null 2>&1; then
    packages+=(iproute2)
  fi
  if ((${#packages[@]} == 0)); then
    log_event guest-system-packages.reuse reason=required-system-files-and-network-tools-present
    return 0
  fi

  package_summary="$(printf '%s,' "${packages[@]}")"
  package_summary="${package_summary%,}"
  log_event guest-system-packages.repair.start "packages=$package_summary reason=system-config-or-network-tools-missing"
  run_apt_stage apt-update-for-guest-system-packages apt-get "${apt_options[@]}" update
  run_apt_stage apt-install-guest-system-packages apt-get "${apt_options[@]}" --show-progress install -y --reinstall --no-install-recommends "${packages[@]}"
  if [[ ! -f /usr/share/dbus-1/system.conf ]] || ! command -v dbus-daemon >/dev/null 2>&1; then
    log_event guest-system-packages.repair.failed reason=dbus-system-files-still-missing
    echo "The D-Bus system packages are still incomplete after targeted repair." >&2
    return 1
  fi
  if ! command -v dbus-launch >/dev/null 2>&1 || ! command -v ip >/dev/null 2>&1 || ! command -v ss >/dev/null 2>&1; then
    log_event guest-system-packages.repair.failed reason=network-or-session-tool-still-missing
    echo "The targeted guest system packages are still incomplete after repair." >&2
    return 1
  fi
  if ! command -v dbus-send >/dev/null 2>&1; then
    log_event guest-system-packages.repair.failed reason=dbus-send-still-missing
    echo "The D-Bus client probe is still missing after repair." >&2
    return 1
  fi
  log_event guest-system-packages.repair.complete "packages=$package_summary"
}

ensure_sandbox_machine_id() {
  local sandbox_id="${CSA_CUBE_SANDBOX_ID:-}" marker_path="$state_dir/machine-id-sandbox" marker_value machine_id temp_file
  if [[ "$sandbox_id" =~ ^[a-zA-Z0-9_-]{1,80}$ ]]; then
    marker_value="$(cat "$marker_path" 2>/dev/null || true)"
    if [[ "$marker_value" == "$sandbox_id" && -s /etc/machine-id ]]; then
      log_event machine-id.reuse "source=sandbox-marker marker=$marker_path"
      return 0
    fi
    machine_id="$(dbus-uuidgen --get)"
    if [[ ! "$machine_id" =~ ^[[:xdigit:]]{32}$ ]]; then
      log_event machine-id.failed "reason=dbus-uuidgen-invalid-output output_length=${#machine_id}"
      echo "dbus-uuidgen did not produce a 32-digit machine ID." >&2
      return 1
    fi
    temp_file="/etc/machine-id.csa.$$"
    printf '%s\n' "$machine_id" >"$temp_file"
    chmod 0444 "$temp_file"
    mv -f -- "$temp_file" /etc/machine-id
    install -d -m 0755 /var/lib/dbus
    ln -sfn /etc/machine-id /var/lib/dbus/machine-id
    temp_file="$marker_path.$$"
    printf '%s\n' "$sandbox_id" >"$temp_file"
    chmod 0600 "$temp_file"
    mv -f -- "$temp_file" "$marker_path"
    log_event machine-id.created "source=sandbox-id marker=$marker_path machine_id_bytes=$(wc -c </etc/machine-id | tr -d ' ')"
    return 0
  fi

  if [[ ! -s /etc/machine-id ]]; then
    dbus-uuidgen --ensure=/etc/machine-id
    chmod 0444 /etc/machine-id
    log_event machine-id.created "source=dbus-uuidgen-ensure machine_id_bytes=$(wc -c </etc/machine-id | tr -d ' ')"
  else
    log_event machine-id.reuse reason=sandbox-id-unavailable
  fi
}

mark_phase preflight
log_event preflight.start "os_release=$(sed -n 's/^PRETTY_NAME=//p' /etc/os-release | tr -d '\"')" "architecture=$(uname -m)" "uid=$(id -u)"
log_capacity preflight.capacity
desktop_image_manifest=/etc/csa-super-agent/desktop-image.json
image_preinstalled=0
if [[ -s "$desktop_image_manifest" ]]; then
  image_preinstalled=1
  log_event desktop-image.detected "manifest=$desktop_image_manifest sha256=$(sha256sum "$desktop_image_manifest" | cut -d' ' -f1)"
fi

apt_sources_file=
if [[ "$image_preinstalled" != 1 ]]; then
  if ! command -v apt-get >/dev/null 2>&1; then
    log_event preflight.failed reason=apt-get-missing
    echo "The CubeSandbox base image does not provide apt-get." >&2
    exit 1
  fi

  apt_options=(-o Acquire::ForceIPv4=true -o Acquire::http::Proxy=DIRECT -o Acquire::https::Proxy=DIRECT -o Acquire::Retries=5 -o Acquire::http::Timeout=30 -o Acquire::https::Timeout=30 -o Dpkg::Use-Pty=0 -o Dpkg::Progress-Fancy=0)
fi
if [[ "$image_preinstalled" != 1 && -n "${CSA_APT_MIRROR:-}" ]]; then
  if [[ ! "$CSA_APT_MIRROR" =~ ^https?://([[:alnum:].-]+)(:[0-9]+)?/(debian|ubuntu|ubuntu-ports)/?$ ]]; then
    log_event preflight.failed reason=invalid-CSA_APT_MIRROR
    echo "CSA_APT_MIRROR must be a public mirror URL ending in /debian, /ubuntu, or /ubuntu-ports." >&2
    exit 1
  fi
  mirror_scheme="${CSA_APT_MIRROR%%://*}"
  mirror_host="${BASH_REMATCH[1]}"
  mirror_port="${BASH_REMATCH[2]:-}"
  mirror_path="${BASH_REMATCH[3]}"
  mirror_origin="${mirror_scheme}://${mirror_host}${mirror_port}"
  . /etc/os-release
  suite="${VERSION_CODENAME:-bookworm}"
  os_id="${ID:-unknown}"
  architecture="$(dpkg --print-architecture 2>/dev/null || uname -m)"
  if [[ "$os_id" == ubuntu ]]; then
    case "$architecture" in
      amd64) expected_ubuntu_path=ubuntu ;;
      arm64|armhf|ppc64el|riscv64|s390x) expected_ubuntu_path=ubuntu-ports ;;
      *)
        log_event preflight.failed reason=unsupported-ubuntu-mirror-architecture "architecture=$architecture"
        echo "No Ubuntu mirror path is configured for guest architecture $architecture." >&2
        exit 1
        ;;
    esac
    if [[ "$mirror_path" == debian && "$mirror_host" == mirrors.tuna.tsinghua.edu.cn ]]; then
      mirror_path="$expected_ubuntu_path"
      log_event apt.mirror.remap "os=$os_id" "suite=$suite" "architecture=$architecture" "host=$mirror_host" "from=debian" "to=$mirror_path"
    elif [[ "$mirror_path" != "$expected_ubuntu_path" ]]; then
      log_event preflight.failed reason=ubuntu-mirror-required "architecture=$architecture" "expected_path=$expected_ubuntu_path" "mirror_path=$mirror_path"
      echo "Ubuntu $architecture requires CSA_APT_MIRROR to end in /$expected_ubuntu_path (the configured Tsinghua /debian path is mapped automatically)." >&2
      exit 1
    fi
    apt_mirror="${mirror_origin}/${mirror_path}"
    security_mirror="$apt_mirror"
    archive_keyring=/usr/share/keyrings/ubuntu-archive-keyring.gpg
    apt_components='main restricted universe multiverse'
  elif [[ "$os_id" == debian ]]; then
    if [[ "$mirror_path" != debian ]]; then
      log_event preflight.failed reason=debian-mirror-required "mirror_path=$mirror_path"
      echo "Debian requires CSA_APT_MIRROR to end in /debian." >&2
      exit 1
    fi
    apt_mirror="${mirror_origin}/debian"
    security_mirror="${mirror_origin}/debian-security"
    archive_keyring=/usr/share/keyrings/debian-archive-keyring.gpg
    apt_components=main
  else
    log_event preflight.failed reason=unsupported-apt-mirror-os "os=$os_id"
    echo "CSA_APT_MIRROR configuration is supported only for Debian and Ubuntu guests." >&2
    exit 1
  fi
  if [[ ! -r "$archive_keyring" ]]; then
    log_event preflight.failed reason=archive-keyring-missing "os=$os_id" "keyring=$archive_keyring"
    echo "The $os_id archive keyring is missing: $archive_keyring" >&2
    exit 1
  fi
  apt_sources_file=/tmp/csa-desktop-sources.list
  log_event apt.mirror.selected "os=$os_id" "suite=$suite" "architecture=$architecture" "host=$mirror_host" "path=$mirror_path" "security_host=$mirror_host"
  cat >"$apt_sources_file" <<EOF
deb [signed-by=$archive_keyring] $apt_mirror $suite $apt_components
deb [signed-by=$archive_keyring] $apt_mirror $suite-updates $apt_components
deb [signed-by=$archive_keyring] $security_mirror $suite-security $apt_components
EOF
  apt_options+=(-o "Dir::Etc::sourcelist=$apt_sources_file" -o Dir::Etc::sourceparts=- -o APT::Get::List-Cleanup=0)
fi

if [[ "$image_preinstalled" == 1 ]]; then
  if ! desktop_packages_available; then
    log_event desktop-image.verify.failed reason=required-desktop-command-missing
    echo "The prebuilt desktop image is missing one or more expected desktop commands; guest apt is disabled." >&2
    exit 1
  fi
  for required_path in \
    /usr/share/dbus-1/system.conf \
    /var/lib/csa-agent-runtime/ready \
    /var/lib/csa-agent-runtime/package-lock.sha256 \
    /var/lib/csa-agent-runtime/runtime-wheel.sha256 \
    /var/lib/csa-agent-runtime/runtime-key.sha256 \
    /var/lib/csa-agent-runtime/pi-runtime-key.sha256 \
    /opt/csa-agent-runtime/bin/node \
    /opt/csa-agent-runtime/dsh-sdk-client/dist/run-task.bundle.mjs \
    /opt/csa-agent-runtime/dsh-runtime-bin/runtime/deepseek-harness-sdk-runtime-linux-arm64; do
    if [[ ! -s "$required_path" ]]; then
      log_event desktop-image.verify.failed "reason=preinstalled-file-missing path=$required_path"
      echo "The prebuilt desktop image is missing $required_path; guest apt/runtime installation is disabled." >&2
      exit 1
    fi
  done
  if ! command -v dbus-daemon >/dev/null 2>&1 \
    || ! command -v dbus-send >/dev/null 2>&1 \
    || ! command -v ss >/dev/null 2>&1 \
    || ! command -v ip >/dev/null 2>&1; then
    log_event desktop-image.verify.failed reason=required-system-utility-missing
    echo "The prebuilt desktop image is missing required D-Bus or network tools; guest apt is disabled." >&2
    exit 1
  fi
  log_event desktop-image.verify.complete "chrome=$(google-chrome-stable --version | head -n 1) node=$(node --version) python=$(python3 --version 2>&1) dsh_runtime=preinstalled pi_runtime=preinstalled apt_at_tenant_boot=disabled"
else
  if desktop_packages_available; then
    log_event desktop-packages.reuse "reason=required-commands-present novnc_assets=app-hosted"
  else
    log_event desktop-packages.install "reason=required-command-missing"
    run_apt_stage apt-update apt-get "${apt_options[@]}" update
    run_apt_stage apt-install apt-get "${apt_options[@]}" --show-progress install -y --no-install-recommends \
      ca-certificates curl dbus dbus-x11 fonts-dejavu-core fonts-noto-cjk locales \
      iproute2 nodejs npm procps python3 python3-pip python3-venv scrot sudo util-linux websockify \
      x11-utils x11vnc xdotool xfce4 xfce4-terminal xvfb
  fi
  install_chrome_browser
  if ! desktop_packages_available; then
    log_event desktop-packages.verify.failed reason=required-command-still-missing
    echo "The Linux desktop packages are incomplete after installation." >&2
    exit 1
  fi
  repair_guest_system_packages
  mark_phase apt-clean
  log_event apt-clean.start
  apt-get clean
  rm -rf /var/lib/apt/lists/*
  if [[ -n "$apt_sources_file" ]]; then rm -f "$apt_sources_file"; fi
  unset CSA_APT_MIRROR
  log_capacity apt-clean.complete
fi
mark_phase machine-id
ensure_sandbox_machine_id
ensure_system_bus

mark_phase desktop-user
desktop_user="$(getent passwd 1000 | cut -d: -f1 || true)"
if [[ -z "$desktop_user" ]]; then
  desktop_user=csa
  if ! id "$desktop_user" >/dev/null 2>&1; then
    useradd --uid 1000 --create-home --shell /bin/bash "$desktop_user"
  fi
fi

desktop_uid="$(id -u "$desktop_user")"
desktop_gid="$(id -g "$desktop_user")"
desktop_home=/workspace/.desktop-home
mark_phase desktop-files
install -d -m 0755 /usr/local/bin /var/lib/csa-desktop /workspace "$desktop_home/.config/chromium" "$desktop_home/.vnc"
install -d -o "$desktop_uid" -g "$desktop_gid" -m 0755 /run/csa-desktop
touch /tmp/csa-desktop-session.log
chown "$desktop_uid:$desktop_gid" /tmp/csa-desktop-session.log
chmod 0600 /tmp/csa-desktop-session.log
mkdir -p /tmp/.X11-unix
chmod 1777 /tmp/.X11-unix
chown -R "$desktop_uid:$desktop_gid" /workspace
printf '%s ALL=(ALL) NOPASSWD: ALL\n' "$desktop_user" > /etc/sudoers.d/csa-desktop
chmod 0440 /etc/sudoers.d/csa-desktop
visudo -cf /etc/sudoers.d/csa-desktop >/dev/null

install -m 0755 /tmp/csa-desktop-session.sh /usr/local/bin/csa-desktop-session
mark_phase desktop-package-verification
chrome_bin="$(command -v google-chrome-stable || true)"
log_event desktop.chrome.binary "selected=${chrome_bin:-missing} reason=official-google-chrome-package"
if [[ -z "$chrome_bin" ]]; then
  log_event desktop-package-verification.failed reason=google-chrome-missing
  echo "Google Chrome was not installed in the CubeSandbox guest." >&2
  exit 1
fi
websockify_ready=0
session_ready_file=/run/csa-desktop/session.ready
mark_phase desktop-session-start
websockify_listener_ready && websockify_ready=1
if [[ "$websockify_ready" != 1 || ! -s "$session_ready_file" ]]; then
  start_desktop_session_group
fi

ready=0
desktop_readiness_timeout_seconds=720
desktop_readiness_started_seconds=$SECONDS
desktop_readiness_started_uptime_cs=0
desktop_readiness_now_uptime_cs=0
desktop_readiness_deadline_uptime_cs=0
if ! read_monotonic_centiseconds desktop_readiness_started_uptime_cs; then
  log_event desktop-readiness.clock.failed "source=/proc/uptime point=start"
  exit 1
fi
desktop_readiness_deadline_uptime_cs=$((desktop_readiness_started_uptime_cs + desktop_readiness_timeout_seconds * 100))
last_heartbeat_uptime_cs=$desktop_readiness_started_uptime_cs
session_process_pid_file=/run/csa-desktop/session.pid
mark_phase desktop-readiness
log_event desktop-readiness.start "timeout_seconds=$desktop_readiness_timeout_seconds bash_started_seconds=$desktop_readiness_started_seconds guest_uptime_centiseconds=$desktop_readiness_started_uptime_cs websockify_ready=$websockify_ready"
while :; do
  if ! read_monotonic_centiseconds desktop_readiness_now_uptime_cs; then
    log_event desktop-readiness.clock.failed "source=/proc/uptime point=loop"
    exit 1
  fi
  ((desktop_readiness_now_uptime_cs < desktop_readiness_deadline_uptime_cs)) || break
  desktop_session_pid=
  if [[ -s "$session_process_pid_file" ]]; then
    desktop_session_pid="$(cat "$session_process_pid_file" 2>/dev/null || true)"
    if [[ "$desktop_session_pid" =~ ^[0-9]+$ ]] && ((desktop_session_pid > 1)); then
      desktop_session_status="/proc/$desktop_session_pid/status"
      if [[ ! -r "$desktop_session_status" ]]; then
        log_event error "desktop-readiness.session.exited pid=$desktop_session_pid state=missing reason=pid-file-process-not-found websockify_ready=$websockify_ready"
        tail -c 12000 /tmp/csa-desktop-session.log >&2 || true
        exit 1
      fi
      desktop_session_state="$(awk '/^State:/ {print $2; exit}' "$desktop_session_status" 2>/dev/null || true)"
      desktop_session_uid="$(awk '/^Uid:/ {print $2; exit}' "$desktop_session_status" 2>/dev/null || true)"
      desktop_session_command="$(tr '\0' ' ' <"/proc/$desktop_session_pid/cmdline" 2>/dev/null || true)"
      if [[ "$desktop_session_uid" != "$desktop_uid" || "$desktop_session_command" != *csa-desktop-session* || "$desktop_session_state" == Z || "$desktop_session_state" == X ]]; then
        log_event error "desktop-readiness.session.exited pid=$desktop_session_pid state=${desktop_session_state:-unknown} uid=${desktop_session_uid:-unknown} command=$(printf '%q' "${desktop_session_command:-missing}") reason=session-pid-identity-lost websockify_ready=$websockify_ready"
        tail -c 12000 /tmp/csa-desktop-session.log >&2 || true
        exit 1
      fi
    else
      log_event error "desktop-readiness.session.pid.invalid value=${desktop_session_pid:-empty}"
      tail -c 12000 /tmp/csa-desktop-session.log >&2 || true
      exit 1
    fi
  fi
  if [[ -n "$session_group_pid" ]]; then
    session_group_state="$(ps -o stat= -p "$session_group_pid" 2>/dev/null | tr -d '[:space:]' || true)"
    if [[ -z "$session_group_state" || "$session_group_state" == *Z* || "$session_group_state" == *X* ]]; then
      session_exit_status=unknown
      if wait "$session_group_pid" 2>/dev/null; then
        session_exit_status=0
      else
        session_exit_status=$?
      fi
      log_event error "desktop-readiness.session.exited pgid=$session_group_pid state=$session_group_state exit_status=$session_exit_status websockify_ready=$websockify_ready"
      tail -c 12000 /tmp/csa-desktop-session.log >&2 || true
      exit 1
    fi
  fi
  websockify_listener_ready && websockify_ready=1 || websockify_ready=0
  if [[ "$websockify_ready" == 1 && -s "$session_ready_file" && -n "${desktop_session_pid:-}" ]] \
    && grep -Fxq "pid=$desktop_session_pid" "$session_ready_file"; then
    ready=1
    break
  fi
  if ((desktop_readiness_now_uptime_cs - last_heartbeat_uptime_cs >= 1500)); then
    session_tail="$(tail -n 8 /tmp/csa-desktop-session.log 2>/dev/null | tr '\n' ' ' | tail -c 1200)"
    log_event desktop-readiness.heartbeat "websockify_ready=$websockify_ready session_ready_file_present=$([[ -s "$session_ready_file" ]] && printf 1 || printf 0) guest_elapsed_seconds=$(((desktop_readiness_now_uptime_cs - desktop_readiness_started_uptime_cs) / 100)) bash_elapsed_seconds=$((SECONDS - desktop_readiness_started_seconds)) guest_uptime_centiseconds=$desktop_readiness_now_uptime_cs session_log_tail=$(printf '%q' "$session_tail")"
    last_heartbeat_uptime_cs=$desktop_readiness_now_uptime_cs
  fi
  sleep 2
done
if [[ "$ready" != 1 ]]; then
  read_monotonic_centiseconds desktop_readiness_now_uptime_cs || desktop_readiness_now_uptime_cs=$desktop_readiness_deadline_uptime_cs
  log_event desktop-readiness.failed "timeout_seconds=$desktop_readiness_timeout_seconds guest_elapsed_seconds=$(((desktop_readiness_now_uptime_cs - desktop_readiness_started_uptime_cs) / 100)) bash_elapsed_seconds=$((SECONDS - desktop_readiness_started_seconds)) guest_uptime_centiseconds=$desktop_readiness_now_uptime_cs websockify_ready=$websockify_ready session_ready_file_present=$([[ -s "$session_ready_file" ]] && printf 1 || printf 0)"
  tail -c 12000 /tmp/csa-desktop-session.log >&2 || true
  echo "The Linux desktop did not become ready within ${desktop_readiness_timeout_seconds} seconds." >&2
  exit 1
fi

keep_session=1
printf '%s\n' "$(date -u +%FT%TZ)" > /var/lib/csa-desktop/ready
mark_phase complete
printf 'desktop_ready user=%s node=%s python=%s chromium=%s\n' \
  "$desktop_user" "$(node --version)" "$(python3 --version)" "$chrome_bin"
log_capacity complete.capacity
