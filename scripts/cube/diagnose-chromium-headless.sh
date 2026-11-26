#!/usr/bin/env bash
set -Eeuo pipefail

desktop_user="${CSA_DIAGNOSTIC_USER:-user}"
desktop_uid="$(id -u "$desktop_user" 2>/dev/null || true)"
desktop_home="$(getent passwd "$desktop_user" | cut -d: -f6)"
chrome_bin="${CSA_CHROMIUM_BIN:-/usr/lib/chromium/chromium}"
cdp_port="${CSA_CHROMIUM_CDP_PORT:-19344}"
startup_timeout_seconds="${CSA_CHROMIUM_STARTUP_TIMEOUT_SECONDS:-90}"
probe_interval_seconds="${CSA_CHROMIUM_PROBE_INTERVAL_SECONDS:-2}"
strace_enabled="${CSA_CHROMIUM_STRACE:-0}"
http_strace_enabled="${CSA_CHROMIUM_HTTP_STRACE:-0}"
websocket_strace_enabled="${CSA_CHROMIUM_WEBSOCKET_STRACE:-0}"
http_probes_enabled="${CSA_CHROMIUM_HTTP_PROBES:-1}"
thread_sample_enabled="${CSA_CHROMIUM_THREAD_SAMPLE:-0}"
gdb_sample_enabled="${CSA_CHROMIUM_GDB_SAMPLE:-0}"
gdb_timeout_seconds="${CSA_CHROMIUM_GDB_TIMEOUT_SECONDS:-20}"
dbus_session_enabled="${CSA_CHROMIUM_DBUS_SESSION:-0}"
perf_sample_enabled="${CSA_CHROMIUM_PERF_SAMPLE:-0}"
websocket_probes_enabled="${CSA_CHROMIUM_WEBSOCKET_PROBES:-1}"
trace_startup_enabled="${CSA_CHROMIUM_TRACE_STARTUP:-0}"
no_sandbox_enabled="${CSA_CHROMIUM_NO_SANDBOX:-1}"
tag="${CSA_CHROMIUM_DIAGNOSTIC_TAG:-$(date -u +%Y%m%dT%H%M%SZ)-$$}"
diag_dir="/tmp/csa-chromium-headless-$tag"
trace_file="$diag_dir/chrome-startup-trace.json"
strace_log="$diag_dir/strace.log"
http_strace_log="$diag_dir/http-strace.log"
http_strace_error="$diag_dir/http-strace.stderr"
websocket_strace_log="$diag_dir/websocket-strace.log"
websocket_strace_error="$diag_dir/websocket-strace.stderr"
websocket_client_log="$diag_dir/websocket-client.log"
websocket_client_trace_prefix="$diag_dir/websocket-client-strace"
chrome_group_pid=
chrome_launcher_pid=
chrome_started_seconds=
http_strace_pid=
websocket_strace_pid=
chrome_result=not-run
http_success_count=0
websocket_success=0

log() {
  printf 'chromium.headless timestamp=%s stage=%s %s\n' \
    "$(date -u +%FT%TZ)" "$1" "${*:2}"
}

start_group() {
  local pidfile="$1" log_path="$2" attempt group_id
  shift 2
  rm -f -- "$pidfile"
  setsid bash -c 'pidfile=$1; log_path=$2; shift 2; printf "%s\n" "$$" >"$pidfile"; exec "$@" >"$log_path" 2>&1' \
    csa-chromium-headless "$pidfile" "$log_path" "$@" &
  chrome_launcher_pid=$!
  for attempt in $(seq 1 20); do
    if [[ -s "$pidfile" ]]; then
      group_id="$(cat "$pidfile" 2>/dev/null || true)"
      if [[ "$group_id" =~ ^[0-9]+$ ]] && [[ "$(ps -o pgid= -p "$group_id" 2>/dev/null | tr -d ' ')" == "$group_id" ]]; then
        chrome_group_pid="$group_id"
        break
      fi
    fi
    sleep 0.1
  done
  [[ -n "$chrome_group_pid" ]]
  log process.started "pid=$chrome_group_pid pgid=$chrome_group_pid launcher_pid=$chrome_launcher_pid log=$log_path"
}

stop_group() {
  local pid="$1" attempt members
  [[ "$pid" =~ ^[0-9]+$ ]] || return 0
  members="$(ps -eo pid=,pgid=,stat=,comm= | awk -v pgid="$pid" '$2 == pgid { print $1 ":" $3 ":" $4 }' | tr '\n' ',')"
  log cleanup.term "pgid=$pid members=${members%,}"
  kill -TERM -- "-$pid" 2>/dev/null || true
  for attempt in $(seq 1 20); do
    members="$(ps -eo pid=,pgid=,stat= | awk -v pgid="$pid" '$2 == pgid && $3 !~ /Z|X/ { print $1 }')"
    [[ -n "$members" ]] || break
    sleep 0.2
  done
  if [[ -n "$members" ]]; then
    log cleanup.kill "pgid=$pid live_pids=${members//$'\n'/,}"
    kill -KILL -- "-$pid" 2>/dev/null || true
  fi
  [[ -z "$chrome_launcher_pid" ]] || wait "$chrome_launcher_pid" 2>/dev/null || true
  members="$(ps -eo pid=,pgid=,stat=,comm= | awk -v pgid="$pid" '$2 == pgid { print $1 ":" $3 ":" $4 }' | tr '\n' ',')"
  log cleanup.complete "pgid=$pid remaining=${members%,}"
}

