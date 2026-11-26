#!/usr/bin/env bash
set +e

started_at="$(date -u +%FT%TZ)"
tag="$(date +%s)-$$"
diag_dir="/tmp/csa-chromium-session-diagnostic-$tag"
display=:1
desktop_user="$(getent passwd 1000 | cut -d: -f1)"
desktop_uid="$(id -u "$desktop_user" 2>/dev/null)"
desktop_gid="$(id -g "$desktop_user" 2>/dev/null)"
desktop_home=/workspace/.desktop-home
resolution=1280x800
browser_mode="${CSA_CHROMIUM_SESSION_BROWSER:-wrapper}"
browser_max_attempts="${CSA_CHROMIUM_SESSION_MAX_ATTEMPTS:-4}"
xvfb_pid=
xfce_launcher_pid=
dbus_pid=
xfce_session_pids=
xfce_wm_pids=
wrapper_launcher_pid=
wrapper_process_tree=
direct_elf_launcher_pid=
direct_elf_process_tree=
cft_launcher_pid=
cft_process_tree=
system_dbus_pid=

mkdir -p "$diag_dir"

log() { printf 'chromium.session.diag %s\n' "$*"; }

case "$browser_mode" in
  wrapper|direct_elf|cft|cft_compare|both) ;;
  *)
    log "result status=invalid-browser-mode value=$browser_mode expected=wrapper,direct_elf,cft,cft_compare,both"
    exit 2
    ;;
esac
if [[ ! "$browser_max_attempts" =~ ^[1-9][0-9]{0,2}$ ]] || ((browser_max_attempts > 120)); then
  log "result status=invalid-max-attempts value=$browser_max_attempts expected=1..120"
  exit 2
fi

process_tree_pids() {
  local root="$1" depth pid child queue next_queue count=1
  local -a children=()
  [[ "$root" =~ ^[0-9]+$ ]] || return 0
  local process_ids="$root"
  queue="$root"
  for depth in 1 2; do
    next_queue=
    for pid in $queue; do
      children=()
      if [[ -r "/proc/$pid/task/$pid/children" ]]; then
        IFS=' ' read -r -a children <"/proc/$pid/task/$pid/children" 2>/dev/null || true
      fi
      for child in "${children[@]}"; do
        [[ "$child" =~ ^[0-9]+$ ]] || continue
        [[ " $process_ids " == *" $child "* ]] && continue
        process_ids+=" $child"
        next_queue+=" $child"
        count=$((count + 1))
        ((count < 21)) || break 3
      done
    done
    queue="$next_queue"
    [[ -n "$queue" ]] || break
  done
  printf '%s' "$process_ids"
}

stop_profile() {
  local profile="$1" launcher_pid="${2:-}" pids="${3:-}" remaining pid process_state
  if [[ -z "$pids" && "$launcher_pid" =~ ^[0-9]+$ ]]; then pids="$(process_tree_pids "$launcher_pid")"; fi
  if [[ "$launcher_pid" =~ ^[0-9]+$ && " $pids " != *" $launcher_pid "* ]]; then pids="$launcher_pid $pids"; fi
  for pid in $pids; do
    [[ "$pid" =~ ^[0-9]+$ ]] && kill -TERM "$pid" 2>/dev/null || true
  done
  if [[ -n "$pids" ]]; then
    sleep 0.2
    for pid in $pids; do
      [[ "$pid" =~ ^[0-9]+$ ]] || continue
      if kill -0 "$pid" 2>/dev/null; then kill -KILL "$pid" 2>/dev/null || true; fi
    done
    sleep 0.1
  fi
  remaining=
  for pid in $pids; do
    [[ "$pid" =~ ^[0-9]+$ ]] || continue
    if kill -0 "$pid" 2>/dev/null; then
      process_state="$(awk '{ print $3 }' "/proc/$pid/stat" 2>/dev/null || printf unknown)"
      remaining+="${pid}:${process_state},"
    fi
  done
  if [[ "$profile" == "$diag_dir/"* && "$profile" != "$diag_dir" && -z "$remaining" ]]; then
    rm -rf -- "$profile"
  fi
  log "browser.cleanup profile=$profile matched_pids=${pids// /,} remaining_process_states=${remaining%,} profile_removed=$([[ -d "$profile" ]] && printf no || printf yes)"
}

