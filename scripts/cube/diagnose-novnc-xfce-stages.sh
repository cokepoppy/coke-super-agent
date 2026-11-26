#!/usr/bin/env bash
set -uo pipefail

started_seconds=$SECONDS
tag="$(date -u +%Y%m%dT%H%M%SZ)-$$"
diag_dir="/tmp/csa-novnc-xfce-$tag"
display="${CSA_NOVNC_XFCE_DISPLAY:-:8}"
vnc_port="${CSA_NOVNC_XFCE_VNC_PORT:-16090}"
web_port="${CSA_NOVNC_XFCE_WEB_PORT:-16091}"
static_port="${CSA_NOVNC_XFCE_STATIC_PORT:-16092}"
web_listen_host="${CSA_NOVNC_XFCE_LISTEN_HOST:-}"
http_timeout="${CSA_NOVNC_XFCE_HTTP_TIMEOUT:-15}"
desktop_user="$(getent passwd 1000 | cut -d: -f1)"
desktop_uid="$(id -u "$desktop_user" 2>/dev/null)"
desktop_gid="$(id -g "$desktop_user" 2>/dev/null)"
desktop_home=/workspace/.desktop-home
xvfb_pid=
vnc_pid=
websockify_pid=
static_http_pid=
xfce_pid=
dbus_pid=
dbus_address=

mkdir -p "$diag_dir"

log() {
  local line
  line="novnc.xfce timestamp=$(date -u +%FT%TZ) elapsed_seconds=$((SECONDS - started_seconds)) stage=$1 ${*:2}"
  printf '%s\n' "$line" | tee -a "$diag_dir/run.log"
}

tcp_listener() {
  local port_hex
  port_hex="$(printf '%04X' "$1")"
  awk -v port="$port_hex" '$4 == "0A" { split($2, endpoint, ":"); if (toupper(endpoint[2]) == port) found=1 } END { exit !found }' \
    /proc/net/tcp /proc/net/tcp6 2>/dev/null
}

start_group() {
  local name="$1" pidfile="$2" log_path="$3" attempt group_id
  shift 3
  setsid bash -c 'pidfile=$1; log_path=$2; shift 2; printf "%s\n" "$$" >"$pidfile"; exec "$@" >"$log_path" 2>&1' \
    "$name" "$pidfile" "$log_path" "$@" &
  local launcher_pid=$!
  for attempt in $(seq 1 50); do
    group_id="$(cat "$pidfile" 2>/dev/null || true)"
    if [[ "$group_id" =~ ^[0-9]+$ ]] && [[ "$(ps -o pgid= -p "$group_id" 2>/dev/null | tr -d ' ')" == "$group_id" ]]; then
      log "$name.started" "pid=$group_id pgid=$group_id launcher_pid=$launcher_pid log=$log_path"
      printf '%s\n' "$group_id" >"$diag_dir/$name.pgid"
      printf '%s\n' "$launcher_pid" >"$diag_dir/$name.launcher"
      return 0
    fi
    sleep 0.1
  done
  log "$name.start.failed" "launcher_pid=$launcher_pid pidfile=$pidfile"
  return 1
}

group_has_identity() {
  local pgid="$1" identity="$2" pid command uid
  [[ "$pgid" =~ ^[0-9]+$ ]] || return 1
  while read -r pid; do
    [[ "$pid" =~ ^[0-9]+$ && -r "/proc/$pid/cmdline" ]] || continue
    command="$(tr '\0' ' ' <"/proc/$pid/cmdline" 2>/dev/null || true)"
    uid="$(awk '/^Uid:/ {print $2; exit}' "/proc/$pid/status" 2>/dev/null || true)"
    [[ "$uid" == "$desktop_uid" && "$command" == *"$identity"* ]] && return 0
  done < <(ps -eo pid=,pgid= | awk -v pgid="$pgid" '$2 == pgid {print $1}')
  return 1
}