cleanup() {
  local exit_status=$?
  trap - EXIT
  stop_http_strace
  stop_websocket_strace
  [[ -z "$chrome_group_pid" ]] || stop_group "$chrome_group_pid"
  log sequence.complete "exit_code=$exit_status result=$chrome_result directory=$diag_dir"
}
trap cleanup EXIT

stop_http_strace() {
  [[ "$http_strace_pid" =~ ^[0-9]+$ ]] || return 0
  kill -INT "$http_strace_pid" 2>/dev/null || true
  wait "$http_strace_pid" 2>/dev/null || true
  http_strace_pid=
}

stop_websocket_strace() {
  [[ "$websocket_strace_pid" =~ ^[0-9]+$ ]] || return 0
  kill -INT "$websocket_strace_pid" 2>/dev/null || true
  wait "$websocket_strace_pid" 2>/dev/null || true
  websocket_strace_pid=
}

snapshot_chromium_threads() {
  local pid="$1" task_dir tid comm state_ticks state ticks
  for task_dir in "/proc/$pid/task/"*; do
    [[ -r "$task_dir/stat" ]] || continue
    tid="${task_dir##*/}"
    comm="$(cat "$task_dir/comm" 2>/dev/null || printf unknown)"
    state_ticks="$(awk '{sub(/^.*\) /, ""); print $1, $12 + $13}' "$task_dir/stat" 2>/dev/null || true)"
    read -r state ticks <<<"$state_ticks"
    [[ "$ticks" =~ ^[0-9]+$ ]] || continue
    printf '%s\t%s\t%s\t%s\n' "$tid" "$comm" "${state:-?}" "$ticks"
  done
}

sample_chromium_thread_cpu() {
  local pid="$1" before="$diag_dir/thread-cpu-before.tsv" after="$diag_dir/thread-cpu-after.tsv"
  local top="$diag_dir/thread-cpu-top.tsv" started_ms finished_ms elapsed_ms clock_ticks
  started_ms="$(date +%s%3N)"
  snapshot_chromium_threads "$pid" >"$before"
  sleep 2
  snapshot_chromium_threads "$pid" >"$after"
  finished_ms="$(date +%s%3N)"
  elapsed_ms=$((finished_ms - started_ms))
  clock_ticks="$(getconf CLK_TCK 2>/dev/null || printf 100)"
  awk -F '\t' -v hz="$clock_ticks" -v elapsed_ms="$elapsed_ms" '
    NR == FNR { previous[$1]=$4; names[$1]=$2; next }
    $1 in previous {
      delta=$4-previous[$1]
      cpu_ms=delta*1000/hz
      cpu_pct=elapsed_ms > 0 ? delta*100000/(hz*elapsed_ms) : 0
      printf "%.3f\t%.1f\t%s\t%s\t%s\n", cpu_ms, cpu_pct, $1, $2, $3
    }
  ' "$before" "$after" | sort -nr -k1,1 | head -n 8 >"$top"
  log thread.cpu.sample "pid=$pid duration_ms=$elapsed_ms thread_count=$(wc -l <"$after" | tr -d ' ')"
  while IFS=$'\t' read -r cpu_ms cpu_pct tid comm state; do
    [[ -n "$tid" ]] || continue
    local wchan syscall
    wchan="$(cat "/proc/$pid/task/$tid/wchan" 2>/dev/null || printf unknown)"
    syscall="$(cat "/proc/$pid/task/$tid/syscall" 2>&1 | cut -c1-120)"
    log thread.cpu.hot "tid=$tid comm=$comm state=$state cpu_ms=$cpu_ms cpu_pct=$cpu_pct wchan=$wchan syscall=$syscall"
  done <"$top"
}

sample_chromium_main_stack() {
  local pid="$1" stack_log="$diag_dir/gdb-main-thread.log" gdb_exit=0
  log gdb.stack.start "pid=$pid timeout_seconds=$gdb_timeout_seconds"
  DEBUGINFOD_URLS= DEBUGINFOD_PROGRESS=0 timeout --signal=INT --kill-after=2s "${gdb_timeout_seconds}s" \
    gdb --nx --quiet --batch -iex 'set debuginfod enabled off' -p "$pid" \
    -ex 'set pagination off' -ex 'set confirm off' \
    -ex 'info threads' -ex 'thread 1' -ex 'bt 24' -ex 'x/12i $pc' -ex 'detach' \
    >"$stack_log" 2>&1 || gdb_exit=$?
  log gdb.stack.result "pid=$pid exit_code=$gdb_exit bytes=$(wc -c <"$stack_log" | tr -d ' ')"
  tail -n 48 "$stack_log" | while IFS= read -r line; do log gdb.stack.line "${line:0:360}"; done
}

sample_chromium_main_perf() {
  local pid="$1" top_log="$diag_dir/perf-top.txt" top_exit=0 top_lines line
  log perf.top.start "pid=$pid duration_seconds=8 frequency_hz=49 event=cpu-clock:u call_graph=fp"
  timeout --signal=INT --kill-after=4s 8s perf top --stdio -e cpu-clock:u -F 49 -d 1 \
    -p "$pid" --call-graph fp --sort=symbol --entries=30 >"$top_log" 2>&1 || top_exit=$?
  top_lines="$(wc -l <"$top_log" | tr -d ' ')"
  log perf.top.result "pid=$pid exit_code=$top_exit lines=$top_lines"
  tail -n 80 "$top_log" | while IFS= read -r line; do
    line="$(printf '%.360s' "$line")"
    log perf.top.line "$line"
  done
}

