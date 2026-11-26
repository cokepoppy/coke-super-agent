#!/usr/bin/env bash
set -Eeuo pipefail

export DISPLAY="${DISPLAY:-:1}"
export HOME="${HOME:-/workspace/.desktop-home}"
resolution="${COKE_DESKTOP_RESOLUTION:-1280x800}"
start_url="${COKE_DESKTOP_START_URL:-about:blank}"
chrome_bin="${COKE_DESKTOP_CHROME_BIN:-}"
chrome_launcher_selection=explicit
if [[ "$chrome_bin" == "/usr/lib/chromium/chromium" && -x "$chrome_bin" ]]; then
  chrome_launcher_selection=debian-direct-elf
elif [[ "${CSA_DESKTOP_USE_CHROMIUM_WRAPPER:-0}" != "1" ]] \
  && [[ -x /usr/lib/chromium/chromium ]] \
  && { [[ -z "$chrome_bin" ]] || [[ "$chrome_bin" == "/usr/bin/chromium" ]]; }; then
  chrome_bin=/usr/lib/chromium/chromium
  chrome_launcher_selection=debian-direct-elf
else
  chrome_bin="${chrome_bin:-/usr/bin/chromium}"
fi
profile_dir="$HOME/.config/chromium"
session_log="${COKE_DESKTOP_SESSION_LOG:-/tmp/csa-desktop-session.log}"
chrome_log=/tmp/csa-chromium.log
chrome_bridge="${CSA_CHROME_CDP_PIPE_BRIDGE_PATH:-/opt/csa-agent-runtime/chrome-cdp-pipe-bridge.cjs}"
chrome_bridge_node=/usr/bin/node
chrome_debug_transport=legacy-http
if [[ -s "$chrome_bridge" && -x "$chrome_bridge_node" ]]; then chrome_debug_transport=pipe-http-bridge; fi
chrome_launcher_override_log=""
if [[ "$chrome_debug_transport" == pipe-http-bridge && -x /opt/google/chrome/chrome ]]; then
  chrome_wrapper_realpath="$(readlink -f "$chrome_bin" 2>/dev/null || true)"
  if [[ "$chrome_wrapper_realpath" == /opt/google/chrome/google-chrome ]]; then
    chrome_bin=/opt/google/chrome/chrome
    chrome_launcher_selection=google-chrome-direct-elf-pipe
    chrome_launcher_override_log="chrome.launcher.override reason=pipe-transport-direct-elf wrapper=/opt/google/chrome/google-chrome executable=$chrome_bin"
  fi
fi
session_id="${CSA_CUBE_SANDBOX_ID:-unknown}-${CSA_COMPUTER_GENERATION:-unknown}-$$"
ready_file=/run/csa-desktop/session.ready
browser_status_file=/run/csa-desktop/browser.status
browser_retry_file=/run/csa-desktop/browser.retry

log_event() {
  local level="$1"
  shift
  local record
  printf -v record '%s level=%s tenant_id=%s sandbox_id=%s generation=%s run_id=%s session_id=%s pid=%s uid=%s event=%s' \
    "$(date -u +%FT%TZ)" "$level" "${CSA_TENANT_ID:-unknown}" "${CSA_CUBE_SANDBOX_ID:-unknown}" "${CSA_COMPUTER_GENERATION:-unknown}" "${CSA_RUN_ID:-none}" "$session_id" "$$" "$(id -u)" "$*"
  if [[ "${COKE_DESKTOP_LOG_STDOUT:-0}" == "1" ]]; then
    printf '%s\n' "$record" | tee -a "$session_log"
  else
    printf '%s\n' "$record" >>"$session_log"
  fi
}

if [[ -n "$chrome_launcher_override_log" ]]; then
  log_event info "$chrome_launcher_override_log"
fi

tail_component_log() {
  local path="$1"
  if [[ -f "$path" ]]; then
    printf 'component_log=%s\n' "$path" >&2
    tail -n 40 "$path" 2>/dev/null | sed -E \
      -e 's/((api[_-]?key|password|token|secret|authorization|cookie)=)[^&[:space:]"'"'"'<>]+/\1[REDACTED]/Ig' \
      -e 's/("(api[_-]?key|password|token|secret|authorization|cookie)"[[:space:]]*:[[:space:]]*")[^"]*"/\1[REDACTED]"/Ig' \
      -e 's/(Bearer[[:space:]]+)[A-Za-z0-9._~+\/=-]+/\1[REDACTED]/Ig' >&2 || true
  fi
}

log_event info "session.begin display=$DISPLAY home=$HOME resolution=$resolution cdp_port=9222 cdp_transport=$chrome_debug_transport websockify_port=6080 log=$session_log"

websockify_listener_timeout_seconds=180

wait_for_xfce() {
  local pid="$1" log_path="$2" timeout_seconds="$3" attempt=0 session_up wm_up process_snapshot process_table
  local desktop_uid started_seconds="$SECONDS" elapsed_seconds=0 next_heartbeat_at=0 process_pid process_state process_comm
  local session_pids wm_pids matching_processes
  desktop_uid="$(id -u)"
  while ((SECONDS - started_seconds < timeout_seconds)); do
    attempt=$((attempt + 1))
    elapsed_seconds=$((SECONDS - started_seconds))
    session_up=0
    wm_up=0
    session_pids=""
    wm_pids=""
    matching_processes=""
    process_table="$(ps -u "$desktop_uid" -o pid=,stat=,comm= 2>/dev/null || true)"
    while read -r process_pid process_state process_comm; do
      case "$process_comm" in
        xfce4-session|xfwm4) matching_processes+="${process_pid}:${process_comm}:${process_state}," ;;
        *) continue ;;
      esac
      case "$process_state" in
        *Z*|*X*) continue ;;
      esac
      if [[ "$process_comm" == xfce4-session ]]; then
        session_pids+="${process_pid} "
        session_up=1
      else
        wm_pids+="${process_pid} "
        wm_up=1
      fi
    done <<<"$process_table"
    if [[ "$session_up" == 1 && "$wm_up" == 1 ]]; then
      log_event info "xfce.ready session_pids=${session_pids// /,} window_manager_pids=${wm_pids// /,} attempt=$attempt live_processes=${matching_processes%,}"
      return 0
    fi
    if ! kill -0 "$pid" 2>/dev/null && [[ "$session_up" != 1 || "$wm_up" != 1 ]]; then
      log_event error "xfce.exited pid=$pid session_pids=${session_pids// /,} window_manager_pids=${wm_pids// /,} attempt=$attempt matching_processes=${matching_processes%,}"
      tail_component_log "$log_path"
      return 1
    fi
    if ((elapsed_seconds >= next_heartbeat_at)); then
      log_event info "xfce.wait attempt=$attempt elapsed_seconds=$elapsed_seconds session_pids=${session_pids// /,} window_manager_pids=${wm_pids// /,} live_processes=${matching_processes%,} diagnostics=deferred_to_timeout_capture"
      next_heartbeat_at=$((elapsed_seconds + 30))
    fi
    sleep 1
  done
  elapsed_seconds=$((SECONDS - started_seconds))
  process_snapshot="$(ps -u "$desktop_uid" -o pid=,ppid=,stat=,wchan=,etime=,comm=,args= 2>/dev/null | awk '/xfce4-session|xfwm4|startxfce4|xinit|xinitrc|xfconf/ { print }' | head -n 12 | tr '\n' ';' || true)"
  log_event error "xfce.ready.timeout timeout_seconds=$timeout_seconds elapsed_seconds=$elapsed_seconds attempts=$attempt session=$session_up window_manager=$wm_up all_session_rows=${process_snapshot:-none}"
  tail_component_log "$log_path"
  return 1
}