cleanup() {
  stop_profile "$diag_dir/wrapper-profile" "$wrapper_launcher_pid" "$wrapper_process_tree"
  stop_profile "$diag_dir/elf-profile" "$direct_elf_launcher_pid" "$direct_elf_process_tree"
  stop_profile "$diag_dir/cft-profile" "$cft_launcher_pid" "$cft_process_tree"
  stop_profile "$diag_dir/cft-system-bus-profile" "$cft_launcher_pid" "$cft_process_tree"
  stop_profile "$diag_dir/cft-session-bus-profile" "$cft_launcher_pid" "$cft_process_tree"
  local pid
  for pid in $xfce_session_pids $xfce_wm_pids; do
    [[ "$pid" =~ ^[0-9]+$ ]] || continue
    kill -TERM "$pid" 2>/dev/null || true
  done
  if [[ -n "$xfce_launcher_pid" ]] && kill -0 "$xfce_launcher_pid" 2>/dev/null; then
    kill -TERM "$xfce_launcher_pid" 2>/dev/null || true
  fi
  if [[ -n "$dbus_pid" && "$dbus_pid" =~ ^[0-9]+$ && -r "/proc/$dbus_pid/cmdline" ]]; then
    local dbus_command
    dbus_command="$(tr '\0' ' ' <"/proc/$dbus_pid/cmdline" 2>/dev/null)"
    if [[ "$dbus_command" == *dbus-daemon* ]]; then kill -TERM "$dbus_pid" 2>/dev/null || true; fi
  fi
  if [[ -n "$system_dbus_pid" ]] && kill -0 "$system_dbus_pid" 2>/dev/null; then
    kill -TERM "$system_dbus_pid" 2>/dev/null || true
    wait "$system_dbus_pid" 2>/dev/null || true
  fi
  if [[ -n "$xvfb_pid" ]] && kill -0 "$xvfb_pid" 2>/dev/null; then
    kill -TERM "$xvfb_pid" 2>/dev/null || true
    wait "$xvfb_pid" 2>/dev/null || true
  fi
  log "cleanup.complete diagnostic_dir=$diag_dir display=${xvfb_pid:+stopped-by-diagnostic}${xvfb_pid:-reused} dbus_pid=${dbus_pid:-none} system_dbus_pid=${system_dbus_pid:-none}"
}
trap cleanup EXIT

log "start utc=$started_at diagnostic_dir=$diag_dir display=$display user=${desktop_user:-missing} uid=${desktop_uid:-missing} browser_mode=$browser_mode"
if [[ -z "$desktop_user" || ! "$desktop_uid" =~ ^[0-9]+$ ]]; then
  log 'result status=desktop-user-missing'
  exit 0
fi

wrapper=/usr/bin/chromium
elf=/usr/lib/chromium/chromium
cft="${CSA_CHROMIUM_SESSION_CFT_BIN:-/opt/csa-chrome-for-testing-157.0.8103.50/chrome-linux-arm64/chrome}"
for path in "$wrapper" "$elf"; do
  if [[ -x "$path" ]]; then
    stat -c 'chromium.session.diag executable path=%n owner=%U:%G mode=%a bytes=%s' "$path" 2>&1
  else
    log "executable.missing path=$path"
  fi
done
dpkg-query -W -f='chromium.session.diag package name=${binary:Package} version=${Version} status=${db:Status-Abbrev}\n' chromium chromium-common 2>&1
if [[ -r "$wrapper" ]]; then
  nl -ba "$wrapper" | sed -n '1,16p' | sed 's/^/chromium.session.diag wrapper.source /'
fi
if [[ ! -x "$wrapper" || ! -x "$elf" ]]; then
  log 'result status=chromium-binary-missing'
  exit 0
fi
if [[ "$browser_mode" == cft || "$browser_mode" == cft_compare ]]; then
  if [[ -x "$cft" ]]; then
    stat -c 'chromium.session.diag executable path=%n owner=%U:%G mode=%a bytes=%s' "$cft" 2>&1
    "$cft" --version 2>&1 | sed 's/^/chromium.session.diag cft.version /'
  else
    log "result status=cft-binary-missing path=$cft"
    exit 0
  fi
fi

