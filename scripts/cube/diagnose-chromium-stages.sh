#!/usr/bin/env bash
set -uo pipefail

started_at="$(date -u +%FT%TZ)"
tag="$(date +%s)-$$"
diag_dir="/tmp/csa-chromium-stages-$tag"
display=:1
desktop_user="$(getent passwd 1000 | cut -d: -f1)"
desktop_uid="$(id -u "$desktop_user" 2>/dev/null)"
desktop_gid="$(id -g "$desktop_user" 2>/dev/null)"
desktop_home=/workspace/.desktop-home
chrome_bin=/usr/lib/chromium/chromium
xvfb_group_pid=
xvfb_launcher_pid=
xfce_group_pid=
xfce_launcher_pid=
chrome_group_pid=
chrome_launcher_pid=
dbus_pid=
dbus_address=
started_group_pid=
started_launcher_pid=
stage_result=not-run
xvfb_only_result=not-run
session_bus_only_result=not-run
xfce_and_session_bus_result=not-run
attempts="${CSA_CHROMIUM_STAGES_ATTEMPTS:-8}"
probe_pause="${CSA_CHROMIUM_STAGES_PAUSE_SECONDS:-2}"

mkdir -p "$diag_dir"

log() {
  printf 'chromium.stages timestamp=%s elapsed_seconds=%s tenant_id=%s stage=%s %s\n' \
    "$(date -u +%FT%TZ)" "$((SECONDS - script_started_seconds))" \
    "${CSA_TENANT_ID:-diagnostic}" "$1" "${*:2}"
}

script_started_seconds=$SECONDS

start_group() {
  local stage="$1" pidfile="$2" log_path="$3" attempt group_id
  shift 3
  started_group_pid=
  started_launcher_pid=
  rm -f -- "$pidfile"
  setsid bash -c 'pidfile=$1; log_path=$2; shift 2; printf "%s\n" "$$" >"$pidfile"; exec "$@" >"$log_path" 2>&1' \
    "$stage" "$pidfile" "$log_path" "$@" &
  started_launcher_pid=$!
  for attempt in $(seq 1 20); do
    if [[ -s "$pidfile" ]]; then
      group_id="$(cat "$pidfile" 2>/dev/null || true)"
      if [[ "$group_id" =~ ^[0-9]+$ ]] && [[ "$(ps -o pgid= -p "$group_id" 2>/dev/null | tr -d ' ')" == "$group_id" ]]; then
        started_group_pid="$group_id"
        break
      fi
    fi
    sleep 0.1
  done
  if [[ -z "$started_group_pid" ]]; then
    log "$stage.start.failed" "launcher_pid=$started_launcher_pid pidfile=$pidfile reason=process-group-not-confirmed"
    return 1
  fi
  log "$stage.process.started" "pid=$started_group_pid pgid=$started_group_pid launcher_pid=$started_launcher_pid pidfile=$pidfile log=$log_path"
}

stop_group() {
  local stage="$1" pid="$2" launcher_pid="$3" reason="$4" group_pids attempt
  [[ "$pid" =~ ^[0-9]+$ ]] || return 0
  group_pids="$(ps -eo pid=,pgid=,stat=,comm= | awk -v pgid="$pid" '$2 == pgid { print $1 ":" $3 ":" $4 }' | tr '\n' ',')"
  if [[ -z "$group_pids" ]]; then
    log "$stage.cleanup.skip" "pid=$pid reason=no-process-group"
    [[ -z "$launcher_pid" ]] || wait "$launcher_pid" 2>/dev/null || true
    return 0
  fi
  log "$stage.cleanup.term" "pid=$pid reason=$reason members=${group_pids%,}"
  kill -TERM -- "-$pid" 2>/dev/null || true
  for attempt in $(seq 1 20); do
    group_pids="$(ps -eo pid=,pgid= | awk -v pgid="$pid" '$2 == pgid { print $1 }')"
    [[ -n "$group_pids" ]] || break
    sleep 0.25
  done
  if [[ -n "$group_pids" ]]; then
    log "$stage.cleanup.kill" "pid=$pid remaining_pids=${group_pids//$'\n'/,}"
    kill -KILL -- "-$pid" 2>/dev/null || true
  fi
  [[ -z "$launcher_pid" ]] || wait "$launcher_pid" 2>/dev/null || true
  group_pids="$(ps -eo pid=,pgid=,stat=,comm= | awk -v pgid="$pid" '$2 == pgid { print $1 ":" $3 ":" $4 }' | tr '\n' ',')"
  group_pids="${group_pids%,}"
  log "$stage.cleanup.complete" "pid=$pid remaining=${group_pids:-none}"
}

