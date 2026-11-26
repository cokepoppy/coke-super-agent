#!/usr/bin/env bash
set -Eeuo pipefail

sleep_seconds="${CSA_TEMPLATE_CHROME_SAMPLE_DELAY_SECONDS:-25}"
thread_sample="${CSA_TEMPLATE_CHROME_THREAD_SAMPLE:-1}"
cdp_watch_seconds="${CSA_TEMPLATE_CHROME_WATCH_SECONDS:-0}"
strace_sample="${CSA_TEMPLATE_CHROME_STRACE_SAMPLE:-0}"
strace_after_listener="${CSA_TEMPLATE_CHROME_STRACE_AFTER_LISTENER:-0}"
strace_main_thread_only="${CSA_TEMPLATE_CHROME_STRACE_MAIN_THREAD_ONLY:-0}"
font_cache_prewarm="${CSA_TEMPLATE_CHROME_PREWARM_FONTS:-0}"
route_matrix_only="${CSA_TEMPLATE_CHROME_ROUTE_MATRIX_ONLY:-0}"
trace_startup="${CSA_TEMPLATE_CHROME_TRACE_STARTUP:-0}"
strace_bundle="${CSA_TEMPLATE_CHROME_STRACE_BUNDLE:-}"
strace_bundle_expected="${CSA_TEMPLATE_CHROME_STRACE_BUNDLE_SHA256:-}"
diag_log_file="${CSA_TEMPLATE_CHROME_DIAG_LOG:-/tmp/csa-template-chrome-threads.log}"
if [[ ! "$sleep_seconds" =~ ^[0-9]+$ ]] || ((sleep_seconds < 10 || sleep_seconds > 60)); then
  echo 'chrome_thread_diag stage=preflight.failed reason=invalid-sample-delay' >&2
  exit 2
fi
if [[ "$thread_sample" != 0 && "$thread_sample" != 1 ]]; then
  echo 'chrome_thread_diag stage=preflight.failed reason=invalid-thread-sample' >&2
  exit 2
fi
if [[ "$font_cache_prewarm" != 0 && "$font_cache_prewarm" != 1 ]]; then
  echo 'chrome_thread_diag stage=preflight.failed reason=invalid-font-cache-prewarm' >&2
  exit 2
fi
if [[ ! "$cdp_watch_seconds" =~ ^[0-9]+$ ]] || ((cdp_watch_seconds > 450)); then
  echo 'chrome_thread_diag stage=preflight.failed reason=invalid-cdp-watch-seconds' >&2
  exit 2
fi
if [[ "$strace_sample" != 0 && "$strace_sample" != 1 ]]; then
  echo 'chrome_thread_diag stage=preflight.failed reason=invalid-strace-sample' >&2
  exit 2
fi
if [[ "$strace_after_listener" != 0 && "$strace_after_listener" != 1 ]]; then
  echo 'chrome_thread_diag stage=preflight.failed reason=invalid-strace-after-listener' >&2
  exit 2
fi
if [[ "$route_matrix_only" != 0 && "$route_matrix_only" != 1 ]]; then
  echo 'chrome_thread_diag stage=preflight.failed reason=invalid-route-matrix-only' >&2
  exit 2
fi
if [[ "$trace_startup" != 0 && "$trace_startup" != 1 ]]; then
  echo 'chrome_thread_diag stage=preflight.failed reason=invalid-trace-startup' >&2
  exit 2
fi

log() {
  local line
  line="chrome_thread_diag timestamp=$(date -u +%FT%TZ) stage=$1 ${*:2}"
  printf '%s\n' "$line" | tee -a "$diag_log_file"
}

umask 077
: >"$diag_log_file"
log preflight.ready "sample_delay_seconds=$sleep_seconds thread_sample=$thread_sample cdp_watch_seconds=$cdp_watch_seconds strace_sample=$strace_sample strace_after_listener=$strace_after_listener font_cache_prewarm=$font_cache_prewarm route_matrix_only=$route_matrix_only trace_startup=$trace_startup machine_id_bytes=$(wc -c </etc/machine-id 2>/dev/null | tr -d ' ')"
log sample.wait "seconds=$sleep_seconds"
sleep "$sleep_seconds"

if [[ -S /run/dbus/system_bus_socket ]]; then
  log system_bus.socket "present=1 listener=$(ss -xlpn 2>/dev/null | grep -F /run/dbus/system_bus_socket | cut -c1-300 | tr '\n' ';' || true)"
else
  log system_bus.socket present=0
fi
if timeout --kill-after=1s 4s dbus-send --system --dest=org.freedesktop.DBus --type=method_call --print-reply /org/freedesktop/DBus org.freedesktop.DBus.ListNames >/tmp/csa-chrome-thread-diag-dbus.out 2>&1; then
  log system_bus.call exit_code=0 response_bytes="$(wc -c </tmp/csa-chrome-thread-diag-dbus.out | tr -d ' ')"
else
  status=$?
  log system_bus.call "exit_code=$status response=$(tail -n 2 /tmp/csa-chrome-thread-diag-dbus.out | tr '\n' ';' | cut -c1-360)"
fi

log machine_id "etc_bytes=$(wc -c </etc/machine-id 2>/dev/null | tr -d ' ') dbus_link=$(readlink /var/lib/dbus/machine-id 2>/dev/null || true)"
log cgroup "cpu_max=$(tr '\n' ' ' </sys/fs/cgroup/cpu.max 2>/dev/null || true) cpu_stat=$(tr '\n' ';' </sys/fs/cgroup/cpu.stat 2>/dev/null | cut -c1-240) memory_current=$(cat /sys/fs/cgroup/memory.current 2>/dev/null || true) memory_max=$(cat /sys/fs/cgroup/memory.max 2>/dev/null || true)"

find_chrome_browser_pids() {
  local root_pid candidates candidate command_line executable
  root_pid="$(cat /run/csa-desktop/session.pid 2>/dev/null || true)"
  [[ "$root_pid" =~ ^[0-9]+$ ]] || return 1
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
      for (i = 1; i <= NR; i++) if (descendant[process_ids[i]]) print process_ids[i], process_names[i]
    }
  ')"
  while read -r candidate _; do
    [[ "$candidate" =~ ^[0-9]+$ ]] || continue
    command_line="$(tr '\0' ' ' <"/proc/$candidate/cmdline" 2>/dev/null || true)"
    case "$command_line" in
      *'--type=renderer'*|*'--type=utility'*|*'--type=gpu-process'*|*'--type=zygote'*) continue ;;
    esac
    executable="$(readlink -f "/proc/$candidate/exe" 2>/dev/null || true)"
    [[ "$executable" == */google/chrome/chrome ]] || continue
    printf '%s\n' "$candidate"
  done <<<"$candidates"
}

log chrome.process.scan.start "source=session-process-tree"
chrome_candidates="$(find_chrome_browser_pids || true)"
chrome_pid="$(head -n 1 <<<"$chrome_candidates" | tr -d '\r')"
log chrome.process.scan.complete "candidate_count=$(printf '%s\n' "$chrome_candidates" | awk 'NF {n++} END {print n+0}') chrome_pid=${chrome_pid:-missing}"
chrome_wait_seconds=15
if [[ "$font_cache_prewarm" == 1 ]]; then chrome_wait_seconds=300; fi
if [[ -z "$chrome_pid" && ( "${CSA_TEMPLATE_CHROME_GDB_SAMPLE:-0}" == 1 || ( "$strace_sample" == 1 && "$strace_main_thread_only" == 1 ) || "$font_cache_prewarm" == 1 ) ]]; then
  log chrome.process.wait.start "reason=browser-pid-not-resolved retry_seconds=$chrome_wait_seconds session_pid=$(cat /run/csa-desktop/session.pid 2>/dev/null || echo missing)"
  for attempt in $(seq 1 "$chrome_wait_seconds"); do
    sleep 1
    chrome_candidates="$(find_chrome_browser_pids || true)"
    chrome_pid="$(head -n 1 <<<"$chrome_candidates" | tr -d '\r')"
    if [[ -n "$chrome_pid" ]]; then
      log chrome.process.wait.complete "attempt=$attempt candidate_count=$(printf '%s\n' "$chrome_candidates" | awk 'NF {n++} END {print n+0}') chrome_pid=$chrome_pid"
      break
    fi
  done
  if [[ -z "$chrome_pid" ]]; then log chrome.process.wait.expired "retry_seconds=$chrome_wait_seconds"; fi