wait_for_tcp_listener() {
  local component="$1" pid="$2" port="$3" log_path="$4" timeout_seconds="$5"
  local attempt=0 status socket_snapshot socket_rows ss_snapshot process_snapshot process_command process_status port_hex tcp_probe
  local started_seconds="$SECONDS" elapsed_seconds=0 next_heartbeat_at=0
  port_hex="$(printf '%04X' "$port")"
  while ((SECONDS - started_seconds < timeout_seconds)); do
    attempt=$((attempt + 1))
    elapsed_seconds=$((SECONDS - started_seconds))
    socket_snapshot="$(awk -v port="$port_hex" '$4 == "0A" { split($2, endpoint, ":"); if (toupper(endpoint[2]) == port) print FILENAME ":" $0 }' /proc/net/tcp /proc/net/tcp6 2>/dev/null | tr '\n' ';' || true)"
    if [[ -n "$socket_snapshot" ]]; then
      if [[ "$component" == websockify ]]; then
        log_event info "$component.ready port=$port probe=proc-listener attempt=$attempt"
        tail_component_log "$log_path"
        return 0
      fi
      if timeout --kill-after=1s 3s bash -c 'exec 3<>"/dev/tcp/127.0.0.1/$1"' _ "$port" 2>/dev/null; then
        log_event info "$component.ready port=$port probe=proc-listener-and-tcp-connect attempt=$attempt"
        tail_component_log "$log_path"
        return 0
      fi
      tcp_probe=listener-present-connect-timeout
    else
      tcp_probe=skipped-no-listener
    fi
    if ! kill -0 "$pid" 2>/dev/null; then
      status=unknown
      wait "$pid" 2>/dev/null || status=$?
      log_event error "$component.exited pid=$pid exit_status=$status expected_port=$port"
      tail_component_log "$log_path"
      return 1
    fi
    if ((elapsed_seconds >= next_heartbeat_at)); then
      log_event info "$component.wait attempt=$attempt elapsed_seconds=$elapsed_seconds tcp_probe=$tcp_probe process_pid=$pid process_alive=1 port=$port listeners=${socket_snapshot:-none} diagnostics=deferred_to_timeout_capture"
      next_heartbeat_at=$((elapsed_seconds + 30))
    fi
    sleep 1
  done
  elapsed_seconds=$((SECONDS - started_seconds))
  socket_rows="$(awk -v port="$port_hex" '{ split($2, endpoint, ":"); if (toupper(endpoint[2]) == port) print FILENAME ":" $0 }' /proc/net/tcp /proc/net/tcp6 2>/dev/null | tr '\n' ';' || true)"
  ss_snapshot=unavailable
  if command -v ss >/dev/null 2>&1; then
    ss_snapshot="$(ss -lntp 2>/dev/null | awk -v port=":$port" 'NR == 1 || index($0, port) { print }' | tr '\n' ';' || true)"
  fi
  process_snapshot="$(ps -p "$pid" -o pid=,ppid=,stat=,wchan=,etime=,comm= 2>/dev/null | tr '\n' ';' || true)"
  process_command="$(tr '\0' ' ' <"/proc/$pid/cmdline" 2>/dev/null || true)"
  process_status="$(awk '/^(State|VmRSS|Threads):/ { printf "%s=%s;", $1, $2 }' "/proc/$pid/status" 2>/dev/null || true)"
  log_event error "$component.listener.timeout port=$port probe=tcp-connect timeout_seconds=$timeout_seconds elapsed_seconds=$elapsed_seconds attempts=$attempt listeners=${socket_snapshot:-none} socket_rows=${socket_rows:-none} ss=${ss_snapshot:-none} process=${process_snapshot:-missing} process_status=${process_status:-unknown} process_command=$(printf '%q' "$process_command") diagnostics=single-timeout-snapshot"
  tail_component_log "$log_path"
  return 1
}

run_privileged() {
  if [[ "$(id -u)" == 0 ]]; then
    "$@"
  else
    sudo -n "$@"
  fi
}

system_bus_responds() {
  command -v dbus-send >/dev/null 2>&1 || return 1
  timeout --kill-after=1s 5s dbus-send --system \
    --dest=org.freedesktop.DBus \
    --type=method_call \
    --print-reply \
    /org/freedesktop/DBus \
    org.freedesktop.DBus.ListNames >/dev/null 2>&1
}

system_bus_listener_exists() {
  command -v ss >/dev/null 2>&1 || return 1
  ss -xlpn 2>/dev/null | grep -Fq /run/dbus/system_bus_socket
}

ensure_system_bus() {
  local output status attempt socket_path=/run/dbus/system_bus_socket
  if ! command -v dbus-send >/dev/null 2>&1; then
    log_event error system-dbus.probe-binary.missing
    return 127
  fi
  if system_bus_responds; then
    log_event info "system-dbus.ready socket=$socket_path probe=dbus-list-names source=responsive"
    return 0
  fi

  if [[ -S "$socket_path" ]]; then
    if system_bus_listener_exists; then
      log_event error "system-dbus.unresponsive socket=$socket_path listener=present probe=dbus-list-names"
      return 1
    fi
    log_event warning "system-dbus.socket.stale socket=$socket_path listener=absent action=remove"
    if output="$(run_privileged rm -f -- "$socket_path" 2>&1)"; then
      log_event info "system-dbus.socket.removed path=$socket_path"
    else
      status=$?
      log_event error "system-dbus.socket.remove.failed exit_code=$status output=$(printf '%q' "$output")"
      return "$status"
    fi
  else
    log_event warning "system-dbus.socket.missing path=$socket_path action=start"
  fi

  if ! command -v dbus-daemon >/dev/null 2>&1; then
    log_event error system-dbus.binary.missing
    return 127
  fi
  if [[ "$(id -u)" != 0 ]] && ! command -v sudo >/dev/null 2>&1; then
    log_event error system-dbus.sudo.missing
    return 127
  fi

  if output="$(run_privileged install -d -m 0755 /run/dbus 2>&1)"; then
    log_event info 'system-dbus.directory.ready path=/run/dbus'
  else
    status=$?
    log_event error "system-dbus.directory.failed exit_code=$status output=$(printf '%q' "$output")"
    return "$status"
  fi
  if output="$(run_privileged timeout --kill-after=1s 10s dbus-daemon --system --fork --nopidfile --print-address=1 2>&1)"; then
    log_event info "system-dbus.launch address=$(printf '%q' "$output")"
  else
    status=$?
    log_event error "system-dbus.launch.failed exit_code=$status output=$(printf '%q' "$output")"
    return "$status"
  fi

  for attempt in $(seq 1 25); do
    if system_bus_responds; then
      log_event info "system-dbus.ready socket=$socket_path probe=dbus-list-names attempt=$attempt"
      return 0
    fi
    sleep 0.2
  done

  log_event error "system-dbus.failed reason=system-bus-method-call-unresponsive socket_exists=$([[ -S "$socket_path" ]] && printf 1 || printf 0)"
  return 1
}