preexisting_xfce="$(pgrep -u "$desktop_uid" -x xfce4-session 2>/dev/null | tr '\n' ' ')"
preexisting_wm="$(pgrep -u "$desktop_uid" -x xfwm4 2>/dev/null | tr '\n' ' ')"
active_session_pids=
stale_session_pids=
for pid in $preexisting_xfce $preexisting_wm; do
  [[ "$pid" =~ ^[0-9]+$ ]] || continue
  comm="$(cat "/proc/$pid/comm" 2>/dev/null)"
  state="$(awk '{ print $3 }' "/proc/$pid/stat" 2>/dev/null)"
  uid="$(awk '/^Uid:/ { print $2; exit }' "/proc/$pid/status" 2>/dev/null)"
  if [[ "$uid" != "$desktop_uid" || ( "$comm" != xfce4-session && "$comm" != xfwm4 ) ]]; then
    active_session_pids+=" $pid:$comm:identity-mismatch"
  elif [[ "$state" == Z || "$state" == X ]]; then
    stale_session_pids+=" $pid:$comm:$state"
  else
    active_session_pids+=" $pid:$comm:$state"
  fi
done
if [[ -n "$active_session_pids" ]]; then
  log "result status=preexisting-xfce-session active_pids=${active_session_pids// /,} stale_pids=${stale_session_pids// /,}"
  exit 0
fi
log "xfce.precheck.clear stale_pids=${stale_session_pids// /,}"

install -d -o "$desktop_user" -g "$desktop_gid" -m 0755 "$desktop_home"
if xdpyinfo -display "$display" >/dev/null 2>&1; then
  log "display.ready display=$display owner=preexisting"
else
  runuser -u "$desktop_user" -- env HOME="$desktop_home" DISPLAY="$display" \
    Xvfb "$display" -screen 0 "${resolution}x24" -nolisten tcp -ac +extension GLX +render -noreset \
    >"$diag_dir/xvfb.log" 2>&1 &
  xvfb_pid=$!
  log "display.started display=$display launcher_pid=$xvfb_pid log=$diag_dir/xvfb.log"
  display_ready=0
  for attempt in $(seq 1 30); do
    if xdpyinfo -display "$display" >/dev/null 2>&1; then
      display_ready=1
      log "display.ready display=$display attempt=$attempt"
      break
    fi
    sleep 0.5
  done
  if [[ "$display_ready" != 1 ]]; then
    log 'result status=xvfb-not-ready'
    tail -n 20 "$diag_dir/xvfb.log" 2>/dev/null | sed 's/^/chromium.session.diag xvfb.log /'
    exit 0
  fi
fi

dbus_output="$(runuser -u "$desktop_user" -- env HOME="$desktop_home" DISPLAY="$display" dbus-launch --sh-syntax 2>"$diag_dir/dbus-launch.log")"
dbus_status=$?
if [[ "$dbus_status" != 0 || -z "$dbus_output" ]]; then
  log "result status=dbus-launch-failed exit_code=$dbus_status"
  tail -n 20 "$diag_dir/dbus-launch.log" 2>/dev/null | sed 's/^/chromium.session.diag dbus.log /'
  exit 0
fi
eval "$dbus_output"
dbus_pid="${DBUS_SESSION_BUS_PID:-}"
log "dbus.ready pid=${dbus_pid:-unknown} address_configured=$([[ -n "${DBUS_SESSION_BUS_ADDRESS:-}" ]] && printf yes || printf no)"

runuser -u "$desktop_user" -- env HOME="$desktop_home" DISPLAY="$display" \
  DBUS_SESSION_BUS_ADDRESS="$DBUS_SESSION_BUS_ADDRESS" startxfce4 \
  >"$diag_dir/xfce.log" 2>&1 &