if [[ -z "$desktop_uid" || ! "$desktop_uid" =~ ^[0-9]+$ || -z "$desktop_home" ]]; then
  log preflight.failed "reason=desktop-user-not-found user=$desktop_user"
  exit 2
fi
if [[ ! -x "$chrome_bin" ]]; then
  log preflight.failed "reason=chromium-missing binary=$chrome_bin"
  exit 2
fi
if [[ ! "$cdp_port" =~ ^[0-9]+$ ]] || ((cdp_port < 1024 || cdp_port > 65535)); then
  log preflight.failed "reason=invalid-cdp-port port=$cdp_port"
  exit 2
fi
if [[ ! "$startup_timeout_seconds" =~ ^[0-9]+$ ]] || ((startup_timeout_seconds < 10 || startup_timeout_seconds > 180)); then
  log preflight.failed "reason=invalid-startup-timeout seconds=$startup_timeout_seconds expected=10..180"
  exit 2
fi
if [[ ! "$probe_interval_seconds" =~ ^[1-9]$ ]]; then
  log preflight.failed "reason=invalid-probe-interval seconds=$probe_interval_seconds expected=1..9"
  exit 2
fi
if [[ "$strace_enabled" != 0 && "$strace_enabled" != 1 ]]; then
  log preflight.failed "reason=invalid-strace-flag value=$strace_enabled expected=0-or-1"
  exit 2
fi
if [[ "$http_strace_enabled" != 0 && "$http_strace_enabled" != 1 ]]; then
  log preflight.failed "reason=invalid-http-strace-flag value=$http_strace_enabled expected=0-or-1"
  exit 2
fi
if [[ "$websocket_strace_enabled" != 0 && "$websocket_strace_enabled" != 1 ]]; then
  log preflight.failed "reason=invalid-websocket-strace-flag value=$websocket_strace_enabled expected=0-or-1"
  exit 2
fi
if [[ "$http_probes_enabled" != 0 && "$http_probes_enabled" != 1 ]]; then
  log preflight.failed "reason=invalid-http-probes-flag value=$http_probes_enabled expected=0-or-1"
  exit 2
fi
if [[ "$thread_sample_enabled" != 0 && "$thread_sample_enabled" != 1 ]]; then
  log preflight.failed "reason=invalid-thread-sample-flag value=$thread_sample_enabled expected=0-or-1"
  exit 2
fi
if [[ "$gdb_sample_enabled" != 0 && "$gdb_sample_enabled" != 1 ]]; then
  log preflight.failed "reason=invalid-gdb-sample-flag value=$gdb_sample_enabled expected=0-or-1"
  exit 2
fi
if [[ "$dbus_session_enabled" != 0 && "$dbus_session_enabled" != 1 ]]; then
  log preflight.failed "reason=invalid-dbus-session-flag value=$dbus_session_enabled expected=0-or-1"
  exit 2
fi
if [[ "$perf_sample_enabled" != 0 && "$perf_sample_enabled" != 1 ]]; then
  log preflight.failed "reason=invalid-perf-sample-flag value=$perf_sample_enabled expected=0-or-1"
  exit 2
fi
if [[ "$websocket_probes_enabled" != 0 && "$websocket_probes_enabled" != 1 ]]; then
  log preflight.failed "reason=invalid-websocket-probes-flag value=$websocket_probes_enabled expected=0-or-1"
  exit 2
fi
if [[ "$trace_startup_enabled" != 0 && "$trace_startup_enabled" != 1 ]]; then
  log preflight.failed "reason=invalid-trace-startup-flag value=$trace_startup_enabled expected=0-or-1"
  exit 2
fi
if [[ "$no_sandbox_enabled" != 0 && "$no_sandbox_enabled" != 1 ]]; then
  log preflight.failed "reason=invalid-no-sandbox-flag value=$no_sandbox_enabled expected=0-or-1"
  exit 2
fi
if [[ ! "$gdb_timeout_seconds" =~ ^[0-9]+$ ]] || ((gdb_timeout_seconds < 5 || gdb_timeout_seconds > 45)); then
  log preflight.failed "reason=invalid-gdb-timeout seconds=$gdb_timeout_seconds expected=5..45"
  exit 2
fi
if [[ "$gdb_sample_enabled" == 1 ]] && ! command -v gdb >/dev/null 2>&1; then
  log preflight.failed "reason=gdb-missing enabled=$gdb_sample_enabled"
  exit 2
fi
if [[ "$dbus_session_enabled" == 1 ]] && ! command -v dbus-run-session >/dev/null 2>&1; then
  log preflight.failed "reason=dbus-run-session-missing enabled=$dbus_session_enabled"
  exit 2
fi
if [[ "$perf_sample_enabled" == 1 ]] && ! command -v perf >/dev/null 2>&1; then
  log preflight.failed "reason=perf-missing enabled=$perf_sample_enabled"
  exit 2
fi
if [[ "$strace_enabled" == 1 ]] && ! command -v strace >/dev/null 2>&1; then
  log preflight.failed "reason=strace-missing enabled=$strace_enabled"
  exit 2