chrome_cdp_startup_timeout_seconds="${CSA_DESKTOP_CHROME_CDP_TIMEOUT_SECONDS:-360}"
if [[ ! "$chrome_cdp_startup_timeout_seconds" =~ ^[0-9]{1,4}$ ]] \
  || ((chrome_cdp_startup_timeout_seconds < 30 || chrome_cdp_startup_timeout_seconds > 3600)); then
  log_event error "chrome.cdp.timeout.invalid configured=${chrome_cdp_startup_timeout_seconds} expected=30..3600"
  exit 2
fi
default_pipe_startup_timeout_ms=$((chrome_cdp_startup_timeout_seconds * 1000 - 30000))
if ((default_pipe_startup_timeout_ms < 30000)); then default_pipe_startup_timeout_ms=30000; fi
chrome_pipe_startup_timeout_ms="${CSA_CHROME_PIPE_STARTUP_COMMAND_TIMEOUT_MS:-$default_pipe_startup_timeout_ms}"
if [[ ! "$chrome_pipe_startup_timeout_ms" =~ ^[0-9]{1,7}$ ]] \
  || ((chrome_pipe_startup_timeout_ms < 30000 || chrome_pipe_startup_timeout_ms > 3600000)); then
  log_event error "chrome.cdp.pipe-timeout.invalid configured=${chrome_pipe_startup_timeout_ms} expected=30000..3600000"
  exit 2
fi

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

read_process_cpu_ticks() {
  local pid="$1" stat_line
  local -a stat_fields=()
  [[ -r "/proc/$pid/stat" ]] || return 1
  IFS= read -r stat_line <"/proc/$pid/stat" || return 1
  stat_line="${stat_line##*) }"
  read -r -a stat_fields <<<"$stat_line"
  [[ "${stat_fields[11]:-}" =~ ^[0-9]+$ && "${stat_fields[12]:-}" =~ ^[0-9]+$ ]] || return 1
  printf '%s %s %s\n' "${stat_fields[0]:-unknown}" "${stat_fields[11]}" "${stat_fields[12]}"
}

sample_process_descendants() {
  local root_pid="$1" rows='' executable_rows='' process_id parent_id state wchan pcpu pmem elapsed cpu_time comm exe
  rows="$(ps -eo pid=,ppid=,stat=,wchan:20,pcpu=,pmem=,etime=,time=,comm= 2>/dev/null | awk -v root="$root_pid" '
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
      emitted = 0
      for (i = 1; i <= NR; i++) {
        if (!descendant[process_id[i]]) continue
        printf "%s;", rows[i]
        emitted++
        if (emitted >= 48) { printf "truncated=1;"; break }
      }
    }
  ' | cut -c1-3600)"
  [[ -n "$rows" ]] || return 1
  while read -r process_id parent_id state wchan pcpu pmem elapsed cpu_time comm; do
    case "$comm" in
      chrome*|dbus-run-*)
        exe="$(readlink "/proc/$process_id/exe" 2>/dev/null || true)"
        executable_rows+="${executable_rows:+;}${process_id}{comm=${comm},exe=${exe:-unavailable}}"
        ;;
    esac
  done <<<"$(printf '%s' "$rows" | tr ';' '\n')"
  printf 'rows=%s;executables=%s\n' "${rows//$'\n'/;}" "${executable_rows:-none}" | cut -c1-5200
}

find_chrome_main_pid() {
  local root_pid="$1" candidates candidate_pid candidate_comm command_line executable
  candidates="$(ps -eo pid=,ppid=,comm= 2>/dev/null | awk -v root="$root_pid" '
    { process_ids[NR] = $1; parent_ids[NR] = $2; process_names[NR] = $3 }
    BEGIN { descendant[root] = 1 }
    END {
      for (pass = 0; pass < 32; pass++) {
        changed = 0
        for (i = 1; i <= NR; i++) {
          if (descendant[parent_ids[i]] && !descendant[process_ids[i]]) {
            descendant[process_ids[i]] = 1
            changed = 1
          }
        }
        if (!changed) break
      }
      for (i = 1; i <= NR; i++) {
        if (descendant[process_ids[i]]) print process_ids[i], process_names[i]
      }
    }
  ')"
  while read -r candidate_pid candidate_comm; do
    [[ "$candidate_pid" =~ ^[0-9]+$ ]] || continue
    case "$candidate_comm" in chrome|chromium|chromium-browser|google-chrome*) ;; *) continue ;; esac
    command_line="$(tr '\0' ' ' <"/proc/$candidate_pid/cmdline" 2>/dev/null || true)"
    case "$command_line" in *--type=*) continue ;; esac
    executable="$(readlink "/proc/$candidate_pid/exe" 2>/dev/null || true)"
    case "$executable" in */chrome|*/chromium) printf '%s\n' "$candidate_pid"; return 0 ;; esac
  done <<<"$candidates"
  return 1
}