xfce_launcher_pid=$!
log "xfce.started launcher_pid=$xfce_launcher_pid log=$diag_dir/xfce.log"
xfce_ready=0
for attempt in $(seq 1 60); do
  xfce_process_table="$(ps -u "$desktop_uid" -o pid=,stat=,comm= 2>/dev/null)"
  xfce_session_pids=
  xfce_wm_pids=
  xfce_process_states=
  while read -r process_pid process_state process_comm; do
    case "$process_comm" in
      xfce4-session|xfwm4) xfce_process_states+="${process_pid}:${process_comm}:${process_state}," ;;
      *) continue ;;
    esac
    case "$process_state" in
      *Z*|*X*) continue ;;
    esac
    if [[ "$process_comm" == xfce4-session ]]; then
      xfce_session_pids+="${process_pid} "
    else
      xfce_wm_pids+="${process_pid} "
    fi
  done <<<"$xfce_process_table"
  if [[ -n "$xfce_session_pids" && -n "$xfce_wm_pids" ]]; then
    xfce_ready=1
    log "xfce.ready attempt=$attempt session_pids=${xfce_session_pids// /,} wm_pids=${xfce_wm_pids// /,} live_processes=${xfce_process_states%,}"
    break
  fi
  if ((attempt % 10 == 0)); then
    log "xfce.wait attempt=$attempt session_pids=${xfce_session_pids// /,} wm_pids=${xfce_wm_pids// /,} process_states=${xfce_process_states%,}"
  fi
  sleep 1
done
if [[ "$xfce_ready" != 1 ]]; then
  log "result status=xfce-not-ready launcher_pid=$xfce_launcher_pid"
  tail -n 30 "$diag_dir/xfce.log" 2>/dev/null | sed 's/^/chromium.session.diag xfce.log /'
  exit 0
fi