fi
if [[ "$http_strace_enabled" == 1 ]] && ! command -v strace >/dev/null 2>&1; then
  log preflight.failed "reason=strace-missing enabled=$http_strace_enabled"
  exit 2
fi
if [[ "$websocket_strace_enabled" == 1 ]] && ! command -v strace >/dev/null 2>&1; then
  log preflight.failed "reason=strace-missing enabled=$websocket_strace_enabled"
  exit 2
fi
if ss -lnt 2>/dev/null | awk -v suffix=":$cdp_port" 'NR > 1 && substr($4, length($4) - length(suffix) + 1) == suffix { found=1 } END { exit !found }'; then
  log preflight.failed "reason=port-already-listening port=$cdp_port"
  exit 3
fi
if [[ -e "$diag_dir" ]]; then
  log preflight.failed "reason=diagnostic-directory-exists directory=$diag_dir"
  exit 3
fi

mkdir -m 0700 "$diag_dir"
desktop_group="$(id -gn "$desktop_user")"
chown "$desktop_user:$desktop_group" "$diag_dir"
install -d -o "$desktop_user" -g "$desktop_group" -m 0755 "$desktop_home" "$diag_dir/profile"
exec > >(tee -a "$diag_dir/run.log") 2>&1
log preflight.ready "user=$desktop_user uid=$desktop_uid binary=$chrome_bin port=$cdp_port system_bus_socket=$([[ -S /run/dbus/system_bus_socket ]] && printf present || printf missing) session_bus=$([[ "$dbus_session_enabled" == 1 ]] && printf enabled || printf unset) display_env=${DISPLAY:-unset}"
"$chrome_bin" --version 2>&1 | tee "$diag_dir/chromium-version.txt"

chrome_flags=(
  --headless=new --disable-gpu --disable-dev-shm-usage --no-first-run --no-default-browser-check
  --password-store=basic --enable-logging=stderr
  --remote-debugging-address=127.0.0.1 "--remote-debugging-port=$cdp_port"
  "--user-data-dir=$diag_dir/profile" about:blank
)
if [[ "$no_sandbox_enabled" == 1 ]]; then chrome_flags+=(--no-sandbox); fi
if [[ "$trace_startup_enabled" == 1 ]]; then
  chrome_flags+=(
    '--trace-startup=-*,toplevel,disabled-by-default-sequence_manager'
    "--trace-startup-file=$trace_file"
    --trace-startup-format=json
    "--trace-startup-duration=$startup_timeout_seconds"
  )
  log chrome.trace.startup "enabled=1 file=$trace_file duration_seconds=$startup_timeout_seconds categories=toplevel,disabled-by-default-sequence_manager"
fi
port_hex="$(printf '%04X' "$cdp_port")"
log chrome.launch "mode=headless-new profile=$diag_dir/profile port=$cdp_port no_sandbox=$no_sandbox_enabled system_bus_socket=$([[ -S /run/dbus/system_bus_socket ]] && printf present || printf missing) session_bus=$([[ "$dbus_session_enabled" == 1 ]] && printf enabled || printf unset)"
if [[ "$dbus_session_enabled" == 1 ]]; then
  chrome_command=(
    runuser -u "$desktop_user" -- dbus-run-session -- env -u DISPLAY HOME="$desktop_home" \
    "$chrome_bin" "${chrome_flags[@]}"
  )
else
  chrome_command=(
    runuser -u "$desktop_user" -- env -u DISPLAY -u DBUS_SESSION_BUS_ADDRESS HOME="$desktop_home" \
    "$chrome_bin" "${chrome_flags[@]}"
  )
fi
if [[ "$strace_enabled" == 1 ]]; then
  chrome_command=(strace -f -tt -T -s 96 -o "$strace_log" \
    -e trace=network,epoll_ctl,epoll_wait,epoll_pwait,setns,unshare -- "${chrome_command[@]}")
  log strace.start "trace=network,epoll_ctl,epoll_wait,epoll_pwait,setns,unshare file=$strace_log"
fi
start_group "$diag_dir/chromium.pgid" "$diag_dir/chromium.log" "${chrome_command[@]}"
chrome_started_seconds=$SECONDS