stop_group() {
  local name="$1" pid="$2" launcher="$3" identity="$4" attempt members
  [[ "$pid" =~ ^[0-9]+$ ]] || return 0
  if ! group_has_identity "$pid" "$identity"; then
    log "$name.cleanup.skipped" "pgid=$pid reason=process-group-identity-mismatch"
    return 0
  fi
  members="$(ps -eo pid=,pgid=,stat=,comm= | awk -v pgid="$pid" '$2 == pgid && $3 !~ /Z|X/ {print $1 ":" $3 ":" $4}' | tr '\n' ',')"
  log "$name.cleanup.term" "pgid=$pid members=${members%,}"
  kill -TERM -- "-$pid" 2>/dev/null || true
  for attempt in $(seq 1 24); do
    members="$(ps -eo pid=,pgid=,stat= | awk -v pgid="$pid" '$2 == pgid && $3 !~ /Z|X/ {print $1}')"
    [[ -n "$members" ]] || break
    sleep 0.25
  done
  if [[ -n "$members" ]] && group_has_identity "$pid" "$identity"; then
    log "$name.cleanup.kill" "pgid=$pid live_pids=${members//$'\n'/,}"
    kill -KILL -- "-$pid" 2>/dev/null || true
  fi
  [[ "$launcher" =~ ^[0-9]+$ ]] && wait "$launcher" 2>/dev/null || true
  members="$(ps -eo pid=,pgid=,stat=,comm= | awk -v pgid="$pid" '$2 == pgid {print $1 ":" $3 ":" $4}' | tr '\n' ',')"
  members="${members%,}"
  [[ -n "$members" ]] || members=none
  log "$name.cleanup.complete" "pgid=$pid remaining=$members"
}

cleanup() {
  local status=$?
  trap - EXIT
  [[ -z "$xfce_pid" ]] || stop_group xfce "$xfce_pid" "$(cat "$diag_dir/xfce.launcher" 2>/dev/null)" xfce4-session
  [[ -z "$static_http_pid" ]] || stop_group static_http "$static_http_pid" "$(cat "$diag_dir/static_http.launcher" 2>/dev/null)" "http.server $static_port"
  [[ -z "$websockify_pid" ]] || stop_group websockify "$websockify_pid" "$(cat "$diag_dir/websockify.launcher" 2>/dev/null)" websockify
  [[ -z "$vnc_pid" ]] || stop_group vnc "$vnc_pid" "$(cat "$diag_dir/vnc.launcher" 2>/dev/null)" x11vnc
  [[ -z "$xvfb_pid" ]] || stop_group xvfb "$xvfb_pid" "$(cat "$diag_dir/xvfb.launcher" 2>/dev/null)" Xvfb
  if [[ "$dbus_pid" =~ ^[0-9]+$ && -r "/proc/$dbus_pid/cmdline" ]]; then
    local command uid
    command="$(tr '\0' ' ' <"/proc/$dbus_pid/cmdline" 2>/dev/null || true)"
    uid="$(awk '/^Uid:/ {print $2; exit}' "/proc/$dbus_pid/status" 2>/dev/null || true)"
    if [[ "$uid" == "$desktop_uid" && "$command" == *dbus-daemon* ]]; then
      log cleanup.dbus.term "pid=$dbus_pid uid=$uid"
      kill -TERM "$dbus_pid" 2>/dev/null || true
      for _ in $(seq 1 20); do kill -0 "$dbus_pid" 2>/dev/null || break; sleep 0.1; done
      kill -KILL "$dbus_pid" 2>/dev/null || true
    fi
  fi
  for port in "$vnc_port" "$web_port" "$static_port"; do
    if tcp_listener "$port"; then log cleanup.port.remaining "port=$port"; else log cleanup.port.closed "port=$port"; fi
  done
  log cleanup.complete "exit_code=$status diag_dir=$diag_dir"
}
trap cleanup EXIT

log preflight.start "diag_dir=$diag_dir user=${desktop_user:-missing} uid=${desktop_uid:-missing} display=$display vnc_port=$vnc_port web_port=$web_port static_port=$static_port"
if [[ -z "$desktop_user" || ! "$desktop_uid" =~ ^[0-9]+$ ]]; then log preflight.failed reason=desktop-user-missing; exit 2; fi
if xdpyinfo -display "$display" >/dev/null 2>&1; then log preflight.failed reason=display-active display=$display; exit 3; fi
for port in "$vnc_port" "$web_port" "$static_port"; do
  if tcp_listener "$port"; then log preflight.failed "reason=port-in-use port=$port"; exit 3; fi
done
if ps -u "$desktop_uid" -o stat=,comm= | awk '$2 == "xfce4-session" && $1 !~ /Z|X/ { found=1 } END { exit !found }'; then
  log preflight.failed reason=desktop-user-already-has-live-xfce
  exit 3