run_browser_comparison() {
  local name="$1" executable="$2" port="$3" profile="$4" browser_log="$5"
  local launcher_pid started_seconds attempt status=http-pending http_code=none curl_error curl_status
  local profile_processes profile_pids_csv process_rows launcher_state exit_status child_pid child_state live_child max_attempts="$browser_max_attempts"
  install -d -o "$desktop_user" -g "$desktop_gid" -m 0755 "$profile"
  launcher_pid=0
  started_seconds="$SECONDS"
  log "browser.launch.start name=$name executable=$executable port=$port profile=$profile max_attempts=$max_attempts user=$desktop_user display=$display dbus_session=active system_dbus_socket=$([[ -S /run/dbus/system_bus_socket ]] && printf ready || printf absent)"
  runuser -u "$desktop_user" -- env HOME="$desktop_home" DISPLAY="$display" \
    DBUS_SESSION_BUS_ADDRESS="$DBUS_SESSION_BUS_ADDRESS" \
    "$executable" \
    --disable-dev-shm-usage --disable-gpu --no-first-run --no-default-browser-check \
    --password-store=basic --remote-debugging-address=127.0.0.1 \
    --remote-debugging-port="$port" "--user-data-dir=$profile" --start-maximized --no-sandbox about:blank \
    >"$browser_log" 2>&1 &
  launcher_pid=$!
  printf '%s\n' "$launcher_pid" >"$diag_dir/$name-launcher.pid"
  log "browser.launch.complete name=$name launcher_pid=$launcher_pid log=$browser_log"
  if [[ "$name" == wrapper ]]; then
    wrapper_launcher_pid="$launcher_pid"
    wrapper_process_tree="$launcher_pid"
  elif [[ "$name" == direct_elf ]]; then
    direct_elf_launcher_pid="$launcher_pid"
    direct_elf_process_tree="$launcher_pid"
  else
    cft_launcher_pid="$launcher_pid"
    cft_process_tree="$launcher_pid"
  fi

  for attempt in $(seq 1 "$max_attempts"); do
    launcher_state="$(ps -p "$launcher_pid" -o stat= 2>/dev/null | awk 'NR == 1 { print $1 }' || true)"
    if [[ -z "$launcher_state" || "$launcher_state" == Z* ]]; then
      profile_processes="$(process_tree_pids "$launcher_pid")"
      live_child=
      for child_pid in $profile_processes; do
        [[ "$child_pid" == "$launcher_pid" ]] && continue
        child_state="$(ps -p "$child_pid" -o stat= 2>/dev/null | awk 'NR == 1 { print $1 }' || true)"
        if [[ -n "$child_state" && "$child_state" != Z* ]]; then
          live_child="$child_pid"
          break
        fi
      done
      if [[ -z "$live_child" ]]; then
        profile_pids_csv="${profile_processes// /,}"
        wait "$launcher_pid" 2>/dev/null
        exit_status=$?
        status=launcher-exited
        log "browser.exited name=$name attempt=$attempt launcher_pid=$launcher_pid exit_status=$exit_status launcher_state=${launcher_state:-missing} process_tree=$profile_pids_csv"
        break
      fi
    fi

    http_code="$(timeout --kill-after=0.5s 2s curl --noproxy '*' --connect-timeout 0.5 --max-time 1 \
      -sS -o "$diag_dir/$name-cdp-version.json" -w '%{http_code}' \
      "http://127.0.0.1:$port/json/version" 2>"$diag_dir/$name-curl.log")"
    curl_status=$?
    if [[ "$curl_status" == 0 && "$http_code" == 200 ]]; then
      status=ready
      log "browser.cdp.ready name=$name attempt=$attempt elapsed_seconds=$((SECONDS - started_seconds)) port=$port http_code=$http_code"
      break
    fi
    curl_error="$(tr '\n' ' ' <"$diag_dir/$name-curl.log" 2>/dev/null | cut -c1-180)"
    log "browser.cdp.poll name=$name attempt=$attempt elapsed_seconds=$((SECONDS - started_seconds)) http_code=${http_code:-none} curl_exit_code=$curl_status curl_error=${curl_error:-none}"
    if ((attempt == max_attempts)); then
      profile_processes="$(process_tree_pids "$launcher_pid")"
      profile_pids_csv="${profile_processes// /,}"
      launcher_state="$(ps -p "$launcher_pid" -o stat=,wchan=,etime=,comm= 2>/dev/null | tr '\n' ';' || true)"
      if [[ "$profile_pids_csv" =~ ^[0-9,]+$ ]]; then
        process_rows="$(ps -p "$profile_pids_csv" -o pid=,ppid=,stat=,wchan=,etime=,%cpu=,rss=,comm=,args= 2>/dev/null | tr '\n' ';' || true)"
      else
        process_rows=none
      fi
      case "$name" in
        wrapper) wrapper_process_tree="$profile_processes" ;;
        direct_elf) direct_elf_process_tree="$profile_processes" ;;
        cft) cft_process_tree="$profile_processes" ;;
      esac
      log "browser.cdp.wait name=$name attempt=$attempt elapsed_seconds=$((SECONDS - started_seconds)) http_code=${http_code:-none} curl_exit_code=$curl_status curl_error=${curl_error:-none} launcher_pid=$launcher_pid launcher_state=${launcher_state:-missing} profile_pids=${profile_pids_csv:-none} process_rows=${process_rows:-none}"
      tail -n 8 "$browser_log" 2>/dev/null | sed "s/^/chromium.session.diag browser.log name=$name /"
    fi
    if ! kill -0 "$launcher_pid" 2>/dev/null; then
      profile_processes="$(process_tree_pids "$launcher_pid")"
      case "$name" in
        wrapper) wrapper_process_tree="$profile_processes" ;;
        direct_elf) direct_elf_process_tree="$profile_processes" ;;
        cft) cft_process_tree="$profile_processes" ;;
      esac
      if [[ -z "$launcher_state" || "$launcher_state" == Z* ]]; then
        wait "$launcher_pid" 2>/dev/null
        exit_status=$?
        status=launcher-exited
        log "browser.exited name=$name attempt=$attempt launcher_pid=$launcher_pid exit_status=$exit_status process_tree=${profile_processes// /,}"
      else
        status=launcher-pending
        log "browser.wait.skipped name=$name attempt=$attempt launcher_pid=$launcher_pid launcher_state=$launcher_state process_tree=${profile_processes// /,} reason=probe-budget-exhausted"
      fi
      break
    fi
    sleep 1
  done
  if [[ "${status:-http-pending}" != ready ]]; then
    local socket_rows port_hex
    port_hex="$(printf '%04X' "$port")"
    socket_rows="$(awk -v port="$port_hex" '{ split($2, endpoint, ":"); if (toupper(endpoint[2]) == port && $4 == "0A") print FILENAME ":" $0 }' /proc/net/tcp /proc/net/tcp6 2>/dev/null | tr '\n' ';')"
    log "browser.cdp.timeout name=$name elapsed_seconds=$((SECONDS - started_seconds)) port=$port status=${status:-timeout} http_code=${http_code:-none} curl_exit_code=${curl_status:-unknown} listener=${socket_rows:-none} last_curl_error=${curl_error:-none} launcher_pid=$launcher_pid"
  fi
  if [[ "$name" == wrapper ]]; then
    stop_profile "$profile" "$wrapper_launcher_pid" "$wrapper_process_tree"
    wrapper_launcher_pid=
    wrapper_process_tree=
  elif [[ "$name" == direct_elf ]]; then
    stop_profile "$profile" "$direct_elf_launcher_pid" "$direct_elf_process_tree"
    direct_elf_launcher_pid=
    direct_elf_process_tree=
  else
    stop_profile "$profile" "$cft_launcher_pid" "$cft_process_tree"
    cft_launcher_pid=
    cft_process_tree=
  fi
  log "browser.result name=$name status=${status:-timeout} duration_seconds=$((SECONDS - started_seconds)) port=$port"
}