wait_for_http_service() {
  local component="$1" pid="$2" url="$3" log_path="$4" timeout_seconds="$5"
  local attempt=0 status http_result process_tree started_seconds="$SECONDS" elapsed_seconds=0 next_heartbeat_at=90
  local started_uptime_cs=0 uptime_now_cs=0 deadline_uptime_cs=0 curl_started_cs=0 curl_finished_cs=0 curl_duration_cs=0 bash_elapsed_seconds=0
  local chrome_cpu_sample= chrome_main_pid= chrome_diagnostic_pid=
  local chrome_start_state=unknown chrome_start_utime_ticks=unknown chrome_start_stime_ticks=unknown
  if ! read_monotonic_centiseconds started_uptime_cs; then
    log_event error "$component.clock.failed source=/proc/uptime point=start"
    return 1
  fi
  if [[ "$component" == chrome-cdp ]]; then
    chrome_main_pid="$(find_chrome_main_pid "$pid" 2>/dev/null || true)"
    if [[ -n "$chrome_main_pid" ]]; then
      chrome_diagnostic_pid="$chrome_main_pid"
      log_event info "$component.main-process.resolved root_pid=$pid chrome_pid=$chrome_main_pid executable=$(readlink "/proc/$chrome_main_pid/exe" 2>/dev/null || printf unknown)"
      chrome_cpu_sample="$(read_process_cpu_ticks "$chrome_main_pid" 2>/dev/null || true)"
      if [[ -n "$chrome_cpu_sample" ]]; then
        read -r chrome_start_state chrome_start_utime_ticks chrome_start_stime_ticks <<<"$chrome_cpu_sample" || true
      fi
    else
      log_event info "$component.main-process.await root_pid=$pid search=launch-descendants retry=each-cdp-probe"
    fi
    chrome_start_state="${chrome_start_state:-unknown}"
    chrome_start_utime_ticks="${chrome_start_utime_ticks:-unknown}"
    chrome_start_stime_ticks="${chrome_start_stime_ticks:-unknown}"
  fi
  deadline_uptime_cs=$((started_uptime_cs + timeout_seconds * 100))
  log_event info "$component.wait.start timeout_seconds=$timeout_seconds bash_started_seconds=$started_seconds guest_uptime_centiseconds=$started_uptime_cs url=$url process_root_pid=$pid chrome_main_pid=${chrome_main_pid:-pending} baseline_state=${chrome_start_state:-unknown} baseline_utime_ticks=${chrome_start_utime_ticks:-unknown} baseline_stime_ticks=${chrome_start_stime_ticks:-unknown}"
  while :; do
    if ! read_monotonic_centiseconds uptime_now_cs; then
      log_event error "$component.clock.failed source=/proc/uptime point=loop attempt=$attempt"
      return 1
    fi
    ((uptime_now_cs < deadline_uptime_cs)) || break
    attempt=$((attempt + 1))
    elapsed_seconds=$(((uptime_now_cs - started_uptime_cs) / 100))
    if [[ "$component" == chrome-cdp && -z "$chrome_main_pid" ]]; then
      chrome_main_pid="$(find_chrome_main_pid "$pid" 2>/dev/null || true)"
      if [[ -n "$chrome_main_pid" ]]; then
        chrome_diagnostic_pid="$chrome_main_pid"
        chrome_cpu_sample="$(read_process_cpu_ticks "$chrome_main_pid" 2>/dev/null || true)"
        if [[ -n "$chrome_cpu_sample" ]]; then
          read -r chrome_start_state chrome_start_utime_ticks chrome_start_stime_ticks <<<"$chrome_cpu_sample" || true
        fi
        chrome_start_state="${chrome_start_state:-unknown}"
        chrome_start_utime_ticks="${chrome_start_utime_ticks:-unknown}"
        chrome_start_stime_ticks="${chrome_start_stime_ticks:-unknown}"
        log_event info "$component.main-process.resolved root_pid=$pid chrome_pid=$chrome_main_pid executable=$(readlink "/proc/$chrome_main_pid/exe" 2>/dev/null || printf unknown) elapsed_seconds=$elapsed_seconds baseline=discovery-time"
      fi
    fi
    http_result=""
    curl_started_cs=$uptime_now_cs
    if http_result="$(curl --noproxy '*' --connect-timeout 2 --max-time 5 -fsS -o /dev/null -w 'http_code=%{http_code} total_seconds=%{time_total}' "$url" 2>&1)"; then
      log_event info "$component.ready attempt=$attempt url=$url response=$(printf '%q' "$http_result")"
      return 0
    else
      status=$?
    fi
    read_monotonic_centiseconds curl_finished_cs || curl_finished_cs=$curl_started_cs
    curl_duration_cs=$((curl_finished_cs - curl_started_cs))
    elapsed_seconds=$(((curl_finished_cs - started_uptime_cs) / 100))
    bash_elapsed_seconds=$((SECONDS - started_seconds))
    if ((attempt <= 3 || attempt % 30 == 0 || curl_duration_cs >= 200)); then
      log_event info "$component.probe attempt=$attempt guest_elapsed_seconds=$elapsed_seconds guest_elapsed_centiseconds=$((curl_finished_cs - started_uptime_cs)) curl_duration_ms=$((curl_duration_cs * 10)) bash_elapsed_seconds=$bash_elapsed_seconds curl_status=$status url=$url response=$(printf '%q' "$http_result")"
    fi
    if [[ "$pid" -gt 1 ]] && ! kill -0 "$pid" 2>/dev/null; then
      log_event error "$component.exited pid=$pid curl_status=$status url=$url"
      return 1
    fi
    if ((elapsed_seconds >= next_heartbeat_at)); then
      if [[ "$component" == chrome-cdp ]]; then
        process_tree="$(sample_process_descendants "$pid" 2>/dev/null || true)"
        log_event info "$component.process.sample attempt=$attempt elapsed_seconds=$elapsed_seconds root_pid=$pid tree=$(printf '%q' "${process_tree:-unavailable}")"
      fi
      log_event info "$component.wait attempt=$attempt elapsed_seconds=$elapsed_seconds bash_elapsed_seconds=$bash_elapsed_seconds curl_status=$status url=$url response=$(printf '%q' "$http_result") process_root_pid=$pid chrome_main_pid=${chrome_main_pid:-pending} process_alive=1 diagnostics=deferred_to_host_failure_capture log_file=$log_path"
      next_heartbeat_at=$((elapsed_seconds + 90))
    fi
    sleep 1
  done
  read_monotonic_centiseconds uptime_now_cs || uptime_now_cs=$deadline_uptime_cs
  elapsed_seconds=$(((uptime_now_cs - started_uptime_cs) / 100))
  bash_elapsed_seconds=$((SECONDS - started_seconds))
  log_event error "$component.ready.timeout url=$url timeout_seconds=$timeout_seconds elapsed_seconds=$elapsed_seconds guest_elapsed_centiseconds=$((uptime_now_cs - started_uptime_cs)) bash_elapsed_seconds=$bash_elapsed_seconds bash_started_seconds=$started_seconds guest_uptime_seconds=$((uptime_now_cs / 100)) guest_uptime_centiseconds=$uptime_now_cs attempts=$attempt last_curl_status=${status:-unknown} response=$(printf '%q' "${http_result:-none}") diagnostics=deferred_to_host_failure_capture log_file=$log_path session_log=$session_log"
  if [[ "$component" == chrome-cdp ]]; then
    if [[ -z "$chrome_main_pid" ]]; then chrome_main_pid="$(find_chrome_main_pid "$pid" 2>/dev/null || true)"; fi
    chrome_diagnostic_pid="${chrome_main_pid:-$pid}"
    if [[ -z "$chrome_main_pid" ]]; then log_event warning "$component.main-process.unresolved root_pid=$pid snapshot_pid=$chrome_diagnostic_pid elapsed_seconds=$elapsed_seconds"; fi
    capture_chrome_failure_state "$pid" "$chrome_start_state" "$chrome_start_utime_ticks" "$chrome_start_stime_ticks" "$chrome_diagnostic_pid"
  fi
  return 1
}