fi
install -d -o "$desktop_user" -g "$desktop_gid" -m 0755 "$desktop_home" "$diag_dir"
chown "$desktop_user:$desktop_gid" "$diag_dir"
diag_cgroup_dir="/sys/fs/cgroup$(awk -F: '$1 == "0" { print $3; exit }' /proc/self/cgroup 2>/dev/null)"
[[ -d "$diag_cgroup_dir" ]] || diag_cgroup_dir=/sys/fs/cgroup
log preflight.capacity "$(df -Pk / | awk 'NR == 2 {print "disk_available_kb=" $4}')" "cpu_max=$(cat "$diag_cgroup_dir/cpu.max" 2>/dev/null)" "cpu_stat=$(tr '\n' ';' <"$diag_cgroup_dir/cpu.stat" 2>/dev/null)" "memory_current_bytes=$(cat "$diag_cgroup_dir/memory.current" 2>/dev/null)" "memory_max_bytes=$(cat "$diag_cgroup_dir/memory.max" 2>/dev/null)"

start_group xvfb "$diag_dir/xvfb.pgid" "$diag_dir/xvfb.log" \
  runuser -u "$desktop_user" -- env HOME="$desktop_home" DISPLAY="$display" \
  Xvfb "$display" -screen 0 1280x800x24 -nolisten tcp -ac +extension GLX +render -noreset || exit 1
xvfb_pid="$(cat "$diag_dir/xvfb.pgid")"
for attempt in $(seq 1 30); do
  if xdpyinfo -display "$display" >/dev/null 2>&1; then log display.ready "attempt=$attempt"; break; fi
  if ((attempt == 30)); then log display.failed reason=xdpyinfo-timeout; exit 1; fi
  sleep 1
done

start_group vnc "$diag_dir/vnc.pgid" "$diag_dir/vnc.log" \
  runuser -u "$desktop_user" -- env HOME="$desktop_home" DISPLAY="$display" \
  x11vnc -display "$display" -nopw -localhost -no6 -rfbport "$vnc_port" -forever -shared || exit 1
vnc_pid="$(cat "$diag_dir/vnc.pgid")"
for attempt in $(seq 1 30); do
  if tcp_listener "$vnc_port"; then log vnc.ready "attempt=$attempt port=$vnc_port"; break; fi
  if ((attempt == 30)); then log vnc.failed reason=listener-timeout; exit 1; fi
  sleep 1
done

start_group websockify "$diag_dir/websockify.pgid" "$diag_dir/websockify.log" \
  runuser -u "$desktop_user" -- env HOME="$desktop_home" PYTHONUNBUFFERED=1 \
  /usr/bin/websockify --verbose --web=/usr/share/novnc "${web_listen_host:+$web_listen_host:}$web_port" "localhost:$vnc_port" || exit 1
websockify_pid="$(cat "$diag_dir/websockify.pgid")"
web_listener=0
for attempt in $(seq 1 90); do
  if tcp_listener "$web_port"; then web_listener=1; log websockify.ready "attempt=$attempt port=$web_port"; break; fi
  if ((attempt % 15 == 0)); then
    process_state="$(awk '/^State:/ {print $2}' "/proc/$websockify_pid/status" 2>/dev/null)"
    process_rss="$(awk '/^VmRSS:/ {print $2}' "/proc/$websockify_pid/status" 2>/dev/null)"
    process_ticks="$(awk '{print $14 + $15}' "/proc/$websockify_pid/stat" 2>/dev/null)"
    log websockify.startup.wait "attempt=$attempt state=${process_state:-absent} rss_kb=${process_rss:-unknown} cpu_ticks=${process_ticks:-unknown}"
  fi
  sleep 1
done
if [[ "$web_listener" != 1 ]]; then log websockify.failed reason=listener-timeout; tail -n 25 "$diag_dir/websockify.log" | sed 's/^/novnc.xfce websockify.log /'; exit 1; fi