chrome_result=timeout
attempt=0
perf_sample_done=0
startup_deadline=$((SECONDS + startup_timeout_seconds))
while ((SECONDS < startup_deadline)); do
  attempt=$((attempt + 1))
  probe_started_ms="$(date +%s%3N)"
  ss_listener="$(ss -lnt 2>/dev/null | awk -v suffix=":$cdp_port" 'NR > 1 && substr($4, length($4) - length(suffix) + 1) == suffix { found=1 } END { print found+0 }')"
  proc_listener="$(awk -v port="$port_hex" '$4 == "0A" { split($2, endpoint, ":"); if (toupper(endpoint[2]) == port) found=1 } END { print found+0 }' /proc/net/tcp /proc/net/tcp6 2>/dev/null)"
  chrome_pid=
  chrome_proc_listener=0
  chrome_netns=unknown
  for pid in $(ps -eo pid=,pgid=,stat= | awk -v pgid="$chrome_group_pid" '$2 == pgid && $3 !~ /Z|X/ { print $1 }'); do
    executable="$(readlink "/proc/$pid/exe" 2>/dev/null || true)"
    case "$executable" in */chrome|*/chromium) ;; *) continue ;; esac
    command_line="$(tr '\0' ' ' <"/proc/$pid/cmdline" 2>/dev/null || true)"
    case "$command_line" in *--type=*) continue ;; esac
    chrome_pid="$pid"
    chrome_netns="$(readlink "/proc/$pid/ns/net" 2>/dev/null || printf unknown)"
    chrome_proc_listener="$(awk -v port="$port_hex" '$4 == "0A" { split($2, endpoint, ":"); if (toupper(endpoint[2]) == port) found=1 } END { print found+0 }' "/proc/$pid/net/tcp" "/proc/$pid/net/tcp6" 2>/dev/null)"
    break
  done
  probe_finished_ms="$(date +%s%3N)"
  probe_duration_ms=$((probe_finished_ms - probe_started_ms))
  listener=0
  listener_method=none
  if [[ "$ss_listener" == 1 ]]; then listener=1; listener_method=ss
  elif [[ "$proc_listener" == 1 ]]; then listener=1; listener_method=proc-net-tcp
  elif [[ "$chrome_proc_listener" == 1 ]]; then listener=1; listener_method=chrome-netns-tcp
  fi
  log cdp.listener.probe "attempt=$attempt ss=$ss_listener proc_tcp=$proc_listener chrome_proc_tcp=$chrome_proc_listener chrome_pid=${chrome_pid:-none} chrome_netns=$chrome_netns probe_ms=$probe_duration_ms"
  if [[ "$perf_sample_enabled" == 1 && "$chrome_pid" =~ ^[0-9]+$ && "$perf_sample_done" == 0 ]] \
    && ((SECONDS >= chrome_started_seconds + 10)); then
    sample_chromium_main_perf "$chrome_pid"
    perf_sample_done=1
  fi
  if [[ "$listener" == 1 ]]; then
    chrome_result=listener-ready
    log cdp.listener.ready "port=$cdp_port method=$listener_method attempt=$attempt elapsed_seconds=$((startup_timeout_seconds - (startup_deadline - SECONDS)))"
    break
  fi
  live_members="$(ps -eo pid=,pgid=,stat= | awk -v pgid="$chrome_group_pid" '$2 == pgid && $3 !~ /Z|X/ { print $1 }')"
  if [[ -z "$live_members" ]]; then
    chrome_result=process-exited
    log cdp.listener.failed "reason=chromium-process-group-exited port=$cdp_port attempt=$attempt"
    break
  fi
  if ((attempt == 1 || attempt % 5 == 0)); then
    ps -eo pid=,ppid=,pgid=,stat=,etime=,%cpu=,rss=,comm=,args= \
      | awk -v pgid="$chrome_group_pid" '$3 == pgid { print }' \
      | cut -c1-1200 | while IFS= read -r line; do log process.sample "$line"; done
    for pid in $live_members; do
      [[ "$(cat "/proc/$pid/comm" 2>/dev/null || true)" == chromium ]] || continue
      thread_count="$(find "/proc/$pid/task" -mindepth 1 -maxdepth 1 -type d 2>/dev/null | wc -l | tr -d ' ')"
      log thread.sample "pid=$pid thread_count=$thread_count state=$(awk '/^State:/ {print $2}' "/proc/$pid/status" 2>/dev/null || true) wchan=$(cat "/proc/$pid/wchan" 2>/dev/null || true) syscall=$(cat "/proc/$pid/syscall" 2>&1 || true)"
      break
    done
    tail -n 15 "$diag_dir/chromium.log" 2>/dev/null \
      | sed -E 's#(DevTools listening on ws://)[^[:space:]]+#\1[redacted]#g' \
      | while IFS= read -r line; do log chromium.log "$line"; done
  fi
  log cdp.listener.wait "attempt=$attempt port=$cdp_port interval_seconds=$probe_interval_seconds"
  sleep "$probe_interval_seconds"
done