cleanup() {
  local exit_status=$?
  trap - EXIT
  [[ -z "$chrome_group_pid" ]] || stop_group chrome "$chrome_group_pid" "$chrome_launcher_pid" exit
  [[ -z "$xfce_group_pid" ]] || stop_group xfce "$xfce_group_pid" "$xfce_launcher_pid" exit
  [[ -z "$xvfb_group_pid" ]] || stop_group xvfb "$xvfb_group_pid" "$xvfb_launcher_pid" exit
  if [[ "$dbus_pid" =~ ^[0-9]+$ && -r "/proc/$dbus_pid/cmdline" ]]; then
    local command uid
    command="$(tr '\0' ' ' <"/proc/$dbus_pid/cmdline" 2>/dev/null || true)"
    uid="$(awk '/^Uid:/ { print $2; exit }' "/proc/$dbus_pid/status" 2>/dev/null || true)"
    if [[ "$command" == *dbus-daemon* && "$uid" == "$desktop_uid" ]]; then
      log cleanup.dbus.term "pid=$dbus_pid uid=$uid"
      kill -TERM "$dbus_pid" 2>/dev/null || true
      for _ in $(seq 1 20); do
        kill -0 "$dbus_pid" 2>/dev/null || break
        sleep 0.25
      done
      kill -KILL "$dbus_pid" 2>/dev/null || true
    fi
  fi
  log cleanup.complete "exit_code=$exit_status diagnostic_dir=$diag_dir"
}
trap cleanup EXIT

log preflight.start "started_at=$started_at diag_dir=$diag_dir user=${desktop_user:-missing} uid=${desktop_uid:-missing} display=$display attempts=$attempts pause_seconds=$probe_pause"
if [[ -z "$desktop_user" || ! "$desktop_uid" =~ ^[0-9]+$ ]]; then
  log preflight.failed reason=desktop-user-missing
  exit 2
fi
if [[ ! -x "$chrome_bin" ]]; then
  log preflight.failed "reason=chromium-elf-missing path=$chrome_bin"
  exit 2
fi
if [[ ! "$attempts" =~ ^[1-9][0-9]?$ ]] || ((attempts > 20)); then
  log preflight.failed "reason=invalid-attempts value=$attempts expected=1..20"
  exit 2
fi
if [[ ! "$probe_pause" =~ ^[1-5]$ ]]; then
  log preflight.failed "reason=invalid-probe-pause value=$probe_pause expected=1..5"
  exit 2
fi
if xdpyinfo -display "$display" >/dev/null 2>&1; then
  log preflight.failed reason=display-already-active action=avoid-disturbing-existing-desktop
  exit 3
fi
if [[ -e /tmp/.X1-lock ]]; then
  lock_pid="$(tr -cd '0-9' </tmp/.X1-lock 2>/dev/null || true)"
  if [[ ! "$lock_pid" =~ ^[0-9]+$ || ! -r "/proc/$lock_pid/stat" ]]; then
    log preflight.failed "reason=x11-lock-owner-unverifiable pid=${lock_pid:-unknown} action=preserve-lock"
    exit 3
  fi
  lock_state="$(awk '{print $3}' "/proc/$lock_pid/stat" 2>/dev/null || true)"
  lock_ppid="$(awk '{print $4}' "/proc/$lock_pid/stat" 2>/dev/null || true)"
  lock_comm="$(cat "/proc/$lock_pid/comm" 2>/dev/null || true)"
  live_lock_group="$(ps -eo pid=,pgid=,stat= | awk -v pgid="$lock_pid" '$2 == pgid && $3 !~ /Z|X/ {print $1}' | tr '\n' ',')"
  if [[ "$lock_comm" != Xvfb || "$lock_state" != Z* || "$lock_ppid" != 1 || -n "$live_lock_group" ]]; then
    log preflight.failed "reason=x11-lock-owner-not-stale pid=$lock_pid comm=${lock_comm:-unknown} state=${lock_state:-unknown} ppid=${lock_ppid:-unknown} live_group=${live_lock_group:-none} action=preserve-lock"
    exit 3
  fi
  stale_display_dir="$diag_dir/stale-display-artifacts"
  mkdir -m 0700 "$stale_display_dir"
  mv -- /tmp/.X1-lock "$stale_display_dir/X1-lock"
  if [[ -S /tmp/.X11-unix/X1 ]]; then mv -- /tmp/.X11-unix/X1 "$stale_display_dir/X1-socket"; fi
  log preflight.x11-stale-artifacts.quarantined "pid=$lock_pid comm=$lock_comm state=$lock_state ppid=$lock_ppid directory=$stale_display_dir"