capture_chrome_failure_state() {
  local root_pid="$1" start_state="${2:-unknown}" start_utime_ticks="${3:-unknown}" start_stime_ticks="${4:-unknown}" pid="${5:-$1}"
  local comm= exe= main_wchan= main_syscall= process_io= cgroup_memory= cgroup_cpu= socket_rows= thread_rows= cpu_sample= current_state=unknown current_utime_ticks=unknown current_stime_ticks=unknown
  local utime_delta=unknown stime_delta=unknown
  local thread_dir thread_comm thread_state thread_wchan status_line thread_count=0 truncated=0 process_tree
  local profile_path profile_status profile_writable profile_summary=''
  [[ "$pid" =~ ^[0-9]+$ ]] || return 0
  cpu_sample="$(read_process_cpu_ticks "$pid" 2>/dev/null || true)"
  if [[ -n "$cpu_sample" ]]; then
    read -r current_state current_utime_ticks current_stime_ticks <<<"$cpu_sample" || true
  fi
  current_state="${current_state:-unknown}"
  current_utime_ticks="${current_utime_ticks:-unknown}"
  current_stime_ticks="${current_stime_ticks:-unknown}"
  if [[ "$start_utime_ticks" =~ ^[0-9]+$ && "$current_utime_ticks" =~ ^[0-9]+$ ]]; then
    utime_delta=$((current_utime_ticks - start_utime_ticks))
  fi
  if [[ "$start_stime_ticks" =~ ^[0-9]+$ && "$current_stime_ticks" =~ ^[0-9]+$ ]]; then
    stime_delta=$((current_stime_ticks - start_stime_ticks))
  fi
  [[ -r "/proc/$pid/comm" ]] && IFS= read -r comm <"/proc/$pid/comm" || true
  exe="$(readlink "/proc/$pid/exe" 2>/dev/null || true)"
  [[ -r "/proc/$pid/wchan" ]] && IFS= read -r main_wchan <"/proc/$pid/wchan" || true
  main_syscall="$(cat "/proc/$pid/task/$pid/syscall" 2>&1 || true)"
  process_io="$(awk '/^(rchar|wchar|syscr|syscw|read_bytes|write_bytes):/ { printf "%s=%s;", $1, $2 }' "/proc/$pid/io" 2>/dev/null || true)"
  if [[ -r /sys/fs/cgroup/memory.current ]]; then
    cgroup_memory="current=$(cat /sys/fs/cgroup/memory.current 2>/dev/null || printf unknown),max=$(cat /sys/fs/cgroup/memory.max 2>/dev/null || printf unknown),events=$(awk '$1 ~ /^(oom|oom_kill|high|max)$/ { printf "%s=%s;", $1, $2 }' /sys/fs/cgroup/memory.events 2>/dev/null || true)"
  fi
  if [[ -r /sys/fs/cgroup/cpu.stat ]]; then
    cgroup_cpu="$(awk '$1 ~ /^(usage_usec|user_usec|system_usec|nr_throttled|throttled_usec)$/ { printf "%s=%s;", $1, $2 }' /sys/fs/cgroup/cpu.stat 2>/dev/null || true)"
  fi
  process_summary="$(awk -F: '/^(State|VmRSS|VmSize|Threads|voluntary_ctxt_switches|nonvoluntary_ctxt_switches):/ { gsub(/^[ \t]+/, "", $2); printf "%s=%s;", $1, $2 }' "/proc/$pid/status" 2>/dev/null || true)"
  socket_rows="$(awk '$2 ~ /:2406$/ { print FILENAME ":" $0 }' /proc/net/tcp /proc/net/tcp6 2>/dev/null | tr '\n' ';' || true)"
  process_tree="$(sample_process_descendants "$root_pid" 2>/dev/null || true)"
  for thread_dir in "/proc/$pid"/task/*; do
    [[ -d "$thread_dir" ]] || continue
    if ((thread_count >= 32)); then truncated=1; break; fi
    thread_count=$((thread_count + 1))
    thread_comm=unknown
    thread_state=unknown
    thread_wchan=unknown
    [[ -r "$thread_dir/comm" ]] && IFS= read -r thread_comm <"$thread_dir/comm" || true
    [[ -r "$thread_dir/wchan" ]] && IFS= read -r thread_wchan <"$thread_dir/wchan" || true
    if [[ -r "$thread_dir/status" ]]; then
      while IFS= read -r status_line; do
        case "$status_line" in State:*) thread_state="${status_line#State:}" ;; esac
      done <"$thread_dir/status"
    fi
    thread_rows+="${thread_rows:+,}${thread_comm}:${thread_state}:${thread_wchan}"
  done
  for profile_path in "$HOME" "$HOME/.config" "$profile_dir" "$profile_dir/Default" "$profile_dir/Crashpad" "$profile_dir/Crash Reports"; do
    if [[ -e "$profile_path" || -L "$profile_path" ]]; then
      profile_status="$(stat -c 'uid=%u,gid=%g,mode=%a,type=%F' "$profile_path" 2>/dev/null || printf 'stat=failed')"
      if [[ -w "$profile_path" ]]; then profile_writable=1; else profile_writable=0; fi
      profile_summary+="${profile_summary:+;}${profile_path}{${profile_status},writable=${profile_writable}}"
      log_event warning "chrome.failure.profile.path path=$(printf '%q' "$profile_path") $profile_status writable=$profile_writable"
    else
      profile_summary+="${profile_summary:+;}${profile_path}{missing}"
      log_event warning "chrome.failure.profile.path path=$(printf '%q' "$profile_path") status=missing"
    fi
  done
  log_event warning "chrome.failure.profile uid=$(id -u) home=$HOME user_data_dir=$profile_dir session_bus=${DBUS_SESSION_BUS_ADDRESS:+present} system_bus_socket=$([[ -S /run/dbus/system_bus_socket ]] && printf present || printf missing) paths=$(printf '%q' "$profile_summary")"
  log_event warning "chrome.failure.process-tree root_pid=$root_pid chrome_pid=$pid sample=$(printf '%q' "${process_tree:-unavailable}")"
  log_event warning "chrome.failure.snapshot process_root_pid=$root_pid chrome_pid=$pid alive=$([[ -d "/proc/$pid" ]] && printf 1 || printf 0) comm=${comm:-unknown} exe=${exe:-unknown} main_wchan=${main_wchan:-unknown} main_syscall=$(printf '%q' "${main_syscall:-unknown}") process=${process_summary:-unavailable} process_io=${process_io:-unavailable} cgroup_memory=${cgroup_memory:-unavailable} cgroup_cpu=${cgroup_cpu:-unavailable} main_thread_cpu_start_state=$start_state main_thread_cpu_end_state=${current_state:-unknown} main_thread_utime_ticks_start=$start_utime_ticks main_thread_utime_ticks_end=${current_utime_ticks:-unknown} main_thread_utime_ticks_delta=$utime_delta main_thread_stime_ticks_start=$start_stime_ticks main_thread_stime_ticks_end=${current_stime_ticks:-unknown} main_thread_stime_ticks_delta=$stime_delta sampled_threads=$thread_count thread_sample_truncated=$truncated threads=${thread_rows:-none} cdp_socket_rows=${socket_rows:-none}"
  tail_component_log "$chrome_log"
}

if [[ "$(id -u)" == 0 ]]; then
  log_event error must-run-as-desktop-user
  echo "Run the desktop session as the non-root UID 1000 user." >&2
  exit 1
fi
log_event info "session.entry user=$(id -un) home=$HOME display=$DISPLAY"
cd "$HOME"
install -d -m 0755 /run/csa-desktop
log_event info "session.start user=$(id -un) home=$HOME display=$DISPLAY resolution=$resolution chrome=$chrome_bin user_data_dir=$profile_dir cdp_transport=$chrome_debug_transport cdp_timeout_seconds=$chrome_cdp_startup_timeout_seconds cdp_pipe_command_timeout_ms=$chrome_pipe_startup_timeout_ms bridge_path=$chrome_bridge"
ss_path="$(command -v ss 2>/dev/null || true)"
if [[ -n "$ss_path" ]]; then
  log_event info "session.diagnostics.socket_tool=ss path=$ss_path fallback=proc-net-tcp tcp_probe=bash-dev-tcp"
elif [[ -r /proc/net/tcp && -r /proc/net/tcp6 ]]; then
  log_event info "session.diagnostics.socket_tool=proc-net-tcp fallback=none tcp_probe=bash-dev-tcp"
else
  log_event warning "session.diagnostics.socket_tool=missing tcp_probe=bash-dev-tcp"
fi

exec 9>"$HOME/.csa-desktop-session.lock"
if ! flock -n 9; then
  log_event info session.lock.already-held
  echo "A Linux desktop session is already running."
  exit 0
fi
rm -f "$ready_file" "$browser_status_file" "$browser_retry_file"
printf '%s\n' "$$" >/run/csa-desktop/session.pid
log_event info session.lock.acquired

display_number="${DISPLAY#:}"
display_number="${display_number%%.*}"
x_lock="/tmp/.X${display_number}-lock"
x_socket="/tmp/.X11-unix/X${display_number}"

mkdir -p "$profile_dir" "$HOME/.vnc" /workspace/.coke-desktop /tmp/.X11-unix
rm -f "$profile_dir/SingletonLock" "$profile_dir/SingletonCookie" "$profile_dir/SingletonSocket"

xvfb_pid=""
if ! xdpyinfo -display "$DISPLAY" >/dev/null 2>&1; then
  log_event info "display.start display=$DISPLAY"
  if [[ -r "$x_lock" ]]; then
    old_pid="$(tr -cd '0-9' <"$x_lock" || true)"
    if [[ "$old_pid" =~ ^[0-9]+$ ]] && kill -0 "$old_pid" 2>/dev/null; then
      old_command="$(tr '\0' ' ' <"/proc/$old_pid/cmdline" 2>/dev/null || true)"
      if [[ "$old_command" == *"Xvfb $DISPLAY "* ]]; then
        log_event warning "display.stale-lock pid=$old_pid action=terminate"
        kill "$old_pid" 2>/dev/null || true
        for _ in $(seq 1 25); do
          kill -0 "$old_pid" 2>/dev/null || break
          sleep 0.2
        done
      fi
    fi
  fi
  rm -f "$x_lock" "$x_socket"
  Xvfb "$DISPLAY" -screen 0 "${resolution}x24" -nolisten tcp -ac +extension GLX +render -noreset >/tmp/csa-xvfb.log 2>&1 &
  xvfb_pid=$!
  log_event info "display.started pid=$xvfb_pid log=/tmp/csa-xvfb.log"
else
  log_event info "display.reused display=$DISPLAY"
fi

xfce_pid=""; vnc_pid=""; websockify_pid=""; websockify_log_pid=""; chrome_pid=""; chrome_probe_pid=""; dbus_pid=""
process_is_alive() {
  local pid="$1" state
  [[ "$pid" =~ ^[0-9]+$ ]] || return 1
  state="$(ps -p "$pid" -o stat= 2>/dev/null | tr -d '[:space:]' || true)"
  [[ -n "$state" && "$state" != *Z* && "$state" != *X* ]]
}

chrome_group_live_members() {
  local pgid="${1:-$chrome_pid}"
  [[ "$pgid" =~ ^[0-9]+$ ]] || return 0
  ps -eo pid=,pgid=,stat= 2>/dev/null \
    | awk -v pgid="$pgid" '$2 == pgid && $3 !~ /Z|X/ { print $1 }'
}

cleanup() {
  local exit_status=$? cleanup_pid attempt pending chrome_members forced_kill=0
  local -a cleanup_pids=()
  trap - EXIT
  log_event info "session.cleanup.start exit_status=$exit_status"
  rm -f "$ready_file" "$browser_status_file" "$browser_retry_file"
  if ((exit_status != 0)); then log_event warning 'desktop.bootstrap.marker.preserved reason=installed-packages-marker is root-owned and remains valid after a session startup failure'; fi
  [[ -z "$xvfb_pid" ]] || kill "$xvfb_pid" 2>/dev/null || true
  [[ -z "$xfce_pid" ]] || kill "$xfce_pid" 2>/dev/null || true
  [[ -z "$vnc_pid" ]] || kill "$vnc_pid" 2>/dev/null || true
  [[ -z "$websockify_log_pid" ]] || kill "$websockify_log_pid" 2>/dev/null || true
  [[ -z "$websockify_pid" ]] || kill "$websockify_pid" 2>/dev/null || true
  [[ -z "$chrome_probe_pid" ]] || kill "$chrome_probe_pid" 2>/dev/null || true
  [[ -z "$chrome_pid" ]] || kill -- "-$chrome_pid" 2>/dev/null || kill "$chrome_pid" 2>/dev/null || true
  [[ -z "$dbus_pid" ]] || kill "$dbus_pid" 2>/dev/null || true

  for cleanup_pid in "$xvfb_pid" "$xfce_pid" "$vnc_pid" "$websockify_log_pid" "$websockify_pid" "$chrome_probe_pid" "$chrome_pid" "$dbus_pid"; do
    [[ "$cleanup_pid" =~ ^[0-9]+$ ]] && cleanup_pids+=("$cleanup_pid")
  done

  pending=""
  for attempt in $(seq 1 30); do
    pending=""
    for cleanup_pid in "${cleanup_pids[@]}"; do
      process_is_alive "$cleanup_pid" && pending+="${pending:+,}$cleanup_pid"
    done
    chrome_members="$(chrome_group_live_members | tr '\n' ',')"
    [[ -z "$chrome_members" ]] || pending+="${pending:+,}chrome-group:${chrome_members%,}"
    [[ -n "$pending" ]] || break
    sleep 0.2
  done

  if [[ -n "$pending" ]]; then
    forced_kill=1
    log_event warning "session.cleanup.kill pending=$pending action=SIGKILL"
    for cleanup_pid in "${cleanup_pids[@]}"; do
      process_is_alive "$cleanup_pid" && kill -KILL "$cleanup_pid" 2>/dev/null || true
    done
    chrome_members="$(chrome_group_live_members)"
    [[ -z "$chrome_members" ]] || kill -KILL -- "-$chrome_pid" 2>/dev/null || true
    for attempt in $(seq 1 10); do
      pending=""
      for cleanup_pid in "${cleanup_pids[@]}"; do
        process_is_alive "$cleanup_pid" && pending+="${pending:+,}$cleanup_pid"
      done
      chrome_members="$(chrome_group_live_members | tr '\n' ',')"
      [[ -z "$chrome_members" ]] || pending+="${pending:+,}chrome-group:${chrome_members%,}"
      [[ -n "$pending" ]] || break
      sleep 0.2
    done
  fi

  pending=""
  for cleanup_pid in "${cleanup_pids[@]}"; do
    if process_is_alive "$cleanup_pid"; then
      pending+="${pending:+,}$cleanup_pid"
    else
      wait "$cleanup_pid" 2>/dev/null || true
    fi
  done
  chrome_members="$(chrome_group_live_members | tr '\n' ',')"
  [[ -z "$chrome_members" ]] || pending+="${pending:+,}chrome-group:${chrome_members%,}"
  if [[ -n "$pending" ]]; then
    log_event error "session.cleanup.deadline pending=$pending forced_kill=$forced_kill"
  fi
  log_event info "session.cleanup.complete exit_status=$exit_status forced_kill=$forced_kill pending=${pending:-none}"
  return "$exit_status"
}
trap cleanup EXIT
trap 'log_event warning session.signal.INT; exit 0' INT
trap 'log_event warning session.signal.TERM; exit 0' TERM

display_ready=0
for attempt in $(seq 1 50); do
  if xdpyinfo -display "$DISPLAY" >/dev/null 2>&1; then
    display_ready=1
    break
  fi
  if ((attempt % 10 == 0)); then log_event info "display.wait attempt=$attempt"; fi
  sleep 0.2
done
if [[ "$display_ready" != 1 ]]; then
  log_event error "display.failed display=$DISPLAY log=/tmp/csa-xvfb.log"
  tail -n 30 /tmp/csa-xvfb.log >&2 2>/dev/null || true
  exit 1
fi
log_event info "display.ready display=$DISPLAY"
ensure_system_bus

# Start the VNC transport before XFCE competes for guest CPU.
x11vnc -display "$DISPLAY" -nopw -localhost -no6 -rfbport 5900 -forever -shared >/tmp/csa-vnc.log 2>&1 &
vnc_pid=$!
log_event info "vnc.started pid=$vnc_pid log=/tmp/csa-vnc.log"
wait_for_tcp_listener vnc "$vnc_pid" 5900 /tmp/csa-vnc.log 120

websockify_path="$(command -v websockify || true)"
if [[ -z "$websockify_path" ]]; then
  log_event error websockify.binary.missing
  exit 127
fi
log_event info "websockify.launch binary=$websockify_path"
websockify_shebang="$(head -n 1 "$websockify_path" 2>/dev/null || true)"
log_event info "websockify.launch.inspect path=$websockify_path shebang=$(printf '%q' "$websockify_shebang") listener_timeout_seconds=$websockify_listener_timeout_seconds"
: >/tmp/csa-websockify.log
PYTHONUNBUFFERED=1 "$websockify_path" 6080 localhost:5900 >/tmp/csa-websockify.log 2>&1 &
websockify_pid=$!
log_event info "websockify.started pid=$websockify_pid command=${websockify_path}-6080-localhost:5900 log=/tmp/csa-websockify.log"
tail -n +1 -F /tmp/csa-websockify.log &
websockify_log_pid=$!
log_event info "websockify.listener.wait timeout_seconds=$websockify_listener_timeout_seconds diagnostic_probe_only=${CSA_DESKTOP_PROBE_ONLY:-0}"
wait_for_tcp_listener websockify "$websockify_pid" 6080 /tmp/csa-websockify.log "$websockify_listener_timeout_seconds"

if [[ "${CSA_DESKTOP_FONT_CACHE_PREWARM:-0}" == "1" ]]; then
  font_cache_log=/tmp/csa-fontconfig-prewarm.log
  font_cache_started=$SECONDS
  log_event info "fontconfig.cache.prewarm.start uid=$(id -u) cache_dir=$HOME/.cache/fontconfig timeout_seconds=300"
  if timeout --signal=TERM --kill-after=2s 300s fc-cache -f -v >"$font_cache_log" 2>&1; then
    font_cache_bytes="$(du -sk "$HOME/.cache/fontconfig" 2>/dev/null | awk '{print $1 * 1024}' || echo 0)"
    log_event info "fontconfig.cache.prewarm.complete elapsed_seconds=$((SECONDS - font_cache_started)) cache_bytes=$font_cache_bytes output_tail=$(tail -n 4 "$font_cache_log" | tr '\n' ';' | cut -c1-400)"
  else
    font_cache_status=$?
    log_event warning "fontconfig.cache.prewarm.failed exit_code=$font_cache_status elapsed_seconds=$((SECONDS - font_cache_started)) output_tail=$(tail -n 4 "$font_cache_log" 2>/dev/null | tr '\n' ';' | cut -c1-400)"
  fi
fi

dbus-run-session -- xfce4-session >/tmp/csa-xfce.log 2>&1 &
xfce_pid=$!
log_event info "xfce.started pid=$xfce_pid display=$DISPLAY session_bus=dbus-run-session command=xfce4-session log=/tmp/csa-xfce.log"
wait_for_xfce "$xfce_pid" /tmp/csa-xfce.log 120

chrome_flags=(
  --disable-dev-shm-usage --disable-gpu --no-first-run --no-default-browser-check
  --password-store=basic
  --user-data-dir="$profile_dir" --start-maximized
)
if [[ "$chrome_debug_transport" == legacy-http ]]; then
  chrome_flags+=(--remote-debugging-address=127.0.0.1 --remote-debugging-port=9222)
fi
if [[ "${CSA_DESKTOP_CHROME_TRACE_STARTUP:-0}" == "1" ]]; then
  chrome_trace_file=/tmp/csa-chromium-startup-trace.json
  rm -f -- "$chrome_trace_file"
  chrome_flags+=(
    '--trace-startup=-*,toplevel,disabled-by-default-sequence_manager'
    "--trace-startup-file=$chrome_trace_file"
    --trace-startup-duration=240
  )
  log_event info "chrome.trace.startup enabled=1 file=$chrome_trace_file duration_seconds=240 categories=toplevel,disabled-by-default-sequence_manager"
fi
if [[ "${COKE_DESKTOP_CHROME_NO_SANDBOX:-1}" == "1" ]]; then chrome_flags+=(--no-sandbox); fi
chrome_realpath="$(readlink -f "$chrome_bin" 2>/dev/null || true)"
log_event info "chrome.launcher.inspect path=$chrome_bin realpath=${chrome_realpath:-unknown} selection=$chrome_launcher_selection wrapper_override=${CSA_DESKTOP_USE_CHROMIUM_WRAPPER:-0}"
if [[ -r "$chrome_bin" ]] && head -c 2 "$chrome_bin" | grep -q '^#!'; then
  launcher_line=0
  while IFS= read -r launcher_source_line; do
    launcher_line=$((launcher_line + 1))
    printf 'chrome_launcher_source line=%s text=%s\n' "$launcher_line" "$launcher_source_line"
  done < <(sed -n '1,20p' "$chrome_bin")
fi
start_chrome() {
  rm -f "$profile_dir/SingletonLock" "$profile_dir/SingletonCookie" "$profile_dir/SingletonSocket"
  if [[ -s "$chrome_log" ]]; then mv -f -- "$chrome_log" "$chrome_log.previous"; fi
  : >"$chrome_log"
  log_event info "chrome.log.reset path=$chrome_log reason=fresh-startup-attempt"
  log_event info "chrome.session-bus.launch command=dbus-run-session"
  if [[ "$chrome_debug_transport" == pipe-http-bridge ]]; then
    setsid env CSA_CHROME_PIPE_STARTUP_COMMAND_TIMEOUT_MS="$chrome_pipe_startup_timeout_ms" \
      dbus-run-session -- "$chrome_bridge_node" "$chrome_bridge" -- "$chrome_bin" "${chrome_flags[@]}" "$start_url" >>"$chrome_log" 2>&1 &
  else
    setsid dbus-run-session -- "$chrome_bin" "${chrome_flags[@]}" "$start_url" >>"$chrome_log" 2>&1 &
  fi
  chrome_pid=$!
  log_event info "chrome.started pid=$chrome_pid cdp_port=9222 cdp_transport=$chrome_debug_transport log=$chrome_log"
}

stop_chrome() {
  local pid="$1" attempt members forced_kill=0
  [[ "$pid" =~ ^[0-9]+$ ]] || return 1
  log_event info "chrome.stop.start pid=$pid pgid=$pid"
  kill -TERM -- "-$pid" 2>/dev/null || kill -TERM "$pid" 2>/dev/null || true
  for attempt in $(seq 1 30); do
    members="$(chrome_group_live_members "$pid")"
    if ! process_is_alive "$pid" && [[ -z "$members" ]]; then break; fi
    sleep 0.2
  done
  members="$(chrome_group_live_members "$pid")"
  if process_is_alive "$pid" || [[ -n "$members" ]]; then
    forced_kill=1
    log_event warning "chrome.stop.kill pid=$pid group_members=$(printf '%s' "$members" | tr '\n' ',')"
    kill -KILL -- "-$pid" 2>/dev/null || kill -KILL "$pid" 2>/dev/null || true
    for attempt in $(seq 1 10); do
      members="$(chrome_group_live_members "$pid")"
      if ! process_is_alive "$pid" && [[ -z "$members" ]]; then break; fi
      sleep 0.2
    done
  fi
  members="$(chrome_group_live_members "$pid")"
  if process_is_alive "$pid" || [[ -n "$members" ]]; then
    log_event error "chrome.stop.deadline pid=$pid group_members=$(printf '%s' "$members" | tr '\n' ',') forced_kill=$forced_kill"
    return 1
  fi
  wait "$pid" 2>/dev/null || true
  log_event info "chrome.stop.complete pid=$pid forced_kill=$forced_kill"
}

printf 'readyAt=%s\npid=%s\ndisplay=%s\nwebsockifyPort=6080\n' \
  "$(date -u +%FT%TZ)" "$$" "$DISPLAY" >"$ready_file.tmp"
mv -f -- "$ready_file.tmp" "$ready_file"
log_event info "services.ready websockify=6080 ready_file=$ready_file novnc_assets=app-hosted"

browser_status=
browser_was_ready=0
browser_restart_attempted=0
browser_probe_failures=0

set_browser_status() {
  local status="$1" level=info
  [[ "$status" != "$browser_status" ]] || return 0
  browser_status="$status"
  if ! { printf '%s\n' "$status" >"$browser_status_file.tmp" && mv -f -- "$browser_status_file.tmp" "$browser_status_file"; }; then
    log_event warning "browser.status.write.failed status=$status"
  fi
  [[ "$status" != failed ]] || level=error
  log_event "$level" "browser.status.$status pid=${chrome_pid:-none} cdp_port=9222"
}

launch_chrome_with_probe() {
  browser_probe_failures=0
  start_chrome
  set_browser_status starting
  (
    trap - EXIT INT TERM
    wait_for_http_service chrome-cdp "$chrome_pid" http://127.0.0.1:9222/json/version "$chrome_log" "$chrome_cdp_startup_timeout_seconds"
  ) 9>&- &
  chrome_probe_pid=$!
}

launch_chrome_with_probe

while true; do
  for pid in "$xfce_pid" "$vnc_pid" "$websockify_pid"; do
    if ! process_is_alive "$pid"; then
      component_exit=unknown
      wait "$pid" 2>/dev/null || component_exit=$?
      log_event error "component.exited pid=$pid exit_status=$component_exit"
      echo "desktop component exited (pid=$pid, status=$component_exit)" >&2
      exit 1
    fi
  done
  if ! timeout --kill-after=1s 4s xdpyinfo -display "$DISPLAY" >/dev/null 2>&1; then
    log_event error "display.health.failed display=$DISPLAY action=exit"
    exit 1
  fi
  if [[ -e "$browser_retry_file" ]]; then
    rm -f -- "$browser_retry_file"
    if [[ "$browser_status" == failed ]]; then
      log_event info "browser.retry.start pid=$chrome_pid"
      set_browser_status starting
      if [[ -n "$chrome_probe_pid" ]]; then
        kill "$chrome_probe_pid" 2>/dev/null || true
        wait "$chrome_probe_pid" 2>/dev/null || true
        chrome_probe_pid=
      fi
      if stop_chrome "$chrome_pid"; then
        browser_was_ready=0
        browser_restart_attempted=0
        launch_chrome_with_probe
      else
        log_event error "browser.retry.failed reason=previous-process-did-not-stop pid=$chrome_pid"
        set_browser_status failed
      fi
    fi
  fi
  if [[ -n "$chrome_probe_pid" ]] && ! process_is_alive "$chrome_probe_pid"; then
    if ! wait "$chrome_probe_pid"; then
      log_event error "chrome.startup.failed pid=$chrome_pid cdp_port=9222"
      set_browser_status failed
    fi
    chrome_probe_pid=
  fi
  if [[ -z "$chrome_probe_pid" ]]; then
    if ! process_is_alive "$chrome_pid"; then
      set_browser_status failed
      if ((browser_was_ready && !browser_restart_attempted)); then
        browser_restart_attempted=1
        if stop_chrome "$chrome_pid"; then
          log_event warning "chrome.process.exited action=restart-once pid=$chrome_pid"
          launch_chrome_with_probe
        fi
      fi
    elif curl --noproxy '*' -fsS --connect-timeout 1 --max-time 2 http://127.0.0.1:9222/json/version >/dev/null 2>&1 \
      && { [[ "$browser_status" == ready ]] || curl --noproxy '*' -fsS --connect-timeout 1 --max-time 3 http://127.0.0.1:9222/json/list >/dev/null 2>&1; }; then
      browser_probe_failures=0
      browser_was_ready=1
      set_browser_status ready
    else
      browser_probe_failures=$((browser_probe_failures + 1))
      if ((browser_probe_failures >= 3)); then set_browser_status failed; fi
    fi
  fi
  sleep 5
done