if [[ "$chrome_result" == listener-ready ]]; then
  if [[ "$gdb_sample_enabled" == 1 && "$chrome_pid" =~ ^[0-9]+$ ]]; then
    sample_chromium_main_stack "$chrome_pid"
  fi
  if [[ "$perf_sample_enabled" == 1 && "$chrome_pid" =~ ^[0-9]+$ && "$perf_sample_done" == 0 ]]; then
    sample_chromium_main_perf "$chrome_pid"
    perf_sample_done=1
  fi
  if [[ "$thread_sample_enabled" == 1 && "$chrome_pid" =~ ^[0-9]+$ ]]; then
    sample_chromium_thread_cpu "$chrome_pid"
  fi
  if [[ "$http_probes_enabled" == 1 ]]; then
  probe_curl() {
    local name="$1" exit_code=0 result body="$diag_dir/$1.body" headers="$diag_dir/$1.headers" body_bytes=0 header_summary=missing
    shift
    result="$(timeout --kill-after=1s 7s curl --noproxy '*' --connect-timeout 1 --max-time 5 \
      "$@" -sS -D "$headers" -o "$body" \
      -w 'http_code=%{http_code} downloaded=%{size_download} total_seconds=%{time_total}' \
      "http://127.0.0.1:$cdp_port/json/version" 2>&1)" || exit_code=$?
    [[ ! -f "$body" ]] || body_bytes="$(wc -c <"$body" | tr -d ' ')"
    [[ ! -f "$headers" ]] || header_summary="$(tr '\n' ' ' <"$headers" | cut -c1-300)"
    if [[ "$result" == *"http_code=200"* ]] && ((body_bytes > 0)); then http_success_count=$((http_success_count + 1)); fi
    log http.client.result "client=$name exit_code=$exit_code result=$(printf '%q' "$result") body_bytes=$body_bytes headers=$(printf '%q' "$header_summary")"
  }
  if [[ "$http_strace_enabled" == 1 ]]; then
    strace -f -tt -T -s 112 -o "$http_strace_log" \
      -e trace=network,read,write -p "$chrome_pid" 2>"$http_strace_error" &
    http_strace_pid=$!
    for attach_attempt in $(seq 1 30); do
      grep -q 'attached' "$http_strace_error" 2>/dev/null && break
      kill -0 "$http_strace_pid" 2>/dev/null || break
      sleep 0.1
    done
    if grep -q 'attached' "$http_strace_error" 2>/dev/null; then
      log http.strace.attached "pid=$chrome_pid tracer_pid=$http_strace_pid"
      probe_curl curl-default-traced
    else
      log http.strace.attach.failed "pid=$chrome_pid tracer_pid=$http_strace_pid error=$(tail -n 2 "$http_strace_error" | tr '\n' ' ' | cut -c1-240)"
      probe_curl curl-default
    fi
    stop_http_strace
    if [[ -s "$http_strace_log" ]]; then
      http_trace_bytes="$(wc -c <"$http_strace_log" | tr -d ' ')"
      http_trace_lines="$(wc -l <"$http_strace_log" | tr -d ' ')"
      log http.strace.summary "bytes=$http_trace_bytes lines=$http_trace_lines"
      grep -E 'accept4?\(|/json/version|HTTP/1\.[01]|read\(|write\(' "$http_strace_log" 2>/dev/null | tail -n 30 \
        | while IFS= read -r line; do log http.strace.line "${line:0:360}"; done
    fi
  else
    probe_curl curl-default
  fi
  probe_curl curl-connection-close -H 'Connection: close'
  probe_curl curl-http10 --http1.0

  python_code="import urllib.request; r=urllib.request.urlopen('http://127.0.0.1:$cdp_port/json/version', timeout=5); b=r.read(); print('status=%s bytes=%s end=1' % (r.status, len(b)))"
  python_exit=0
  python_result="$(timeout --kill-after=1s 7s python3 -c "$python_code" 2>&1)" || python_exit=$?
  log http.client.result "client=python-urllib exit_code=$python_exit result=$(printf '%q' "$python_result")"

  node_code="const http=require('http');let n=0;const req=http.get('http://127.0.0.1:$cdp_port/json/version',r=>{r.on('data',c=>n+=c.length);r.on('end',()=>console.log('status='+r.statusCode+' bytes='+n+' end=1'));});req.setTimeout(5000,()=>req.destroy(new Error('timeout')));req.on('error',e=>{console.error('request_error='+e.message);process.exitCode=1;});"
  node_exit=0
  node_result="$(timeout --kill-after=1s 7s node -e "$node_code" 2>&1)" || node_exit=$?
  log http.client.result "client=node-http exit_code=$node_exit result=$(printf '%q' "$node_result")"
  if [[ "$node_exit" == 0 && "$node_result" == *"status=200"* && "$node_result" == *"end=1"* ]]; then http_success_count=$((http_success_count + 1)); fi

  python_probe_exit="${python_exit:-1}"
  if [[ "$python_probe_exit" == 0 && "$python_result" == *"status=200"* && "$python_result" == *"end=1"* ]]; then http_success_count=$((http_success_count + 1)); fi
  else
    log http.probes.skipped "reason=previous-runs-confirmed-http-handler-stall"
  fi

  if [[ "$websocket_probes_enabled" == 1 ]]; then
  websocket_url="$(awk '/DevTools listening on ws:/ { print $NF }' "$diag_dir/chromium.log" 2>/dev/null | tail -n 1)"
  if [[ -z "$websocket_url" ]]; then
    log cdp.websocket.probe "status=unavailable reason=devtools-websocket-url-not-logged"
  else
    websocket_node="${CSA_WEBSOCKET_NODE_BIN:-/opt/csa-agent-runtime/bin/node}"
    if [[ ! -x "$websocket_node" ]]; then websocket_node="$(command -v node || true)"; fi
    if [[ -z "$websocket_node" || ! -x "$websocket_node" ]]; then
      log cdp.websocket.probe "status=unavailable reason=node-runtime-missing"
      websocket_node=
    fi
    if [[ -n "$websocket_node" ]]; then
      websocket_node_version="$("$websocket_node" --version 2>&1 | head -n 1)"
      log cdp.websocket.runtime "binary=$websocket_node version=$websocket_node_version"
    if [[ "$websocket_strace_enabled" == 1 ]]; then
      strace -f -tt -T -s 112 -o "$websocket_strace_log" \
        -e trace=network,read,write -p "$chrome_pid" 2>"$websocket_strace_error" &
      websocket_strace_pid=$!
      for attach_attempt in $(seq 1 30); do
        grep -q 'attached' "$websocket_strace_error" 2>/dev/null && break
        kill -0 "$websocket_strace_pid" 2>/dev/null || break
        sleep 0.1
      done
      if grep -q 'attached' "$websocket_strace_error" 2>/dev/null; then
        log cdp.websocket.strace.attached "pid=$chrome_pid tracer_pid=$websocket_strace_pid"
      else
        log cdp.websocket.strace.attach.failed "pid=$chrome_pid tracer_pid=$websocket_strace_pid error=$(tail -n 2 "$websocket_strace_error" | tr '\n' ' ' | cut -c1-240)"
        stop_websocket_strace
      fi
    fi

    websocket_http_url="${websocket_url/#ws:\/\//http://}"
    websocket_key="$(head -c 16 /dev/urandom | base64 | tr -d '\n')"
    websocket_headers="$diag_dir/websocket-handshake.headers"
    websocket_body="$diag_dir/websocket-handshake.body"
    websocket_handshake_exit=0
    websocket_handshake_result="$(timeout --kill-after=1s 9s curl --noproxy '*' --connect-timeout 1 --max-time 7 \
      -sS -D "$websocket_headers" -o "$websocket_body" \
      -H 'Connection: Upgrade' -H 'Upgrade: websocket' -H 'Sec-WebSocket-Version: 13' \
      -H "Sec-WebSocket-Key: $websocket_key" \
      -w 'http_code=%{http_code} downloaded=%{size_download} total_seconds=%{time_total}' \
      "$websocket_http_url" 2>&1)" || websocket_handshake_exit=$?
    websocket_handshake_header_summary=missing
    [[ ! -f "$websocket_headers" ]] || websocket_handshake_header_summary="$(tr '\n' ' ' <"$websocket_headers" | cut -c1-240)"
    log cdp.websocket.raw-upgrade "exit_code=$websocket_handshake_exit result=$(printf '%q' "$websocket_handshake_result") headers=$(printf '%q' "$websocket_handshake_header_summary")"

    websocket_code='