fi
if ps -u "$desktop_uid" -o stat=,comm= 2>/dev/null | awk '$2 == "xfce4-session" && $1 !~ /Z|X/ { found=1 } END { exit !found }'; then
  log preflight.failed reason=xfce-session-already-active action=avoid-disturbing-existing-desktop
  exit 3
fi
for port in 19341 19342 19343; do
  if ss -lnt 2>/dev/null | awk -v suffix=":$port" 'NR > 1 && substr($4, length($4) - length(suffix) + 1) == suffix { found=1 } END { exit !found }'; then
    log preflight.failed "reason=diagnostic-port-already-listening port=$port"
    exit 3
  fi
done

install -d -o "$desktop_user" -g "$desktop_gid" -m 0755 "$desktop_home" "$diag_dir"
chown "$desktop_user:$desktop_gid" "$diag_dir"

start_display() {
  local -a command
  log display.start "server=Xvfb resolution=1280x800"
  command=(runuser -u "$desktop_user" -- env HOME="$desktop_home" DISPLAY="$display" \
    Xvfb "$display" -screen 0 1280x800x24 -nolisten tcp -ac +extension GLX +render -noreset)
  if ! start_group xvfb "$diag_dir/xvfb.pgid" "$diag_dir/xvfb.log" "${command[@]}"; then return 1; fi
  xvfb_group_pid="$started_group_pid"
  xvfb_launcher_pid="$started_launcher_pid"
  for attempt in $(seq 1 30); do
    if xdpyinfo -display "$display" >/dev/null 2>&1; then
      log display.ready "attempt=$attempt"
      return 0
    fi
    if ((attempt % 5 == 0)); then log display.wait "attempt=$attempt"; fi
    sleep 1
  done
  log display.failed reason=xdpyinfo-timeout
  tail -n 30 "$diag_dir/xvfb.log" 2>/dev/null | sed 's/^/chromium.stages xvfb.log /'
  return 1
}

start_session_bus() {
  local output status
  log dbus.start "mode=session system_bus_socket_present=$([[ -S /run/dbus/system_bus_socket ]] && printf yes || printf no)"
  output="$(runuser -u "$desktop_user" -- env HOME="$desktop_home" DISPLAY="$display" dbus-launch --sh-syntax 2>"$diag_dir/dbus-launch.log")"
  status=$?
  if ((status != 0)) || [[ -z "$output" ]]; then
    log dbus.failed "exit_code=$status"
    tail -n 20 "$diag_dir/dbus-launch.log" 2>/dev/null | sed 's/^/chromium.stages dbus.log /'
    return 1
  fi
  eval "$output"
  dbus_pid="${DBUS_SESSION_BUS_PID:-}"
  dbus_address="${DBUS_SESSION_BUS_ADDRESS:-}"
  log dbus.ready "pid=${dbus_pid:-unknown} address_configured=$([[ -n "$dbus_address" ]] && printf yes || printf no)"
  [[ -n "$dbus_address" ]]
}

start_xfce() {
  local -a command
  log xfce.start "display=$display"
  command=(runuser -u "$desktop_user" -- env HOME="$desktop_home" DISPLAY="$display" \
    DBUS_SESSION_BUS_ADDRESS="$dbus_address" startxfce4)
  if ! start_group xfce "$diag_dir/xfce.pgid" "$diag_dir/xfce.log" "${command[@]}"; then return 1; fi
  xfce_group_pid="$started_group_pid"
  xfce_launcher_pid="$started_launcher_pid"
  for attempt in $(seq 1 75); do
    local state_table session_ready wm_ready
    state_table="$(ps -u "$desktop_uid" -o stat=,comm= 2>/dev/null)"
    session_ready="$(awk '$2 == "xfce4-session" && $1 !~ /Z|X/ { found=1 } END { print found+0 }' <<<"$state_table")"
    wm_ready="$(awk '$2 == "xfwm4" && $1 !~ /Z|X/ { found=1 } END { print found+0 }' <<<"$state_table")"
    if [[ "$session_ready" == 1 && "$wm_ready" == 1 ]]; then
      log xfce.ready "attempt=$attempt session=$session_ready window_manager=$wm_ready"
      return 0
    fi
    if ((attempt % 15 == 0)); then log xfce.wait "attempt=$attempt session=$session_ready window_manager=$wm_ready"; fi
    sleep 1
  done
  log xfce.failed reason=readiness-timeout
  tail -n 40 "$diag_dir/xfce.log" 2>/dev/null | sed 's/^/chromium.stages xfce.log /'
  return 1
}