fi

if [[ -z "$chrome_pid" ]]; then
  log chrome.process missing=1
  process_table="$(ps -eo pid,ppid,stat,etime,pcpu,rss,wchan:24,comm 2>/dev/null | awk 'NR == 1 || $8 ~ /chrome|dbus/' | head -n 24 || true)"
  while IFS= read -r line; do
    [[ -n "$line" ]] || continue
    log chrome.process.table "$(printf '%q' "$line")"
  done <<<"$process_table"
else
  log chrome.process.snapshot.start "pid=$chrome_pid"
  chrome_state="$(awk '/^State:/ {print $2}' "/proc/$chrome_pid/status" 2>/dev/null || true)"
  chrome_wchan="$(cat "/proc/$chrome_pid/wchan" 2>/dev/null || true)"
  chrome_rss="$(awk '/^VmRSS:/ {print $2 " " $3}' "/proc/$chrome_pid/status" 2>/dev/null || true)"
  log chrome.process "pid=$chrome_pid state=$chrome_state wchan=$chrome_wchan rss=$(printf '%q' "$chrome_rss") executable=$(readlink -f "/proc/$chrome_pid/exe" 2>/dev/null || true)"
  chrome_session_bus_source_pid=
  chrome_session_bus_source=none
  chrome_session_bus_address=
  chrome_env_pid="$chrome_pid"
  for env_attempt in $(seq 1 8); do
    if [[ -r "/proc/$chrome_env_pid/environ" ]]; then
      chrome_session_bus_address="$(tr '\0' '\n' <"/proc/$chrome_env_pid/environ" 2>/dev/null | sed -n 's/^DBUS_SESSION_BUS_ADDRESS=//p' | head -n 1 || true)"
      if [[ -n "$chrome_session_bus_address" ]]; then
        chrome_session_bus_source_pid="$chrome_env_pid"
        chrome_session_bus_source=proc-environ
        break
      fi
    fi
    chrome_env_parent_pid="$(awk '/^PPid:/ {print $2}' "/proc/$chrome_env_pid/status" 2>/dev/null || true)"
    [[ "$chrome_env_parent_pid" =~ ^[0-9]+$ && "$chrome_env_parent_pid" -gt 1 && "$chrome_env_parent_pid" != "$chrome_env_pid" ]] || break
    chrome_env_pid="$chrome_env_parent_pid"
  done
  dbus_processes="$(ps -eo pid=,ppid=,stat=,wchan:20,comm= 2>/dev/null | awk '$5 ~ /dbus/ {printf "%s:%s:%s:%s:%s;", $1, $2, $3, $4, $5; if (++count >= 8) exit}' | cut -c1-700 || true)"
  dbus_socket_rows="$(ss -xlpn 2>/dev/null | awk '/dbus-daemon|\/tmp\/dbus-/ {printf "%s;", $0; if (++count >= 6) exit}' | cut -c1-1000 || true)"
  if [[ -z "$chrome_session_bus_address" ]]; then
    dbus_socket_path="$(printf '%s\n' "$dbus_socket_rows" | sed -nE 's/.*[[:space:]](@?\/tmp\/dbus-[^[:space:];]+).*/\1/p' | head -n 1 || true)"
    if [[ "$dbus_socket_path" == @* ]]; then
      chrome_session_bus_address="unix:abstract=${dbus_socket_path#@}"
      chrome_session_bus_source=ss-abstract-socket
    elif [[ -S "$dbus_socket_path" ]]; then
      chrome_session_bus_address="unix:path=$dbus_socket_path"
      chrome_session_bus_source=ss-path-socket
    fi
  fi
  log cdp.session-bus.discovery "source=$chrome_session_bus_source source_pid=${chrome_session_bus_source_pid:-unknown} processes=$(printf '%q' "${dbus_processes:-none}") sockets=$(printf '%q' "${dbus_socket_rows:-none}") address_present=$([[ -n "$chrome_session_bus_address" ]] && printf 1 || printf 0)"
  if [[ -z "$chrome_session_bus_address" ]]; then
    log cdp.session-bus.probe.skipped reason=chrome-session-address-missing
  elif ! command -v dbus-send >/dev/null 2>&1; then
    log cdp.session-bus.probe.skipped reason=dbus-send-missing
  elif ! command -v runuser >/dev/null 2>&1; then
    log cdp.session-bus.probe.skipped reason=runuser-missing
  else
    log cdp.session-bus.probe.start "source=$chrome_session_bus_source source_pid=${chrome_session_bus_source_pid:-unknown} address=$(printf '%q' "$chrome_session_bus_address")"
    chrome_uid="$(awk '/^Uid:/ {print $2; exit}' "/proc/$chrome_pid/status" 2>/dev/null || true)"
    chrome_user="$(getent passwd "$chrome_uid" 2>/dev/null | cut -d: -f1 || true)"
    if [[ ! "$chrome_uid" =~ ^[0-9]+$ || -z "$chrome_user" ]]; then
      log cdp.session-bus.probe.skipped "reason=chrome-user-resolution-failed uid=${chrome_uid:-unknown}"
    else
    session_bus_probe_file=/tmp/csa-chrome-session-bus-probe.log
    session_bus_probe_started_ms="$(date +%s%3N)"
    if timeout --signal=TERM --kill-after=1s 6s runuser -u "$chrome_user" -- env DBUS_SESSION_BUS_ADDRESS="$chrome_session_bus_address" \
      dbus-send --session --dest=org.freedesktop.DBus --type=method_call --print-reply \
      /org/freedesktop/DBus org.freedesktop.DBus.ListNames >"$session_bus_probe_file" 2>&1; then
      session_bus_probe_status=0
    else
      session_bus_probe_status=$?
    fi
    session_bus_probe_finished_ms="$(date +%s%3N)"
    log cdp.session-bus.probe.complete "uid=$chrome_uid user=$chrome_user exit_code=$session_bus_probe_status duration_ms=$((session_bus_probe_finished_ms - session_bus_probe_started_ms)) response_bytes=$(wc -c <"$session_bus_probe_file" | tr -d ' ') detail=$(tail -n 2 "$session_bus_probe_file" | tr '\n' ' ' | cut -c1-240)"
    fi
  fi
  ps -eo pid,ppid,stat,etime,pcpu,rss,wchan:24,comm 2>/dev/null | awk '$8 ~ /chrome|dbus/' | head -n 30

  thread_snapshot() {
    local task_dir tid comm state_ticks state ticks
    for task_dir in "/proc/$chrome_pid/task/"*; do
      [[ -r "$task_dir/stat" ]] || continue
      tid="${task_dir##*/}"
      comm="$(cat "$task_dir/comm" 2>/dev/null || printf unknown)"
      state_ticks="$(awk '{sub(/^.*\) /, ""); print $1, $12 + $13}' "$task_dir/stat" 2>/dev/null || true)"
      read -r state ticks <<<"$state_ticks"
      [[ "$ticks" =~ ^[0-9]+$ ]] || continue
      printf '%s\t%s\t%s\t%s\n' "$tid" "$comm" "${state:-?}" "$ticks"
    done
  }

  if [[ "$thread_sample" == 1 ]]; then
    before_file="$(mktemp /tmp/csa-chrome-thread-before.XXXXXX)"
    after_file="$(mktemp /tmp/csa-chrome-thread-after.XXXXXX)"
    snapshot_file="$(mktemp /tmp/csa-chrome-thread-top.XXXXXX)"
    start_ms="$(date +%s%3N)"
    log thread_cpu.sample.start "pid=$chrome_pid"
    thread_snapshot >"$before_file"
    sleep 2
    thread_snapshot >"$after_file"
    end_ms="$(date +%s%3N)"
    elapsed_ms=$((end_ms - start_ms))
    ticks_per_second="$(getconf CLK_TCK 2>/dev/null || printf 100)"
    awk -F '\t' -v hz="$ticks_per_second" -v elapsed="$elapsed_ms" '
      NR == FNR { ticks[$1]=$4; next }
      $1 in ticks { delta=$4-ticks[$1]; printf "%.1f\t%s\t%s\t%s\n", elapsed ? delta*100000/(hz*elapsed) : 0, $1, $2, $3 }
    ' "$before_file" "$after_file" | sort -nr -k1,1 | head -n 10 >"$snapshot_file"
    log thread_cpu.sample "pid=$chrome_pid elapsed_ms=$elapsed_ms thread_count=$(wc -l <"$after_file" | tr -d ' ') hottest_threads=10"
    while IFS=$'\t' read -r cpu_pct tid comm state; do
      [[ "$tid" =~ ^[0-9]+$ ]] || continue
      thread_dir="/proc/$chrome_pid/task/$tid"
      wchan="$(cat "$thread_dir/wchan" 2>/dev/null || true)"
      syscall="$(cat "$thread_dir/syscall" 2>&1 | cut -c1-140)"
      stack="$(cat "$thread_dir/stack" 2>/dev/null | head -n 8 | tr '\n' ';' | cut -c1-500)"
      log thread_cpu.hot "tid=$tid comm=$comm state=$state cpu_pct=$cpu_pct wchan=$wchan syscall=$(printf '%q' "$syscall") stack=$(printf '%q' "$stack")"
    done <"$snapshot_file"
    rm -f -- "$before_file" "$after_file" "$snapshot_file"
    log chrome.process.snapshot.complete "pid=$chrome_pid"
  else
    log thread_cpu.skipped "reason=low-overhead-cdp-watch pid=$chrome_pid"
  fi

  capture_listener_thread_sample() {
    local sample_label="${1:-cdp-listener}"
    local before_file after_file snapshot_file start_ms end_ms elapsed_ms ticks_per_second
    local cpu_pct tid comm state thread_dir wchan syscall stack
    if ! declare -F thread_snapshot >/dev/null; then
      log cdp.thread_cpu.skipped "reason=initial-thread-snapshot-function-unavailable sample=$sample_label pid=${chrome_pid:-missing}"
      return 0
    fi
    before_file="$(mktemp /tmp/csa-chrome-cdp-thread-before.XXXXXX)"
    after_file="$(mktemp /tmp/csa-chrome-cdp-thread-after.XXXXXX)"
    snapshot_file="$(mktemp /tmp/csa-chrome-cdp-thread-top.XXXXXX)"
    start_ms="$(date +%s%3N)"
    log cdp.thread_cpu.sample.start "sample=$sample_label pid=$chrome_pid"
    thread_snapshot >"$before_file"
    sleep 2
    thread_snapshot >"$after_file"
    end_ms="$(date +%s%3N)"
    elapsed_ms=$((end_ms - start_ms))
    ticks_per_second="$(getconf CLK_TCK 2>/dev/null || printf 100)"
    awk -F '\t' -v hz="$ticks_per_second" -v elapsed="$elapsed_ms" '
      NR == FNR { ticks[$1]=$4; next }
      $1 in ticks { delta=$4-ticks[$1]; printf "%.1f\t%s\t%s\t%s\n", elapsed ? delta*100000/(hz*elapsed) : 0, $1, $2, $3 }
    ' "$before_file" "$after_file" | sort -nr -k1,1 | head -n 10 >"$snapshot_file"
    log cdp.thread_cpu.sample.complete "sample=$sample_label pid=$chrome_pid elapsed_ms=$elapsed_ms thread_count=$(wc -l <"$after_file" | tr -d ' ') hottest_threads=10"
    while IFS=$'\t' read -r cpu_pct tid comm state; do
      [[ "$tid" =~ ^[0-9]+$ ]] || continue
      thread_dir="/proc/$chrome_pid/task/$tid"
      wchan="$(cat "$thread_dir/wchan" 2>/dev/null || true)"
      syscall="$(timeout --kill-after=1s 2s cat "$thread_dir/syscall" 2>&1 | cut -c1-140 || true)"
      stack="$(timeout --kill-after=1s 2s cat "$thread_dir/stack" 2>/dev/null | head -n 8 | tr '\n' ';' | cut -c1-500 || true)"
      log cdp.thread_cpu.hot "sample=$sample_label tid=$tid comm=$comm state=$state cpu_pct=$cpu_pct wchan=$wchan syscall=$(printf '%q' "$syscall") stack=$(printf '%q' "$stack")"
    done <"$snapshot_file"
    rm -f -- "$before_file" "$after_file" "$snapshot_file"
  }

  if [[ "${CSA_TEMPLATE_CHROME_GDB_SAMPLE:-0}" == 1 ]]; then
    gdb_log=/tmp/csa-template-chrome-gdb.log
    : >"$gdb_log"
    gdb_binary="$(command -v gdb 2>/dev/null || true)"
    gdb_library_path=
    gdb_data_directory=
    gdb_data_args=()
    if [[ -z "$gdb_binary" ]]; then
      available_kb="$(df -Pk / | awk 'NR == 2 {print $4}')"
      gdb_bundle="${CSA_TEMPLATE_CHROME_GDB_BUNDLE:-}"
      gdb_bundle_expected="${CSA_TEMPLATE_CHROME_GDB_BUNDLE_SHA256:-}"
      log gdb.rootfs.preflight "disk_available_kb=$available_kb bundle_present=$([[ -s "$gdb_bundle" ]] && echo yes || echo no)"
      if ((available_kb < 524288)); then
        log gdb.rootfs.skipped reason=disk-below-512MiB
      elif [[ ! -s "$gdb_bundle" || ! "$gdb_bundle_expected" =~ ^[[:xdigit:]]{64}$ ]]; then
        log gdb.rootfs.skipped reason=verified-offline-bundle-unavailable
      else
        gdb_bundle_sha="$(sha256sum "$gdb_bundle" | awk '{print $1}')"
        if [[ "$gdb_bundle_sha" != "$gdb_bundle_expected" ]]; then
          log gdb.rootfs.skipped "reason=bundle-checksum-mismatch actual=$gdb_bundle_sha expected=$gdb_bundle_expected"
        else
          shm_available_kb="$(df -Pk /dev/shm 2>/dev/null | awk 'NR == 2 {print $4}')"
          shm_mount_target="$(readlink -f /dev/shm 2>/dev/null || printf /dev/shm)"
          shm_mount_options="$(awk -v target="$shm_mount_target" '$2 == target {print $4; exit}' /proc/mounts 2>/dev/null || true)"
          if [[ "$shm_available_kb" =~ ^[0-9]+$ ]] && ((shm_available_kb >= 40960)) && [[ -n "$shm_mount_options" ]]; then
            gdb_bundle_root="/dev/shm/csa-gdb-jammy-rootfs-${BASHPID}"
            gdb_extract_target=tmpfs
          else
            gdb_bundle_root="/tmp/csa-gdb-jammy-rootfs-${BASHPID}"
            gdb_extract_target=overlay
          fi
          gdb_extract_started=$SECONDS
          log gdb.rootfs.extract.start "path=$gdb_bundle bytes=$(stat -c %s "$gdb_bundle") sha256=$gdb_bundle_sha target=$gdb_extract_target target_available_kb=${shm_available_kb:-unknown} mount_target=${shm_mount_target:-unknown} mount_options=${shm_mount_options:-unknown}"
          install -d -m 0700 "$gdb_bundle_root"
          if timeout --signal=TERM --kill-after=2s 45s tar --no-same-owner -xzf "$gdb_bundle" -C "$gdb_bundle_root"; then
            gdb_binary="$gdb_bundle_root/gdb-rootfs/usr/bin/gdb"
            gdb_data_directory="$gdb_bundle_root/gdb-rootfs/usr/share/gdb"
            gdb_library_path="$gdb_bundle_root/gdb-rootfs/usr/lib/aarch64-linux-gnu:$gdb_bundle_root/gdb-rootfs/lib/aarch64-linux-gnu:$gdb_bundle_root/gdb-rootfs/usr/lib:$gdb_bundle_root/gdb-rootfs/lib"
            if [[ "$gdb_extract_target" == tmpfs && ! -x "$gdb_binary" ]]; then
              gdb_exec_dir="/tmp/csa-gdb-runner-$BASHPID"
              install -d -m 0700 "$gdb_exec_dir"
              gdb_copy_ok=1
              for gdb_library_directory in usr/lib/aarch64-linux-gnu lib/aarch64-linux-gnu usr/lib lib; do
                gdb_library_source="$gdb_bundle_root/gdb-rootfs/$gdb_library_directory"
                [[ -d "$gdb_library_source" ]] || continue
                install -d -m 0700 "$gdb_exec_dir/$gdb_library_directory"
                if ! cp -a "$gdb_library_source/." "$gdb_exec_dir/$gdb_library_directory/"; then
                  gdb_copy_ok=0
                  break
                fi
              done
              if [[ "$gdb_copy_ok" == 1 ]] && cp "$gdb_binary" "$gdb_exec_dir/gdb" && chmod 0700 "$gdb_exec_dir/gdb"; then
                gdb_library_path="$gdb_exec_dir/usr/lib/aarch64-linux-gnu:$gdb_exec_dir/lib/aarch64-linux-gnu:$gdb_exec_dir/usr/lib:$gdb_exec_dir/lib:$gdb_library_path"
                log gdb.rootfs.binary.fallback "reason=tmpfs-binary-and-library-staging path=$gdb_exec_dir/gdb bytes=$(stat -c %s "$gdb_exec_dir/gdb") staged_library_kb=$(du -sk "$gdb_exec_dir" | awk '{print $1}')"
                gdb_binary="$gdb_exec_dir/gdb"
              else
                log gdb.rootfs.binary.fallback.failed reason=copy-or-chmod-library-staging-failed
                gdb_binary=
              fi
            fi
            gdb_data_args=()
            if [[ -n "$gdb_data_directory" ]]; then gdb_data_args=(--data-directory "$gdb_data_directory"); fi
            if [[ -x "$gdb_binary" ]] && timeout --signal=TERM --kill-after=2s 8s env LD_LIBRARY_PATH="$gdb_library_path" "$gdb_binary" "${gdb_data_args[@]}" --version >"$gdb_log" 2>&1; then
              log gdb.rootfs.ready "version=$(head -n 1 "$gdb_log") files=$(find "$gdb_bundle_root/gdb-rootfs" -type f | wc -l | tr -d ' ') extract_elapsed_seconds=$((SECONDS - gdb_extract_started)) target=$gdb_extract_target"
            else
              status=$?
              gdb_binary=
              log gdb.rootfs.failed "phase=executable-check timeout_seconds=8 exit_code=$status tail=$(tail -n 8 "$gdb_log" | tr '\n' ';' | cut -c1-560)"
            fi
          else
            status=$?
            log gdb.rootfs.failed "phase=extract exit_code=$status"
          fi
        fi
      fi
    fi

    if [[ -n "$gdb_binary" && -x "$gdb_binary" ]] && kill -0 "$chrome_pid" 2>/dev/null; then
      log gdb.stack.start "pid=$chrome_pid timeout_seconds=60 scope=all-threads frames=8"
      if timeout --signal=INT --kill-after=2s 60s env LD_LIBRARY_PATH="$gdb_library_path" "$gdb_binary" -q -nx --batch \
        "${gdb_data_args[@]}" \
        -ex 'set pagination off' \
        -ex 'set confirm off' \
        -ex 'set debuginfod enabled off' \
        -iex 'set auto-load python-scripts off' \
        -ex 'set auto-solib-add off' \
        -ex 'set print thread-events off' \
        -ex "attach $chrome_pid" \
        -ex 'info threads' \
        -ex 'thread apply all bt 8' \
        -ex detach \
        -ex quit >"$gdb_log" 2>&1; then
        status=0
      else
        status=$?
      fi
      log gdb.stack.complete "pid=$chrome_pid exit_code=$status bytes=$(wc -c <"$gdb_log" | tr -d ' ')"
      while IFS= read -r line; do
        log gdb.stack.line "$(printf '%q' "$line")"
      done <"$gdb_log"
    else
      log gdb.stack.skipped "reason=$([[ -n "$gdb_binary" && -x "$gdb_binary" ]] && echo chrome-exited || echo gdb-unavailable)"
    fi
  fi