const url = process.env.CDP_WS_URL;
if (typeof WebSocket !== "function") { console.log("result=websocket-api-unavailable"); process.exit(2); }
let socket;
let done = false;
const timer = setTimeout(() => finish(124, "timeout"), 7000);
function finish(code, message) {
  if (done) return;
  done = true;
  clearTimeout(timer);
  console.log("result=" + message);
  try { socket?.close(); } catch {}
  setTimeout(() => process.exit(code), 50);
}
try { socket = new WebSocket(url); } catch { finish(1, "websocket-construction-failed"); }
socket?.addEventListener("open", () => {
  console.log("websocket.open");
  socket.send(JSON.stringify({ id: 1, method: "Browser.getVersion" }));
});
socket?.addEventListener("message", event => {
  let response;
  try { response = JSON.parse(String(event.data)); } catch { return; }
  if (response.id !== 1) return;
  if (response.error) finish(1, "cdp-error");
  else finish(0, "cdp-result product=" + String(response.result?.product || "unknown"));
});
socket?.addEventListener("error", () => finish(1, "websocket-error"));
socket?.addEventListener("close", () => { if (!done) finish(1, "websocket-closed"); });
'
    websocket_exit=0
    if [[ "$websocket_strace_enabled" == 1 ]]; then
      CDP_WS_URL="$websocket_url" strace -ff -tt -T -s 192 -o "$websocket_client_trace_prefix" \
        -e trace=network,epoll_ctl,epoll_wait,epoll_pwait -- timeout --kill-after=1s 12s \
        "$websocket_node" --input-type=module -e "$websocket_code" >"$websocket_client_log" 2>&1 || websocket_exit=$?
    else
      CDP_WS_URL="$websocket_url" timeout --kill-after=1s 12s \
        "$websocket_node" --input-type=module -e "$websocket_code" >"$websocket_client_log" 2>&1 || websocket_exit=$?
    fi
    websocket_result="$(sed -E -e 's#(ws://[^[:space:]]+)#[redacted]#g' \
      -e 's#(/devtools/browser/)[A-Za-z0-9_-]+#\1[redacted]#g' "$websocket_client_log" 2>/dev/null | tail -n 20 | tr '\n' ' ')"
    stop_websocket_strace
    if [[ -s "$websocket_strace_log" ]]; then
      websocket_trace_bytes="$(wc -c <"$websocket_strace_log" | tr -d ' ')"
      websocket_trace_lines="$(wc -l <"$websocket_strace_log" | tr -d ' ')"
      websocket_accept_count="$(grep -Ec 'accept4?\(' "$websocket_strace_log" 2>/dev/null || true)"
      websocket_request_count="$(grep -Ec '/devtools/browser|Upgrade:|GET /' "$websocket_strace_log" 2>/dev/null || true)"
      websocket_response_count="$(grep -Ec 'HTTP/1\.[01] (101|4[0-9][0-9])|Switching Protocols' "$websocket_strace_log" 2>/dev/null || true)"
      log cdp.websocket.strace.summary "bytes=$websocket_trace_bytes lines=$websocket_trace_lines accepts=$websocket_accept_count upgrade_requests=$websocket_request_count responses=$websocket_response_count"
      grep -E 'accept4?\(|/devtools/browser|Upgrade:|GET /|HTTP/1\.[01]' "$websocket_strace_log" 2>/dev/null | tail -n 30 \
        | sed -E -e 's#(/devtools/browser/)[A-Za-z0-9_-]+#\1[redacted]#g' \
          -e 's/(Sec-WebSocket-Key: )[A-Za-z0-9+/=]+/\1[redacted]/Ig' \
        | while IFS= read -r line; do log cdp.websocket.strace.line "${line:0:360}"; done || true
      rm -f -- "$websocket_strace_log" "$websocket_strace_error"
    fi
    websocket_client_trace_files=("$websocket_client_trace_prefix".*)
    if [[ -e "${websocket_client_trace_files[0]}" ]]; then
      websocket_client_trace_count=0
      websocket_client_connect_count=0
      for trace_file in "${websocket_client_trace_files[@]}"; do
        websocket_client_trace_count=$((websocket_client_trace_count + $(wc -l <"$trace_file" | tr -d ' ')))
        websocket_client_connect_count=$((websocket_client_connect_count + $(grep -c 'connect(' "$trace_file" 2>/dev/null || true)))
        grep -E 'socket\(|connect\(|sendto\(|sendmsg\(|recvfrom\(|recvmsg\(' "$trace_file" 2>/dev/null \
          | sed -E -e 's#(/devtools/browser/)[A-Za-z0-9_-]+#\1[redacted]#g' \
            -e 's/(Sec-WebSocket-Key: )[A-Za-z0-9+/=]+/\1[redacted]/Ig' \
          | tail -n 20 | while IFS= read -r line; do log cdp.websocket.client.strace.line "${line:0:360}"; done || true
      done
      log cdp.websocket.client.strace.summary "trace_lines=$websocket_client_trace_count connect_calls=$websocket_client_connect_count"
      rm -f -- "$websocket_client_trace_prefix".*
    fi
    if [[ "$websocket_exit" == 0 && "$websocket_result" == *"result=cdp-result product="* ]]; then websocket_success=1; fi
    log cdp.websocket.probe "exit_code=$websocket_exit result=$(printf '%q' "$websocket_result")"
    fi
  fi
  else
    log cdp.websocket.probe "status=skipped reason=flag-disabled"
  fi