probe_chrome() {
  local stage="$1" port="$2" with_dbus="$3"
  local profile="$diag_dir/$stage-profile" log_path="$diag_dir/$stage-chromium.log"
  local -a chrome_flags
  local -a command
  local attempt result curl_status http_code listener pid
  chrome_flags=(
    --disable-dev-shm-usage --disable-gpu --no-first-run --no-default-browser-check
    --password-store=basic --remote-debugging-address=127.0.0.1
    "--remote-debugging-port=$port" "--user-data-dir=$profile" --start-maximized --no-sandbox about:blank
  )
  install -d -o "$desktop_user" -g "$desktop_gid" -m 0755 "$profile"
  log "$stage.chrome.start" "binary=$chrome_bin port=$port profile=$profile dbus=$with_dbus xfce=$([[ -n "$xfce_group_pid" ]] && printf ready || printf absent)"
  command=(runuser -u "$desktop_user" -- env HOME="$desktop_home" DISPLAY="$display")
  if [[ "$with_dbus" == yes ]]; then command+=(DBUS_SESSION_BUS_ADDRESS="$dbus_address"); fi
  command+=("$chrome_bin" "${chrome_flags[@]}")
  if ! start_group "$stage.chrome" "$diag_dir/$stage.pgid" "$log_path" "${command[@]}"; then
    stage_result=launch-error
    return 1
  fi
  chrome_group_pid="$started_group_pid"
  chrome_launcher_pid="$started_launcher_pid"
  stage_result=timeout
  for attempt in $(seq 1 "$attempts"); do
    result="$(timeout --kill-after=1s 4s curl --noproxy '*' --connect-timeout 1 --max-time 3 \
      -sS -o "$diag_dir/$stage-cdp-version.json" -w '%{http_code}' \
      "http://127.0.0.1:$port/json/version" 2>"$diag_dir/$stage-curl.log")"
    curl_status=$?
    http_code="$result"
    [[ "$curl_status" == 0 ]] || http_code=none
    listener="$(ss -lnt 2>/dev/null | awk -v p=":$port" 'index($0,p) {print "yes"; found=1} END {if (!found) print "no"}')"
    log "$stage.cdp.probe" "attempt=$attempt curl_exit=$curl_status http_code=$http_code listener=$listener"
    if [[ "$curl_status" == 0 && "$http_code" == 200 ]]; then
      stage_result=ready
      break
    fi
    if ((attempt % 3 == 0)); then
      log "$stage.chrome.process.sample" "$(ps -eo pid=,ppid=,pgid=,stat=,etime=,%cpu=,rss=,comm=,args= | grep -F -- "$profile" | grep -v grep | tr '\n' ';' | cut -c1-900)"
      if [[ -r "/proc/$chrome_group_pid/status" ]]; then
        log "$stage.chrome.main" "$(awk '/^(Name|State|Tgid|Pid|PPid|Uid|VmRSS|Threads):/ {printf "%s=%s;",$1,$2}' "/proc/$chrome_group_pid/status") wchan=$(cat "/proc/$chrome_group_pid/wchan" 2>/dev/null || true)"
      fi
      tail -n 12 "$log_path" 2>/dev/null | sed "s/^/chromium.stages $stage.chrome.log /"
    fi
    sleep "$probe_pause"
  done
  log "$stage.chrome.result" "result=$stage_result port=$port attempts=$attempt"
  case "$stage" in
    xvfb_only) xvfb_only_result="$stage_result" ;;
    session_bus_only) session_bus_only_result="$stage_result" ;;
    xfce_and_session_bus) xfce_and_session_bus_result="$stage_result" ;;
  esac
  stop_group "$stage.chrome" "$chrome_group_pid" "$chrome_launcher_pid" "stage=$stage"
  chrome_group_pid=
  chrome_launcher_pid=
}

if ! start_display; then exit 1; fi
probe_chrome xvfb_only 19341 no

if ! start_session_bus; then
  log sequence.failed stage=session-bus
  exit 1
fi
probe_chrome session_bus_only 19342 yes

if ! start_xfce; then
  log sequence.failed stage=xfce-start
  exit 1
fi
probe_chrome xfce_and_session_bus 19343 yes
log sequence.complete "xvfb_only=$xvfb_only_result session_bus_only=$session_bus_only_result xfce_and_session_bus=$xfce_and_session_bus_result diag_dir=$diag_dir"