fi

probe_http() {
  local url="$1" body_file="$2" label="$3" max_seconds="${4:-5}"
  local meta_file="/tmp/csa-cdp-${label}.meta" error_file="/tmp/csa-cdp-${label}.stderr"
  if curl --noproxy '*' --connect-timeout 1 --max-time "$max_seconds" -sS -o "$body_file" \
    -w 'http_code=%{http_code}|connect_seconds=%{time_connect}|total_seconds=%{time_total}|bytes=%{size_download}' \
    "$url" >"$meta_file" 2>"$error_file"; then
    http_probe_exit=0
  else
    http_probe_exit=$?
  fi
  http_probe_meta="$(cat "$meta_file" 2>/dev/null || true)"
  http_probe_error="$(tail -n 1 "$error_file" 2>/dev/null | tr '\n' ' ' | cut -c1-260 || true)"
}

listener_queue_state() {
  local suffix="$1"
  ss -H -lnt 2>/dev/null | awk -v suffix="$suffix" 'index($4, suffix) {printf "local=%s recv_queue=%s backlog=%s", $4, $2, $3; found=1} END {if (!found) printf "none"}' || true
}

listener_connections_state() {
  local suffix=":$1"
  ss -H -tnp 2>/dev/null | awk -v suffix="$suffix" 'index($4, suffix) || index($5, suffix) {print}' | tr '\n' ';' | cut -c1-900 || true
}