fi

if [[ "$chrome_result" == listener-ready ]]; then
  if ((http_success_count > 0)); then chrome_result=http-ready
  elif [[ "$websocket_success" == 1 ]]; then chrome_result=websocket-only-ready
  elif [[ "$http_probes_enabled" == 1 && "$websocket_probes_enabled" == 1 ]]; then chrome_result=listener-no-response
  else chrome_result=listener-probe-incomplete
  fi
fi
log chrome.result "result=$chrome_result port=$cdp_port attempts=$attempt startup_timeout_seconds=$startup_timeout_seconds"
if [[ -s "$diag_dir/chromium.log" ]]; then
  sed -E 's#(DevTools listening on ws://)[^[:space:]]+#\1[redacted]#g' \
    "$diag_dir/chromium.log" >"$diag_dir/chromium.log.redacted"
  mv -- "$diag_dir/chromium.log.redacted" "$diag_dir/chromium.log"
fi
tail -n 30 "$diag_dir/chromium.log" 2>/dev/null | while IFS= read -r line; do log chromium.log.final "$line"; done
if [[ -s "$strace_log" ]]; then
  trace_bytes="$(wc -c <"$strace_log" | tr -d ' ')"
  trace_lines="$(wc -l <"$strace_log" | tr -d ' ')"
  log strace.summary "bytes=$trace_bytes lines=$trace_lines"
  grep -E 'bind\(|listen\(|accept4?\(|connect\(|setns\(|unshare\(' "$strace_log" 2>/dev/null | tail -n 20 \
    | while IFS= read -r line; do log strace.socket "${line:0:360}"; done
  tail -n 8 "$strace_log" | while IFS= read -r line; do log strace.tail "${line:0:360}"; done
fi
if [[ "$trace_startup_enabled" == 1 ]]; then
  trace_elapsed_seconds=$((SECONDS - chrome_started_seconds))
  trace_remaining_seconds=$((startup_timeout_seconds - trace_elapsed_seconds))
  if ((trace_remaining_seconds > 0)); then
    log chrome.trace.wait "elapsed_seconds=$trace_elapsed_seconds remaining_seconds=$trace_remaining_seconds reason=allow-startup-trace-duration-to-finish"
    sleep "$trace_remaining_seconds"
  fi
fi
stop_group "$chrome_group_pid"
chrome_group_pid=
if [[ "$trace_startup_enabled" == 1 ]]; then
  if [[ -s "$trace_file" ]]; then
    trace_bytes="$(wc -c <"$trace_file" | tr -d ' ')"
    log chrome.trace.complete "file=$trace_file bytes=$trace_bytes"
  else
    log chrome.trace.missing "file=$trace_file"
  fi
fi
if ss -lnt 2>/dev/null | awk -v suffix=":$cdp_port" 'NR > 1 && substr($4, length($4) - length(suffix) + 1) == suffix { found=1 } END { exit !found }'; then
  log cleanup.failed "reason=diagnostic-port-remains-open port=$cdp_port"
  exit 4
fi
chrome_result="${chrome_result}-cleaned"
case "$chrome_result" in
  http-ready-cleaned|websocket-only-ready-cleaned)
    ;;
  listener-no-response-cleaned)
    log diagnostic.failed "reason=cdp-http-and-websocket-unresponsive port=$cdp_port attempts=$attempt"
    exit 6
    ;;
  listener-probe-incomplete-cleaned)
    log diagnostic.failed "reason=cdp-readiness-probes-incomplete port=$cdp_port attempts=$attempt http_probes=$http_probes_enabled websocket_probes=$websocket_probes_enabled"
    exit 7
    ;;
  *)
  log diagnostic.failed "reason=cdp-listener-not-ready result=$chrome_result port=$cdp_port attempts=$attempt"
  exit 5
    ;;
esac