probe_http() {
  local stage="$1" close="$2" port="${3:-$web_port}" out status started_at probe_started_seconds ended_at
  local -a headers=()
  if [[ "$close" == yes ]]; then headers=(-H 'Connection: close'); fi
  started_at="$(date -u +%FT%TZ)"
  probe_started_seconds=$SECONDS
  out="$(runuser -u "$desktop_user" -- /usr/bin/curl --noproxy '*' "${headers[@]}" -sS --connect-timeout 1 --max-time "$http_timeout" \
    -D "$diag_dir/$stage.headers" -o "$diag_dir/$stage.body" \
    -w 'http_code=%{http_code} bytes=%{size_download} total_seconds=%{time_total}' \
    "http://127.0.0.1:$port/vnc.html" 2>&1)"
  status=$?
  ended_at="$(date -u +%FT%TZ)"
  printf 'started_at=%s ended_at=%s shell_elapsed_seconds=%s curl_exit=%s result=%q\n' "$started_at" "$ended_at" "$((SECONDS - probe_started_seconds))" "$status" "$out" >"$diag_dir/$stage.result"
  log "$stage" "port=$port started_at=$started_at ended_at=$ended_at shell_elapsed_seconds=$((SECONDS - probe_started_seconds)) curl_exit=$status result=$(printf '%q' "$out")"
  if [[ -r "$diag_dir/$stage.headers" ]]; then
    local response_headers
    response_headers="$(head -n 5 "$diag_dir/$stage.headers" | tr '\n' ';')"
    log "$stage.headers" "$(printf '%q' "$response_headers")"
  fi
  if [[ -r "$diag_dir/$stage.body" ]]; then log "$stage.body" "bytes=$(wc -c <"$diag_dir/$stage.body" | tr -d ' ')"; fi
}

probe_head() {
  local stage="$1" port="${2:-$web_port}" out status started_at probe_started_seconds ended_at
  started_at="$(date -u +%FT%TZ)"
  probe_started_seconds=$SECONDS
  out="$(runuser -u "$desktop_user" -- /usr/bin/curl --noproxy '*' --head -sS --connect-timeout 1 --max-time "$http_timeout" \
    -D "$diag_dir/$stage.headers" -o /dev/null -w 'http_code=%{http_code} total_seconds=%{time_total}' \
    "http://127.0.0.1:$port/vnc.html" 2>&1)"
  status=$?
  ended_at="$(date -u +%FT%TZ)"
  printf 'started_at=%s ended_at=%s shell_elapsed_seconds=%s curl_exit=%s result=%q\n' "$started_at" "$ended_at" "$((SECONDS - probe_started_seconds))" "$status" "$out" >"$diag_dir/$stage.result"
  log "$stage" "port=$port started_at=$started_at ended_at=$ended_at shell_elapsed_seconds=$((SECONDS - probe_started_seconds)) curl_exit=$status result=$(printf '%q' "$out")"
  if [[ -r "$diag_dir/$stage.headers" ]]; then
    local response_headers
    response_headers="$(head -n 5 "$diag_dir/$stage.headers" | tr '\n' ';')"
    log "$stage.headers" "$(printf '%q' "$response_headers")"
  fi
}

start_group static_http "$diag_dir/static_http.pgid" "$diag_dir/static_http.log" \
  runuser -u "$desktop_user" -- env HOME="$desktop_home" \
  /usr/bin/python3 -m http.server "$static_port" --bind 127.0.0.1 --directory /usr/share/novnc || exit 1
static_http_pid="$(cat "$diag_dir/static_http.pgid")"
for attempt in $(seq 1 30); do
  if tcp_listener "$static_port"; then log static_http.ready "attempt=$attempt port=$static_port"; break; fi
  if ((attempt == 30)); then log static_http.failed reason=listener-timeout; exit 1; fi
  sleep 1
done

probe_http pre_xfce_websockify no "$web_port"
probe_http pre_xfce_python no "$static_port"
probe_head pre_xfce_websockify_head "$web_port"
probe_head pre_xfce_python_head "$static_port"
dbus_output="$(runuser -u "$desktop_user" -- env HOME="$desktop_home" DISPLAY="$display" dbus-launch --sh-syntax 2>"$diag_dir/dbus-launch.log")"
if [[ -z "$dbus_output" ]]; then log dbus.failed reason=dbus-launch-empty; tail -n 12 "$diag_dir/dbus-launch.log" | sed 's/^/novnc.xfce dbus.log /'; exit 1; fi
eval "$dbus_output"
dbus_pid="${DBUS_SESSION_BUS_PID:-}"
dbus_address="${DBUS_SESSION_BUS_ADDRESS:-}"
log dbus.ready "pid=${dbus_pid:-unknown} address_configured=$([[ -n "$dbus_address" ]] && printf yes || printf no)"
start_group xfce "$diag_dir/xfce.pgid" "$diag_dir/xfce.log" \
  runuser -u "$desktop_user" -- env HOME="$desktop_home" DISPLAY="$display" \
  DBUS_SESSION_BUS_ADDRESS="$dbus_address" startxfce4 || exit 1