capture_cdp_strace() {
  local trace_mode="${1:-cdp-listener}"
  local available_kb actual_sha package_arch package_version strace_root strace_binary version_line
  local trace_target_pid listener_process_details task_count attached_count capture_scope trace_duration_seconds attach_wait_seconds
  local candidate_pid candidate_threads candidate_comm candidate_state candidate_ppid candidate_type
  local trace_process_pids trace_process_count connection_before connection_during connection_after
  local accepted_comm accepted_state accepted_wchan accepted_syscall thread_owner_pid thread_proc_root
  local trace_socket_threads trace_thread_id
  local -a chrome_attach_pids=() trace_attach_args=() trace_follow_args=() trace_syscall_args=()
  local trace_file trace_stderr strace_runner_pid
  local attach_ready attach_attempt curl_meta curl_stderr curl_runner_pid curl_exit_code strace_exit_code
  local queue_before queue_during queue_after trace_bytes trace_lines accept_count read_count write_count futex_count open_count poll_count
  strace_attempted=1
  if [[ "$strace_sample" != 1 ]]; then
    log cdp.strace.skipped reason=disabled
    return 0
  fi
  if [[ ! "$chrome_pid" =~ ^[0-9]+$ || ! -r "/proc/$chrome_pid/status" ]]; then
    log cdp.strace.skipped reason=chrome-process-unavailable
    return 0
  fi
  available_kb="$(df -Pk / | awk 'NR == 2 {print $4}')"
  if [[ ! "$available_kb" =~ ^[0-9]+$ ]] || ((available_kb < 262144)); then
    log cdp.strace.skipped "reason=guest-root-below-256MiB available_kb=${available_kb:-unknown}"
    return 0
  fi

  strace_binary="$(command -v strace 2>/dev/null || true)"
  if [[ -z "$strace_binary" ]]; then
    if [[ ! -s "$strace_bundle" || ! "$strace_bundle_expected" =~ ^[[:xdigit:]]{64}$ ]]; then
      log cdp.strace.skipped reason=verified-arm64-package-unavailable
      return 0
    fi
    actual_sha="$(sha256sum "$strace_bundle" | awk '{print $1}')"
    if [[ "$actual_sha" != "$strace_bundle_expected" ]]; then
      log cdp.strace.skipped "reason=package-checksum-mismatch actual=$actual_sha"
      return 0
    fi
    package_arch="$(dpkg-deb -f "$strace_bundle" Architecture 2>/dev/null || true)"
    package_version="$(dpkg-deb -f "$strace_bundle" Version 2>/dev/null || true)"
    if [[ "$package_arch" != arm64 ]]; then
      log cdp.strace.skipped "reason=package-architecture-mismatch architecture=${package_arch:-unknown}"
      return 0
    fi
    strace_root=/tmp/csa-template-strace-root
    install -d -m 0700 "$strace_root"
    log cdp.strace.extract.start "package_bytes=$(stat -c %s "$strace_bundle") package_version=$package_version sha256=$actual_sha"
    if timeout --signal=TERM --kill-after=2s 30s dpkg-deb -x "$strace_bundle" "$strace_root" >/tmp/csa-template-strace-extract.stdout 2>/tmp/csa-template-strace-extract.stderr; then
      strace_binary="$strace_root/usr/bin/strace"
      log cdp.strace.extract.complete "binary_present=$([[ -x "$strace_binary" ]] && echo yes || echo no)"
    else
      local extract_status=$?
      log cdp.strace.extract.failed "exit_code=$extract_status detail=$(tail -n 3 /tmp/csa-template-strace-extract.stderr 2>/dev/null | tr '\n' ' ' | cut -c1-280)"
      return 0
    fi
  fi
  if [[ ! -x "$strace_binary" ]] || ! timeout --kill-after=1s 4s "$strace_binary" -V >/tmp/csa-template-strace-version.log 2>&1; then
    log cdp.strace.skipped "reason=extracted-binary-unusable version=$(tail -n 2 /tmp/csa-template-strace-version.log 2>/dev/null | tr '\n' ' ' | cut -c1-220)"
    return 0
  fi
  version_line="$(head -n 1 /tmp/csa-template-strace-version.log 2>/dev/null || true)"

  listener_process_details="$(ss -H -lntp 2>/dev/null | awk -v suffix=":$watch_port" 'index($4, suffix) {print; found=1; if (++count >= 3) exit} END {if (!found) print "none"}' | tr '\n' ';' | cut -c1-720 || true)"
  trace_target_pid="$(printf '%s' "$listener_process_details" | grep -oE 'pid=[0-9]+' | head -n 1 | cut -d= -f2 || true)"
  if [[ ! "$trace_target_pid" =~ ^[0-9]+$ ]]; then
    trace_target_pid="$chrome_pid"
  fi
  task_count=0
  capture_scope=all-chrome-processes-and-threads
  trace_duration_seconds=45
  attach_wait_seconds=20
  if [[ "$strace_main_thread_only" == 1 ]]; then
    capture_scope=chrome-and-cdp-bridge-leaders
    trace_duration_seconds=15
    attach_wait_seconds=5
    chrome_attach_pids+=("$chrome_pid")
    trace_attach_args=(-p "$chrome_pid")
    task_count=1
    candidate_comm="$(cat "/proc/$chrome_pid/comm" 2>/dev/null | cut -c1-50 || true)"
    candidate_state="$(awk '/^State:/ {print $2}' "/proc/$chrome_pid/status" 2>/dev/null || true)"
    log cdp.chrome.process "pid=$chrome_pid comm=${candidate_comm:-unknown} state=${candidate_state:-unknown} scope=main-thread-only"
    if [[ "$trace_target_pid" =~ ^[0-9]+$ && "$trace_target_pid" != "$chrome_pid" && -r "/proc/$trace_target_pid/status" ]]; then
      chrome_attach_pids+=("$trace_target_pid")
      trace_attach_args+=(-p "$trace_target_pid")
      task_count=$((task_count + 1))
      candidate_comm="$(cat "/proc/$trace_target_pid/comm" 2>/dev/null | cut -c1-50 || true)"
      candidate_state="$(awk '/^State:/ {print $2}' "/proc/$trace_target_pid/status" 2>/dev/null || true)"
      log cdp.bridge.process "pid=$trace_target_pid comm=${candidate_comm:-unknown} state=${candidate_state:-unknown} scope=main-thread-only"
    fi
    trace_syscall_args=(-e trace=read,readv,pread64,write,writev,pwrite64,recvfrom,recvmsg,sendto,sendmsg,connect,accept,accept4,poll,ppoll,epoll_wait,epoll_pwait,select,pselect6,ioctl,futex)
  elif [[ "$strace_after_listener" == 1 ]]; then
    capture_scope=cdp-listener-chrome-threads-and-bridge-loop
    trace_duration_seconds=75
    attach_wait_seconds=50
    task_count=0
    for candidate_pid in $(pgrep -x chrome 2>/dev/null || true); do
      [[ -r "/proc/$candidate_pid/status" ]] || continue
      executable="$(readlink -f "/proc/$candidate_pid/exe" 2>/dev/null || true)"
      [[ "$executable" == */google/chrome/chrome ]] || continue
      chrome_attach_pids+=("$candidate_pid")
      trace_attach_args+=(-p "$candidate_pid")
      candidate_threads="$(find "/proc/$candidate_pid/task" -mindepth 1 -maxdepth 1 -type d 2>/dev/null | wc -l | tr -d ' ' || printf 0)"
      [[ "$candidate_threads" =~ ^[0-9]+$ ]] || candidate_threads=0
      task_count=$((task_count + candidate_threads))
      candidate_comm="$(cat "/proc/$candidate_pid/comm" 2>/dev/null | cut -c1-50 || true)"
      candidate_ppid="$(awk '/^PPid:/ {print $2}' "/proc/$candidate_pid/status" 2>/dev/null || true)"
      candidate_state="$(awk '/^State:/ {print $2}' "/proc/$candidate_pid/status" 2>/dev/null || true)"
      candidate_type="$(tr '\0' '\n' <"/proc/$candidate_pid/cmdline" 2>/dev/null | awk -F= '/^--type=/ {type=$2} /^--utility-sub-type=/ {subtype=$2} END {printf "type=%s utility_subtype=%s", type ? type : "browser", subtype ? subtype : "none"}')"
      log cdp.chrome.process "pid=$candidate_pid ppid=${candidate_ppid:-unknown} comm=${candidate_comm:-unknown} state=${candidate_state:-unknown} threads=$candidate_threads executable=$executable $candidate_type"
    done
    if ((${#chrome_attach_pids[@]} == 0)); then
      chrome_attach_pids+=("$trace_target_pid")
      trace_attach_args+=(-p "$trace_target_pid")
      task_count="$(find "/proc/$trace_target_pid/task" -mindepth 1 -maxdepth 1 -type d 2>/dev/null | wc -l | tr -d ' ' || printf 0)"
      [[ "$task_count" =~ ^[0-9]+$ ]] || task_count=0
      log cdp.chrome.process "pid=$trace_target_pid source=listener-owner-fallback threads=$task_count"
    elif [[ "$trace_target_pid" =~ ^[0-9]+$ && -r "/proc/$trace_target_pid/status" ]]; then
      listener_owner_attached=0
      for candidate_pid in "${chrome_attach_pids[@]}"; do
        if [[ "$candidate_pid" == "$trace_target_pid" ]]; then listener_owner_attached=1; break; fi
      done
      if [[ "$listener_owner_attached" == 0 ]]; then
        chrome_attach_pids+=("$trace_target_pid")
        trace_attach_args+=(-p "$trace_target_pid")
        task_count=$((task_count + 1))
        candidate_comm="$(cat "/proc/$trace_target_pid/comm" 2>/dev/null | cut -c1-50 || true)"
        candidate_state="$(awk '/^State:/ {print $2}' "/proc/$trace_target_pid/status" 2>/dev/null || true)"
        log cdp.bridge.process "pid=$trace_target_pid comm=${candidate_comm:-unknown} state=${candidate_state:-unknown} scope=listener-owner-main-thread"
      fi
    fi
    trace_follow_args=(-f)
  else
    for candidate_pid in $(pgrep -x chrome 2>/dev/null || true); do
      [[ -r "/proc/$candidate_pid/status" ]] || continue
      chrome_attach_pids+=("$candidate_pid")
      trace_attach_args+=(-p "$candidate_pid")
      candidate_threads="$(find "/proc/$candidate_pid/task" -mindepth 1 -maxdepth 1 -type d 2>/dev/null | wc -l | tr -d ' ' || printf 0)"
      [[ "$candidate_threads" =~ ^[0-9]+$ ]] || candidate_threads=0
      task_count=$((task_count + candidate_threads))
      candidate_comm="$(cat "/proc/$candidate_pid/comm" 2>/dev/null | cut -c1-50 || true)"
      candidate_ppid="$(awk '/^PPid:/ {print $2}' "/proc/$candidate_pid/status" 2>/dev/null || true)"
      candidate_state="$(awk '/^State:/ {print $2}' "/proc/$candidate_pid/status" 2>/dev/null || true)"
      candidate_type="$(tr '\0' '\n' <"/proc/$candidate_pid/cmdline" 2>/dev/null | awk -F= '/^--type=/ {type=$2} /^--utility-sub-type=/ {subtype=$2} END {printf "type=%s utility_subtype=%s", type ? type : "browser", subtype ? subtype : "none"}')"
      log cdp.chrome.process "pid=$candidate_pid ppid=${candidate_ppid:-unknown} comm=${candidate_comm:-unknown} state=${candidate_state:-unknown} threads=${candidate_threads:-0} $candidate_type"
    done
    if ((${#chrome_attach_pids[@]} == 0)); then
      chrome_attach_pids+=("$trace_target_pid")
      trace_attach_args+=(-p "$trace_target_pid")
      task_count="$(find "/proc/$trace_target_pid/task" -mindepth 1 -maxdepth 1 -type d 2>/dev/null | wc -l | tr -d ' ' || printf 0)"
      [[ "$task_count" =~ ^[0-9]+$ ]] || task_count=0
    fi
    trace_follow_args=(-f)
  fi
  trace_process_pids="$(IFS=,; printf '%s' "${chrome_attach_pids[*]}")"
  trace_process_count="${#chrome_attach_pids[@]}"
  if [[ "$strace_after_listener" == 1 ]]; then
    for candidate_pid in "$chrome_pid" "$trace_target_pid"; do
      [[ "$candidate_pid" =~ ^[0-9]+$ && -d "/proc/$candidate_pid/fd" ]] || continue
      candidate_comm="$(cat "/proc/$candidate_pid/comm" 2>/dev/null | cut -c1-50 || true)"
      for fd_path in "/proc/$candidate_pid"/fd/*; do
        [[ -e "$fd_path" || -L "$fd_path" ]] || continue
        fd_target="$(readlink "$fd_path" 2>/dev/null || true)"
        [[ "$fd_target" == pipe:\[*\] ]] || continue
        log cdp.pipe.fd "pid=$candidate_pid comm=${candidate_comm:-unknown} fd=${fd_path##*/} target=$fd_target"
      done
    done
  fi
  if ((${#trace_syscall_args[@]} == 0)); then
    trace_syscall_args=(-e trace=accept,accept4,bind,listen,connect,getsockopt,recvfrom,recvmsg,sendto,sendmsg,epoll_ctl,epoll_wait,epoll_pwait,poll,ppoll,read,write,close,shutdown,ioctl,fcntl,futex,futex_waitv,openat,openat2,statx,mmap,mprotect,prctl)
  fi

  trace_file=/tmp/csa-template-chrome-cdp.strace
  trace_stderr=/tmp/csa-template-chrome-cdp-strace.stderr
  curl_meta=/tmp/csa-template-chrome-cdp-overlap.meta
  curl_stderr=/tmp/csa-template-chrome-cdp-overlap.stderr
  queue_before="$(listener_queue_state ":$watch_port")"
  connection_before="$(listener_connections_state "$watch_port")"
  log cdp.strace.start "trigger=$trace_mode version=$(printf '%q' "$version_line") chrome_pid=$chrome_pid listener_details=$(printf '%q' "$listener_process_details") target_pid=$trace_target_pid traced_process_pids=${trace_process_pids:-none} traced_process_count=$trace_process_count target_task_count=$task_count attach_scope=$capture_scope duration_seconds=$trace_duration_seconds attach_wait_seconds=$attach_wait_seconds connections_before=$(printf '%q' "${connection_before:-none}")"
  timeout --signal=INT --kill-after=2s "${trace_duration_seconds}s" "$strace_binary" "${trace_follow_args[@]}" -tt -T -yy -s 256 \
    "${trace_syscall_args[@]}" \
    "${trace_attach_args[@]}" -o "$trace_file" 2>"$trace_stderr" &
  strace_runner_pid=$!
  attach_ready=no
  for attach_attempt in $(seq 1 "$((attach_wait_seconds * 10))"); do
    attached_count="$(awk '
      /Process [0-9]+ attached with [0-9]+ threads/ {sum += $(NF - 1); seen=1; next}
      /Process [0-9]+ attached$/ {sum += 1; seen=1}
      END {if (seen) print sum}
    ' "$trace_stderr" 2>/dev/null)"
    if ((attach_attempt >= 5 && attached_count >= task_count && task_count > 0)) && kill -0 "$strace_runner_pid" 2>/dev/null; then
      attach_ready=yes
      break
    fi
    if grep -Eqi 'Operation not permitted|No such process|ptrace.*failed' "$trace_stderr" 2>/dev/null && ((attached_count == 0)); then
      break
    fi
    kill -0 "$strace_runner_pid" 2>/dev/null || break
    sleep 0.1
  done
  attached_count="$(awk '
    /Process [0-9]+ attached with [0-9]+ threads/ {sum += $(NF - 1); seen=1; next}
    /Process [0-9]+ attached$/ {sum += 1; seen=1}
    END {if (seen) print sum}
  ' "$trace_stderr" 2>/dev/null)"
  if [[ "$attach_ready" == no && "$attached_count" =~ ^[0-9]+$ ]] && ((attached_count > 0)) && kill -0 "$strace_runner_pid" 2>/dev/null; then
    attach_ready=partial
  fi
  if ((attached_count >= task_count && task_count > 0)); then
    attach_coverage=complete
  elif ((attached_count > 0)); then
    attach_coverage=partial
  else
    attach_coverage=none
  fi
  log cdp.strace.attach "target_pid=$trace_target_pid target_task_count=$task_count attached_count=${attached_count:-0} coverage=$attach_coverage status=$attach_ready listener_details=$(printf '%q' "$listener_process_details") detail=$(tr '\n' ' ' <"$trace_stderr" 2>/dev/null | cut -c1-240)"
  if [[ "$attach_ready" != no && "$listener_process_details" != none* ]]; then
    timeout --signal=TERM --kill-after=1s 7s curl --noproxy '*' --connect-timeout 1 --max-time 5 -sS \
      -o /dev/null -w 'http_code=%{http_code}|connect_seconds=%{time_connect}|total_seconds=%{time_total}|bytes=%{size_download}' \
      "http://127.0.0.1:$watch_port/json/version" >"$curl_meta" 2>"$curl_stderr" &
    curl_runner_pid=$!
    sleep 1
    queue_during="$(listener_queue_state ":$watch_port")"
    connection_during="$(listener_connections_state "$watch_port")"
    if wait "$curl_runner_pid"; then curl_exit_code=0; else curl_exit_code=$?; fi
    queue_after="$(listener_queue_state ":$watch_port")"
    connection_after="$(listener_connections_state "$watch_port")"
    log cdp.strace.overlap-curl "exit_code=$curl_exit_code result=$(cat "$curl_meta" 2>/dev/null | tr '\n' ' ' | cut -c1-240) stderr=$(tr '\n' ' ' <"$curl_stderr" 2>/dev/null | cut -c1-240) queue_before=$queue_before queue_during=$queue_during queue_after=$queue_after connections_before=$(printf '%q' "${connection_before:-none}") connections_during=$(printf '%q' "${connection_during:-none}") connections_after=$(printf '%q' "${connection_after:-none}")"
  elif [[ "$attach_ready" != no ]]; then
    log cdp.strace.overlap-curl.skipped reason=listener-not-present
  fi
  if wait "$strace_runner_pid"; then strace_exit_code=0; else strace_exit_code=$?; fi
  trace_bytes="$(wc -c <"$trace_file" 2>/dev/null | tr -d ' ' || printf 0)"
  trace_lines="$(wc -l <"$trace_file" 2>/dev/null | tr -d ' ' || printf 0)"
  accept_count="$(grep -Ec '(^|[[:space:]])accept4?\(' "$trace_file" 2>/dev/null || true)"
  read_count="$(grep -Ec '(^|[[:space:]])(read|recvfrom|recvmsg)\(' "$trace_file" 2>/dev/null || true)"
  write_count="$(grep -Ec '(^|[[:space:]])(write|sendto|sendmsg)\(' "$trace_file" 2>/dev/null || true)"
  futex_count="$(grep -Ec '(^|[[:space:]])futex(_waitv)?\(' "$trace_file" 2>/dev/null || true)"
  open_count="$(grep -Ec '(^|[[:space:]])(openat|openat2)\(' "$trace_file" 2>/dev/null || true)"
  poll_count="$(grep -Ec '(^|[[:space:]])(poll|ppoll|epoll_wait|epoll_pwait|select|pselect6)\(' "$trace_file" 2>/dev/null || true)"
  trace_socket_threads="$(grep -E 'TCP:\[127\.0\.0\.1:9222|accept4?\(' "$trace_file" 2>/dev/null | awk '{print $1}' | sort -nu | tr '\n' ',' | cut -c1-240 || true)"
  log cdp.strace.complete "trigger=$trace_mode target_pid=$trace_target_pid traced_process_pids=${trace_process_pids:-none} traced_process_count=$trace_process_count target_task_count=$task_count attached_count=${attached_count:-0} exit_code=$strace_exit_code bytes=${trace_bytes:-0} lines=${trace_lines:-0} accepts=${accept_count:-0} reads=${read_count:-0} writes=${write_count:-0} futexes=${futex_count:-0} opens=${open_count:-0} socket_thread_ids=${trace_socket_threads:-none} stderr=$(tr '\n' ' ' <"$trace_stderr" 2>/dev/null | cut -c1-240)"
  log cdp.strace.polls "count=$poll_count"
  for trace_thread_id in $(printf '%s' "$trace_socket_threads" | tr ',' ' '); do
    [[ "$trace_thread_id" =~ ^[0-9]+$ ]] || continue
    thread_owner_pid=unknown
    thread_proc_root="/proc/$trace_thread_id"
    for candidate_pid in "${chrome_attach_pids[@]}"; do
      if [[ -r "/proc/$candidate_pid/task/$trace_thread_id/comm" ]]; then
        thread_owner_pid="$candidate_pid"
        thread_proc_root="/proc/$candidate_pid/task/$trace_thread_id"
        break
      fi
    done
    accepted_comm="$(cat "$thread_proc_root/comm" 2>/dev/null | tr -d '\n' | cut -c1-50 || true)"
    accepted_state="$(awk '/^State:/ {print $2}' "$thread_proc_root/status" 2>/dev/null || true)"
    accepted_wchan="$(timeout --kill-after=1s 2s cat "$thread_proc_root/wchan" 2>/dev/null | cut -c1-80 || true)"
    accepted_syscall="$(timeout --kill-after=1s 2s cat "$thread_proc_root/syscall" 2>&1 | cut -c1-140 || true)"
    log cdp.strace.thread "owner_pid=$thread_owner_pid tid=$trace_thread_id comm=${accepted_comm:-unknown} state=${accepted_state:-unknown} wchan=${accepted_wchan:-unknown} syscall=${accepted_syscall:-unavailable}"
  done
  if [[ -s "$trace_file" ]]; then
    grep -E 'TCP:\[127\.0\.0\.1:9222|accept4?\(|connect\(|bind\(|listen\(' "$trace_file" \
      | tail -n 100 \
      | sed -E 's#ws://[^"[:space:]]+#ws://[redacted]#g; s#(/devtools/browser/)[0-9a-fA-F-]+#\1[redacted]#g' \
      | while IFS= read -r line; do log cdp.strace.socket "$(printf '%q' "$line")"; done || true
    grep -E 'openat2?\(' "$trace_file" \
      | tail -n 12 \
      | while IFS= read -r line; do log cdp.strace.open "$(printf '%q' "$line")"; done || true
    awk '
      / <[0-9]+(\.[0-9]+)?>$/ {
        duration=$NF
        gsub(/[<>]/, "", duration)
        if ((duration + 0) >= 0.01) print
      }
    ' "$trace_file" | tail -n 30 | cut -c1-520 \
      | while IFS= read -r line; do log cdp.strace.slow "$(printf '%q' "$line")"; done || true
    grep -E '(read|readv|pread64|write|writev|pwrite64|recvfrom|recvmsg|sendto|sendmsg|poll|ppoll|epoll_wait|epoll_pwait|select|pselect6|futex)\(' "$trace_file" \
      | tail -n 24 \
      | cut -c1-520 \
      | while IFS= read -r line; do log cdp.strace.io "$(printf '%q' "$line")"; done || true
    grep -E 'openat2?\(|connect\(|bind\(|listen\(|accept4?\(' "$trace_file" \
      | grep -E '= -1 (E[A-Z]+)' \
      | tail -n 20 \
      | sed -E 's#ws://[^"[:space:]]+#ws://[redacted]#g; s#(/devtools/browser/)[0-9a-fA-F-]+#\1[redacted]#g' \
      | while IFS= read -r line; do log cdp.strace.error "$(printf '%q' "$line")"; done || true
  fi
}

log cdp.check.start port=9222
watch_port=9222
strace_attempted=0
listener=none
if command -v ss >/dev/null 2>&1; then
  listener="$(ss -lntp 2>/dev/null | awk '$4 ~ /:9222$/ {print; found=1} END {if (!found) print "none"}' | cut -c1-360 | tr '\n' ';' || true)"
  log cdp.listener "$listener"
fi
probe_http 'http://127.0.0.1:9222/json/version' /tmp/csa-chrome-thread-diag-cdp.out initial
curl_status="$http_probe_exit"
log cdp.http "exit_code=$http_probe_exit result=$(printf '%q' "$http_probe_meta") stderr=$(printf '%q' "$http_probe_error")"
if [[ -s /tmp/csa-chrome-thread-diag-cdp.out ]]; then
  body="$(head -c 500 /tmp/csa-chrome-thread-diag-cdp.out | sed -E 's#(ws://[^/]+/devtools/browser/)[A-Za-z0-9_-]+#\1[redacted]#g')"
  log cdp.body "body=$(printf '%q' "$body")"
fi
if [[ "$strace_sample" == 1 && "$strace_after_listener" != 1 && "$strace_main_thread_only" == 1 && "$chrome_pid" =~ ^[0-9]+$ && -r "/proc/$chrome_pid/status" ]]; then
  log cdp.strace.startup.trigger "reason=bounded-chrome-browser-main-thread-filesystem-sample pid=$chrome_pid listener=$listener"
  capture_cdp_strace chrome-browser-main-thread-filesystem-startup
elif [[ "$strace_sample" == 1 && "$strace_after_listener" != 1 && "$listener" == none* && "$chrome_pid" =~ ^[0-9]+$ && -r "/proc/$chrome_pid/status" ]]; then
  log cdp.strace.startup.trigger "reason=chrome-present-without-cdp-listener pid=$chrome_pid"
  capture_cdp_strace chrome-startup-no-listener
fi
if ((cdp_watch_seconds > 0)); then
  log cdp.watch.start "seconds=$cdp_watch_seconds requested_port=9222 interval_seconds=10 route_matrix_only=$route_matrix_only"
  watch_started=$SECONDS
  watch_sample=0
  watch_status=timeout
  cdp_thread_sampled=0
  unmatched_route_sampled=0
  while ((SECONDS - watch_started < cdp_watch_seconds)); do
    watch_sample=$((watch_sample + 1))
    banner_authority="$(sed -nE 's#.*DevTools listening on ws://([^/[:space:]]+).*#\1#p' /tmp/csa-chromium.log 2>/dev/null | tail -n 1 || true)"
    banner_port="${banner_authority##*:}"
    watch_port=9222
    if [[ "$banner_port" =~ ^[0-9]+$ ]] && ((banner_port > 0 && banner_port <= 65535)); then
      watch_port="$banner_port"
    fi
    listener_details="$(ss -H -lnt 2>/dev/null | awk -v suffix=":$watch_port" 'index($4, suffix) {printf "local=%s recv_queue=%s backlog=%s;", $4, $2, $3}' || true)"
    listener_process_details="$(ss -H -lntp 2>/dev/null | awk -v suffix=":$watch_port" 'index($4, suffix) {print; found=1; if (++count >= 3) exit} END {if (!found) print "none"}' | tr '\n' ';' | cut -c1-720 || true)"
    listener_addresses="$(printf '%s\n' "$listener_details" | sed -nE 's/.*local=([^ ;]+).*/\1/p' | sort -u | tr '\n' ',' || true)"
    unmatched_route=not-run
    unmatched_route_exit=not-run
    unmatched_route_error=none
    if [[ -n "$listener_addresses" && "$unmatched_route_sampled" == 0 ]]; then
      probe_http "http://127.0.0.1:$watch_port/__csa_diagnostic_unmatched" /dev/null "watch-unmatched-route-$watch_sample" 3
      unmatched_route="$http_probe_meta"
      unmatched_route_exit="$http_probe_exit"
      unmatched_route_error="$http_probe_error"
      unmatched_route_sampled=1
      log cdp.unmatched-route.probe "index=$watch_sample elapsed_seconds=$((SECONDS - watch_started)) port=$watch_port result=$(printf '%q' "${unmatched_route:-empty}") exit_code=${unmatched_route_exit:-unknown} stderr=$(printf '%q' "${unmatched_route_error:-none}")"
      route_matrix_done=1
      if [[ "$route_matrix_only" == 1 ]]; then
        probe_http "http://127.0.0.1:$watch_port/" /dev/null "watch-root-route-$watch_sample" 3
        log cdp.root-route.probe "index=$watch_sample elapsed_seconds=$((SECONDS - watch_started)) port=$watch_port result=$(printf '%q' "${http_probe_meta:-empty}") exit_code=${http_probe_exit:-unknown} stderr=$(printf '%q' "${http_probe_error:-none}")"
        probe_http "http://127.0.0.1:$watch_port/json/__csa_diagnostic_missing" /dev/null "watch-json-unknown-route-$watch_sample" 3
        log cdp.json-unknown-route.probe "index=$watch_sample elapsed_seconds=$((SECONDS - watch_started)) port=$watch_port result=$(printf '%q' "${http_probe_meta:-empty}") exit_code=${http_probe_exit:-unknown} stderr=$(printf '%q' "${http_probe_error:-none}")"
      fi
    fi
    probe_http "http://127.0.0.1:$watch_port/json/version" /dev/null "watch-v4-$watch_sample"
    http_v4="$http_probe_meta"
    http_v4_exit="$http_probe_exit"
    http_v4_error="$http_probe_error"
    http_v6=skipped
    http_v6_exit=skipped
    http_v6_error=none
    if [[ "$http_v4" != http_code=200* ]]; then
      probe_http "http://[::1]:$watch_port/json/version" /dev/null "watch-v6-$watch_sample"
      http_v6="$http_probe_meta"
      http_v6_exit="$http_probe_exit"
      http_v6_error="$http_probe_error"
    fi
    if [[ ! "$chrome_pid" =~ ^[0-9]+$ ]] || [[ ! -r "/proc/$chrome_pid/status" ]]; then
      chrome_pid=
      chrome_candidates="$(find_chrome_browser_pids || true)"
      chrome_pid="$(head -n 1 <<<"$chrome_candidates" | tr -d '\r')"
    fi
    process_state=missing
    process_rss_kb=unknown
    process_ticks=unknown
    if [[ "$chrome_pid" =~ ^[0-9]+$ ]] && [[ -r "/proc/$chrome_pid/status" ]]; then
      process_state="$(awk '/^State:/ {print $2}' "/proc/$chrome_pid/status" 2>/dev/null || true)"
      process_rss_kb="$(awk '/^VmRSS:/ {print $2}' "/proc/$chrome_pid/status" 2>/dev/null || true)"
      process_ticks="$(awk '{sub(/^.*\) /, ""); print $12 + $13}' "/proc/$chrome_pid/stat" 2>/dev/null || true)"
    else
      chrome_pid=
    fi
    log cdp.watch.sample "index=$watch_sample elapsed_seconds=$((SECONDS - watch_started)) banner_authority=${banner_authority:-missing} probe_port=$watch_port listener_addresses=${listener_addresses:-none} listener_details=${listener_details:-none} listener_process_details=$(printf '%q' "${listener_process_details:-none}") http_v4=$(printf '%q' "${http_v4:-empty}") http_v4_exit=${http_v4_exit:-unknown} http_v4_error=$(printf '%q' "${http_v4_error:-none}") http_v6=$(printf '%q' "${http_v6:-empty}") http_v6_exit=${http_v6_exit:-unknown} http_v6_error=$(printf '%q' "${http_v6_error:-none}") chrome_pid=${chrome_pid:-missing} chrome_state=${process_state:-missing} chrome_rss_kb=${process_rss_kb:-unknown} chrome_cpu_ticks=${process_ticks:-unknown}"
    if [[ "$http_v4" == http_code=200* || "$http_v6" == http_code=200* ]]; then
      watch_status=ready
      break
    fi
    if [[ "$route_matrix_only" == 1 && "${route_matrix_done:-0}" == 1 ]]; then
      watch_status=route-matrix-complete
      break
    fi
    if [[ -n "$listener_addresses" && "$thread_sample" == 1 && "$cdp_thread_sampled" == 0 ]]; then
      if declare -F capture_listener_thread_sample >/dev/null; then
        capture_listener_thread_sample cdp-listener
      else
        log cdp.thread_cpu.skipped "reason=chrome-not-present-at-initial-sample pid=${chrome_pid:-missing}"
      fi
      cdp_thread_sampled=1
    fi
    if [[ -n "$listener_addresses" && "$strace_attempted" == 0 ]]; then
      capture_cdp_strace
    fi
    sleep 10
  done
  log cdp.watch.complete "status=$watch_status samples=$watch_sample elapsed_seconds=$((SECONDS - watch_started))"
fi
grep -E '^(ERROR|FATAL|WARNING):|DevTools listening' /tmp/csa-chromium.log 2>/dev/null \
  | sed -E 's#.*DevTools listening on ws://([^/[:space:]]+).*#DevTools listening authority=\1#' \
  | tail -n 12 | while IFS= read -r line; do log chrome.log "$(printf '%q' "$line")"; done || true
grep -E 'system-dbus\.(ready|launch|failed|unresponsive)|chrome\.(started|startup.failed)|desktop\.ready' /var/lib/csa-desktop/bootstrap.log 2>/dev/null \
  | tail -n 20 | while IFS= read -r line; do log bootstrap.log "$(printf '%q' "$line")"; done || true
if [[ "$trace_startup" == 1 ]]; then
  trace_file=/tmp/csa-chromium-startup-trace.json
  log cdp.trace.wait.start "file=$trace_file max_seconds=75"
  for trace_wait_attempt in $(seq 1 75); do
    [[ -s "$trace_file" ]] && break
    sleep 1
  done
  if [[ -s "$trace_file" ]]; then
    log cdp.trace.wait.complete "present=1 bytes=$(stat -c %s "$trace_file" 2>/dev/null || wc -c <"$trace_file" | tr -d ' ') sha256=$(sha256sum "$trace_file" | awk '{print $1}')"
  else
    log cdp.trace.wait.complete "present=0 waited_seconds=75"
  fi
fi
log sequence.complete "chrome_pid=${chrome_pid:-missing} cdp_exit_code=${curl_status:-0} strace_attempted=${strace_attempted:-0}"