if [[ "$browser_mode" == wrapper || "$browser_mode" == both ]]; then
  run_browser_comparison wrapper "$wrapper" 19222 "$diag_dir/wrapper-profile" "$diag_dir/wrapper.log"
fi
if [[ "$browser_mode" == direct_elf || "$browser_mode" == both ]]; then
  run_browser_comparison direct_elf "$elf" 19223 "$diag_dir/elf-profile" "$diag_dir/direct_elf.log"
fi
if [[ "$browser_mode" == cft ]]; then
  run_browser_comparison cft "$cft" 19224 "$diag_dir/cft-profile" "$diag_dir/cft.log"
fi
if [[ "$browser_mode" == cft_compare ]]; then
  run_browser_comparison cft "$cft" 19224 "$diag_dir/cft-profile" "$diag_dir/cft.log"
  if [[ -S /run/dbus/system_bus_socket ]]; then
    log "system-dbus.compare.skip reason=socket-already-present"
  elif [[ ! -x /usr/bin/dbus-daemon ]]; then
    log "system-dbus.compare.skip reason=dbus-daemon-missing"
  else
    mkdir -p /run/dbus
    chmod 0755 /run/dbus
    /usr/bin/dbus-daemon --system --nofork --nopidfile >"$diag_dir/system-dbus.log" 2>&1 &
    system_dbus_pid=$!
    system_dbus_ready=0
    for attempt in $(seq 1 40); do
      if [[ -S /run/dbus/system_bus_socket ]]; then
        system_dbus_ready=1
        break
      fi
      if ! kill -0 "$system_dbus_pid" 2>/dev/null; then break; fi
      sleep 0.25
    done
    if ((system_dbus_ready)); then
      log "system-dbus.compare.started pid=$system_dbus_pid socket=/run/dbus/system_bus_socket config=system"
      run_browser_comparison cft_system_bus "$cft" 19225 "$diag_dir/cft-system-bus-profile" "$diag_dir/cft-system-bus.log"
    else
      log "system-dbus.compare.failed pid=$system_dbus_pid socket_present=$([[ -S /run/dbus/system_bus_socket ]] && printf yes || printf no)"
      tail -n 20 "$diag_dir/system-dbus.log" 2>/dev/null | sed 's/^/chromium.session.diag system-dbus.log /'
      if [[ ! -S /run/dbus/system_bus_socket ]]; then
        /usr/bin/dbus-daemon --session --address=unix:path=/run/dbus/system_bus_socket --nofork --nopidfile >"$diag_dir/session-bus-at-system-socket.log" 2>&1 &
        system_dbus_pid=$!
        system_dbus_ready=0
        for attempt in $(seq 1 40); do
          if [[ -S /run/dbus/system_bus_socket ]]; then
            system_dbus_ready=1
            break
          fi
          if ! kill -0 "$system_dbus_pid" 2>/dev/null; then break; fi
          sleep 0.25
        done
        if ((system_dbus_ready)); then
          log "session-bus.compare.started pid=$system_dbus_pid socket=/run/dbus/system_bus_socket config=session"
          run_browser_comparison cft_session_bus "$cft" 19226 "$diag_dir/cft-session-bus-profile" "$diag_dir/cft-session-bus.log"
        else
          log "session-bus.compare.failed pid=$system_dbus_pid socket_present=$([[ -S /run/dbus/system_bus_socket ]] && printf yes || printf no)"
          tail -n 20 "$diag_dir/session-bus-at-system-socket.log" 2>/dev/null | sed 's/^/chromium.session.diag session-bus.log /'
        fi
      fi
    fi
  fi
fi

log "result status=probe-finished browser_mode=$browser_mode diagnostic_dir=$diag_dir"
exit 0