xfce_pid="$(cat "$diag_dir/xfce.pgid")"
xfce_ready=0
for attempt in $(seq 1 90); do
  processes="$(ps -u "$desktop_uid" -o stat=,comm= 2>/dev/null)"
  if awk '$2 == "xfce4-session" && $1 !~ /Z|X/ {session=1} $2 == "xfwm4" && $1 !~ /Z|X/ {wm=1} END {exit !(session && wm)}' <<<"$processes"; then
    xfce_ready=1
    log xfce.ready "attempt=$attempt session_and_window_manager=ready"
    break
  fi
  if ((attempt % 15 == 0)); then log xfce.wait "attempt=$attempt processes=$(printf '%q' "$processes")"; fi
  sleep 1
done
if [[ "$xfce_ready" != 1 ]]; then log xfce.failed reason=readiness-timeout; tail -n 30 "$diag_dir/xfce.log" | sed 's/^/novnc.xfce xfce.log /'; exit 1; fi

cpu_usage_before="$(awk '$1 == "usage_usec" {print $2}' "$diag_cgroup_dir/cpu.stat" 2>/dev/null)"
cpu_throttled_before="$(awk '$1 == "throttled_usec" {print $2}' "$diag_cgroup_dir/cpu.stat" 2>/dev/null)"
log post_xfce.capacity "cpu_max=$(cat "$diag_cgroup_dir/cpu.max" 2>/dev/null)" "cpu_stat=$(tr '\n' ';' <"$diag_cgroup_dir/cpu.stat" 2>/dev/null)" "memory_current_bytes=$(cat "$diag_cgroup_dir/memory.current" 2>/dev/null)" "memory_max_bytes=$(cat "$diag_cgroup_dir/memory.max" 2>/dev/null)" "$(tr '\n' ';' </proc/pressure/cpu 2>/dev/null)" "$(tr '\n' ';' </proc/pressure/memory 2>/dev/null)"
ps -eo pid=,ppid=,stat=,pcpu=,rss=,comm= --sort=-pcpu 2>/dev/null | head -n 8 | tr '\n' ';' | xargs printf 'post_xfce.top_processes=%s\n' | while IFS= read -r line; do log post_xfce.top "$line"; done
probe_http post_xfce_websockify no "$web_port"
probe_http post_xfce_python no "$static_port"
probe_head post_xfce_websockify_head "$web_port"
probe_head post_xfce_python_head "$static_port"
cpu_usage_after="$(awk '$1 == "usage_usec" {print $2}' "$diag_cgroup_dir/cpu.stat" 2>/dev/null)"
cpu_throttled_after="$(awk '$1 == "throttled_usec" {print $2}' "$diag_cgroup_dir/cpu.stat" 2>/dev/null)"
log post_xfce.cpu-delta "usage_usec_before=${cpu_usage_before:-unknown} usage_usec_after=${cpu_usage_after:-unknown} throttled_usec_before=${cpu_throttled_before:-unknown} throttled_usec_after=${cpu_throttled_after:-unknown}"
web_status="$(awk '/^(State|VmRSS|Threads):/ {printf "%s=%s;",$1,$2}' "/proc/$websockify_pid/status" 2>/dev/null)"
web_wchan="$(cat "/proc/$websockify_pid/wchan" 2>/dev/null || true)"
web_stack="$(cat "/proc/$websockify_pid/stack" 2>/dev/null | tr '\n' ';' || true)"
web_socket_fds="$(find "/proc/$websockify_pid/fd" -maxdepth 1 -type l -printf '%f ' 2>/dev/null || true)"
log websockify.post-xfce.sample "pid=$websockify_pid status=$web_status wchan=$web_wchan stack=$(printf '%q' "$web_stack") fd_names=$(printf '%q' "$web_socket_fds")"
tail -n 25 "$diag_dir/websockify.log" | sed 's/^/novnc.xfce websockify.log /'
tail -n 10 "$diag_dir/static_http.log" | sed 's/^/novnc.xfce static-http.log /'
tail -n 20 "$diag_dir/xfce.log" | sed 's/^/novnc.xfce xfce.log /'
log sequence.complete "diag_dir=$diag_dir"
