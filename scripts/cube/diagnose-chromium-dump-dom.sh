#!/usr/bin/env bash
set -Eeuo pipefail

desktop_user="${CSA_DIAGNOSTIC_USER:-user}"
desktop_uid="$(id -u "$desktop_user" 2>/dev/null || true)"
desktop_group="$(id -gn "$desktop_user" 2>/dev/null || true)"
desktop_gid="$(id -g "$desktop_user" 2>/dev/null || true)"
chrome_bin="${CSA_CHROMIUM_BIN:-/opt/google/chrome/chrome}"
dump_dom_url="${CSA_CHROMIUM_DUMP_DOM_URL:-about:blank}"
timeout_seconds="${CSA_CHROMIUM_DUMP_DOM_TIMEOUT_SECONDS:-30}"
sample_delay_seconds="${CSA_CHROMIUM_DUMP_DOM_SAMPLE_DELAY_SECONDS:-5}"
sample_gap_seconds="${CSA_CHROMIUM_DUMP_DOM_SAMPLE_GAP_SECONDS:-3}"
sample_stacks_enabled="${CSA_CHROMIUM_DUMP_DOM_SAMPLE_STACKS:-1}"
identity_sample_enabled="${CSA_CHROMIUM_DUMP_DOM_IDENTITY_SAMPLE:-1}"
no_zygote_enabled="${CSA_CHROMIUM_NO_ZYGOTE:-0}"
no_sandbox_enabled="${CSA_CHROMIUM_NO_SANDBOX:-1}"
gdb_sample_enabled="${CSA_CHROMIUM_GDB_SAMPLE:-0}"
gdb_timeout_seconds="${CSA_CHROMIUM_GDB_TIMEOUT_SECONDS:-20}"
strace_sample_enabled="${CSA_CHROMIUM_STRACE_SAMPLE:-0}"
strace_timeout_seconds="${CSA_CHROMIUM_STRACE_TIMEOUT_SECONDS:-4}"
tag="${CSA_CHROMIUM_DIAGNOSTIC_TAG:-$(date -u +%Y%m%dT%H%M%SZ)-$$}"
diag_dir="/tmp/csa-chrome-dump-$tag"
profile_dir="$diag_dir/profile"
home_dir="$diag_dir/home"
cache_dir="$diag_dir/cache"
chrome_log="$diag_dir/chrome.log"
smoke_exit=0

log() {
  printf 'chromium.dump-dom timestamp=%s stage=%s %s\n' "$(date -u +%FT%TZ)" "$1" "${*:2}"
}

cleanup() {
  local exit_status=$?
  trap - EXIT
  local live_pids
  live_pids="$(ps -eo pid=,stat=,comm=,args= | awk -v user_data="--user-data-dir=$profile_dir" '($3 == "chrome" || $3 == "chrome_crashpad") && index($0, user_data) && $2 !~ /Z|X/ {print $1}')"
  if [[ -n "$live_pids" ]]; then
    log cleanup.term "pids=$(printf '%s' "$live_pids" | tr '\n' ',')"
    kill -TERM $live_pids 2>/dev/null || true
    sleep 1
    live_pids="$(ps -eo pid=,stat=,comm=,args= | awk -v user_data="--user-data-dir=$profile_dir" '($3 == "chrome" || $3 == "chrome_crashpad") && index($0, user_data) && $2 !~ /Z|X/ {print $1}')"
    if [[ -n "$live_pids" ]]; then
      kill -KILL $live_pids 2>/dev/null || true
      for attempt in $(seq 1 10); do
        sleep 0.2
        live_pids="$(ps -eo pid=,stat=,comm=,args= | awk -v user_data="--user-data-dir=$profile_dir" '($3 == "chrome" || $3 == "chrome_crashpad") && index($0, user_data) && $2 !~ /Z|X/ {print $1}')"
        [[ -n "$live_pids" ]] || break
      done
    fi
  fi
  if [[ -n "$live_pids" ]]; then
    log cleanup.failed "remaining_chrome_pids=$(printf '%s' "$live_pids" | tr '\n' ',') guest_exit_code=$exit_status"
  else
    for path in "$profile_dir" "$home_dir" "$cache_dir"; do
      if [[ -d "$path" ]]; then find "$path" -depth -delete; fi
    done
    log cleanup.complete "remaining_chrome_pids=none guest_exit_code=$exit_status"
  fi
  log sequence.complete "exit_code=$exit_status directory=$diag_dir"
}
trap cleanup EXIT

if [[ ! "$desktop_uid" =~ ^[0-9]+$ || ! "$desktop_gid" =~ ^[0-9]+$ || -z "$desktop_group" ]]; then
  log preflight.failed "reason=desktop-user-not-found user=$desktop_user"
  exit 2
fi
if [[ ! -x "$chrome_bin" ]]; then log preflight.failed "reason=chrome-missing binary=$chrome_bin"; exit 2; fi
if [[ "$dump_dom_url" != about:blank && "$dump_dom_url" != data:text/html,CSA_RENDER_PROBE ]]; then
  log preflight.failed "reason=invalid-dump-dom-url"
  exit 2
fi
if [[ ! "$timeout_seconds" =~ ^[0-9]+$ ]] || ((timeout_seconds < 10 || timeout_seconds > 45)); then
  log preflight.failed "reason=invalid-timeout seconds=$timeout_seconds expected=10..45"
  exit 2
fi
if [[ ! "$sample_delay_seconds" =~ ^[0-9]+$ ]] || ((sample_delay_seconds < 5 || sample_delay_seconds > 15)); then
  log preflight.failed "reason=invalid-sample-delay seconds=$sample_delay_seconds expected=5..15"
  exit 2
fi
if [[ ! "$sample_gap_seconds" =~ ^[0-9]+$ ]] || ((sample_gap_seconds < 3 || sample_gap_seconds > 10 || sample_delay_seconds + sample_gap_seconds >= timeout_seconds - 2)); then
  log preflight.failed "reason=invalid-sample-gap seconds=$sample_gap_seconds timeout_seconds=$timeout_seconds"
  exit 2
fi
if [[ "$gdb_sample_enabled" != 0 && "$gdb_sample_enabled" != 1 ]]; then
  log preflight.failed "reason=invalid-gdb-sample-flag value=$gdb_sample_enabled"
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
if [[ "$strace_sample_enabled" != 0 && "$strace_sample_enabled" != 1 ]]; then
  log preflight.failed "reason=invalid-strace-sample-flag value=$strace_sample_enabled"
  exit 2
fi
if [[ ! "$strace_timeout_seconds" =~ ^[0-9]+$ ]] || ((strace_timeout_seconds < 2 || strace_timeout_seconds > 8)); then
  log preflight.failed "reason=invalid-strace-timeout seconds=$strace_timeout_seconds expected=2..8"
  exit 2
fi
if [[ "$strace_sample_enabled" == 1 ]] && ! command -v strace >/dev/null 2>&1; then
  log preflight.failed "reason=strace-missing enabled=$strace_sample_enabled"
  exit 2
fi
if [[ "$strace_sample_enabled" == 1 && "$gdb_sample_enabled" == 1 ]]; then
  log preflight.failed "reason=multiple-ptrace-samplers-enabled"
  exit 2
fi
if [[ "$sample_stacks_enabled" != 0 && "$sample_stacks_enabled" != 1 ]]; then
  log preflight.failed "reason=invalid-stack-sample-flag value=$sample_stacks_enabled"
  exit 2
fi
if [[ "$identity_sample_enabled" != 0 && "$identity_sample_enabled" != 1 ]]; then
  log preflight.failed "reason=invalid-identity-sample-flag value=$identity_sample_enabled"
  exit 2
fi
if [[ "$no_zygote_enabled" != 0 && "$no_zygote_enabled" != 1 ]]; then
  log preflight.failed "reason=invalid-no-zygote-flag value=$no_zygote_enabled"
  exit 2
fi
if [[ "$no_sandbox_enabled" != 0 && "$no_sandbox_enabled" != 1 ]]; then
  log preflight.failed "reason=invalid-no-sandbox-flag value=$no_sandbox_enabled"
  exit 2
fi
available_kb="$(df -Pk / | awk 'NR == 2 {print $4}')"
if [[ ! "$available_kb" =~ ^[0-9]+$ ]] || ((available_kb < 524288)); then
  log preflight.failed "reason=disk-below-512MiB available_kb=$available_kb"
  exit 2
fi
if [[ -e "$diag_dir" ]]; then log preflight.failed "reason=diagnostic-directory-exists directory=$diag_dir"; exit 3; fi

mkdir -m 0700 "$diag_dir"
chown "$desktop_user:$desktop_group" "$diag_dir"
install -d -o "$desktop_user" -g "$desktop_group" -m 0700 "$profile_dir" "$home_dir" "$cache_dir"
chrome_args=(--headless=new --disable-gpu --disable-dev-shm-usage --no-first-run --no-default-browser-check --password-store=basic --enable-logging=stderr "--user-data-dir=$profile_dir")
if [[ "$no_sandbox_enabled" == 1 ]]; then chrome_args+=(--no-sandbox); fi
if [[ "$no_zygote_enabled" == 1 ]]; then chrome_args+=(--no-zygote); fi
chrome_args+=(--dump-dom "$dump_dom_url")
exec > >(tee -a "$diag_dir/run.log") 2>&1
log preflight.ready "user=$desktop_user uid=$desktop_uid binary=$chrome_bin disk_available_kb=$available_kb dbus_session=enabled display_env=unset no_zygote=$no_zygote_enabled no_sandbox=$no_sandbox_enabled sample_stacks=$sample_stacks_enabled identity_sample=$identity_sample_enabled"
"$chrome_bin" --version 2>&1 | tee "$diag_dir/chromium-version.txt"
log chrome.dump.start "profile=$profile_dir url=$dump_dom_url timeout_seconds=$timeout_seconds remote_debugging=disabled no_zygote=$no_zygote_enabled no_sandbox=$no_sandbox_enabled"
timeout --signal=TERM --kill-after=2s "${timeout_seconds}s" \
  runuser -u "$desktop_user" -- dbus-run-session -- \
  env -u DISPLAY HOME="$home_dir" XDG_CACHE_HOME="$cache_dir" \
  "$chrome_bin" "${chrome_args[@]}" \
  >"$chrome_log" 2>&1 &
smoke_timeout_pid=$!

snapshot_chrome_threads() {
  local label="$1"
  local output="$diag_dir/threads-$label.tsv"
  local pid thread_count state wchan syscall tid comm stat_values ticks stack chrome_types loadavg pressure_resource pressure_path pressure_values cpu_cgroup
  : >"$output"
  local chrome_pids
  chrome_pids="$(ps -eo pid=,comm=,args= | awk -v user_data="--user-data-dir=$profile_dir" '$2 == "chrome" && index($0, user_data) {print $1}')"
  if [[ -z "$chrome_pids" ]]; then log chrome.dump.sample.empty "label=$label"; return 0; fi
  chrome_types="$(ps -eo pid=,comm=,args= | awk -v user_data="--user-data-dir=$profile_dir" '$2 == "chrome" && index($0, user_data) {type="browser"; if (match($0, /--type=[^ ]+/)) type=substr($0, RSTART + 7, RLENGTH - 7); printf "%s:%s,", $1, type}' | cut -c1-1200)"
  log chrome.dump.processes "label=$label members=$chrome_types"
  loadavg="$(tr ' ' ',' </proc/loadavg 2>/dev/null || printf unknown)"
  log chrome.dump.scheduler "label=$label loadavg=$loadavg"
  for pressure_resource in cpu memory io; do
    pressure_path="/proc/pressure/$pressure_resource"
    if [[ -r "$pressure_path" ]]; then
      pressure_values="$(awk '{printf "%s:%s:%s:%s", $1, $2, $3, $4; if (NR > 1) printf ";"}' "$pressure_path" | tr ' ' ',')"
      log chrome.dump.pressure "label=$label resource=$pressure_resource values=$pressure_values"
    fi
  done
  if [[ -r /sys/fs/cgroup/cpu.stat ]]; then
    cpu_cgroup="$(awk '$1 ~ /^(usage_usec|user_usec|system_usec|nr_periods|nr_throttled|throttled_usec)$/ {printf "%s:%s,", $1, $2}' /sys/fs/cgroup/cpu.stat)"
    log chrome.dump.cgroup "label=$label cpu=$cpu_cgroup cpu_max=$(cat /sys/fs/cgroup/cpu.max 2>/dev/null || printf unknown)"
  fi
  if [[ -r /sys/fs/cgroup/memory.current ]]; then
    log chrome.dump.cgroup "label=$label memory_current=$(cat /sys/fs/cgroup/memory.current) memory_max=$(cat /sys/fs/cgroup/memory.max 2>/dev/null || printf unknown)"
  fi
  while IFS= read -r pid; do
    [[ "$pid" =~ ^[0-9]+$ ]] || continue
    if [[ ! -d "/proc/$pid/task" ]]; then
      log chrome.dump.process.exit-race "label=$label pid=$pid"
      continue
    fi
    thread_count="$(find "/proc/$pid/task" -mindepth 1 -maxdepth 1 -type d 2>/dev/null | wc -l | tr -d ' ')" || thread_count=0
    state="$(awk '/^State:/ {print $2}' "/proc/$pid/status" 2>/dev/null || printf unknown)"
    wchan="$(cat "/proc/$pid/wchan" 2>/dev/null || printf unknown)"
    syscall="$({ cat "/proc/$pid/syscall" 2>/dev/null || true; } | tr ' ' '_')"
    log chrome.dump.sample "label=$label pid=$pid threads=$thread_count state=$state wchan=$wchan syscall=$syscall"
    for task_dir in "/proc/$pid/task/"*; do
      [[ -r "$task_dir/stat" ]] || continue
      tid="${task_dir##*/}"
      comm="$(cat "$task_dir/comm" 2>/dev/null || printf unknown)"
      stat_values="$(awk '{sub(/^.*\) /, ""); print $1, $12 + $13}' "$task_dir/stat" 2>/dev/null || true)"
      read -r state ticks <<<"$stat_values"
      [[ "$ticks" =~ ^[0-9]+$ ]] || continue
      printf '%s\t%s\t%s\t%s\t%s\n' "$pid" "$tid" "$comm" "${state:-?}" "$ticks" >>"$output"
    done
    if [[ "$sample_stacks_enabled" == 1 ]]; then for tid in "$pid" $(ps -L -p "$pid" -o tid=,pcpu= | sort -nr -k2,2 | head -n 2 | awk '{print $1}'); do
      [[ -r "/proc/$pid/task/$tid/comm" ]] || continue
      comm="$(cat "/proc/$pid/task/$tid/comm" 2>/dev/null || printf unknown)"
      state="$(awk '{sub(/^.*\) /, ""); print $1}' "/proc/$pid/task/$tid/stat" 2>/dev/null || printf unknown)"
      wchan="$(cat "/proc/$pid/task/$tid/wchan" 2>/dev/null || printf unknown)"
      syscall="$(cat "/proc/$pid/task/$tid/syscall" 2>&1 | tr ' ' '_')"
      stack="$(timeout --signal=TERM --kill-after=1s 1s cat "/proc/$pid/task/$tid/stack" 2>&1 | tr '\n' ';' | cut -c1-360 || true)"
      log chrome.dump.thread "label=$label pid=$pid tid=$tid comm=$comm state=$state wchan=$wchan syscall=$syscall kernel_stack=$stack"
    done; fi
  done <<<"$chrome_pids"
}

find_main_chrome_pid() {
  ps -eo pid=,comm=,args= | awk -v user_data="--user-data-dir=$profile_dir" '$2 == "chrome" && index($0, user_data) && $0 !~ /--type=/ {print $1}' | head -n 1
}

snapshot_chrome_identity() {
  local label="$1" pid status_fields namespace_fields uid_map gid_map security_label proc_access cmdline setpriv_bin proc_mem_access
  pid="$(find_main_chrome_pid)"
  if [[ ! "$pid" =~ ^[0-9]+$ || ! -r "/proc/$pid/status" ]]; then
    log chrome.dump.identity.empty "label=$label"
    return 0
  fi
  status_fields="$(awk '/^(Name|State|Tgid|Pid|PPid|TracerPid|Uid|Gid|NSpid|CapInh|CapPrm|CapEff|CapBnd|NoNewPrivs|Seccomp|Seccomp_filters):/ {gsub(/[[:space:]]+/, "_"); print}' "/proc/$pid/status" | paste -sd ';' -)"
  namespace_fields="self_user=$(readlink /proc/self/ns/user 2>/dev/null || printf unknown),chrome_user=$(readlink "/proc/$pid/ns/user" 2>/dev/null || printf unknown),self_pid=$(readlink /proc/self/ns/pid 2>/dev/null || printf unknown),chrome_pid=$(readlink "/proc/$pid/ns/pid" 2>/dev/null || printf unknown),self_mnt=$(readlink /proc/self/ns/mnt 2>/dev/null || printf unknown),chrome_mnt=$(readlink "/proc/$pid/ns/mnt" 2>/dev/null || printf unknown)"
  uid_map="$(tr '\n' ';' <"/proc/$pid/uid_map" 2>/dev/null || printf unreadable)"
  gid_map="$(tr '\n' ';' <"/proc/$pid/gid_map" 2>/dev/null || printf unreadable)"
  security_label="$(cat "/proc/$pid/attr/current" 2>/dev/null || printf unreadable)"
  proc_access="$(for proc_file in mem maps; do stat -c "$proc_file=%A,%a,%u:%g" "/proc/$pid/$proc_file" 2>&1 || true; done | paste -sd ';' -)"
  setpriv_bin="$(command -v setpriv || true)"
  proc_mem_access=unknown
  if [[ -n "$setpriv_bin" ]] && "$setpriv_bin" --reuid="$desktop_uid" --regid="$desktop_gid" --clear-groups -- /bin/bash -c 'exec 3<"$1"' _ "/proc/$pid/mem" >/dev/null 2>&1; then
    proc_mem_access=allowed
  elif [[ -n "$setpriv_bin" ]]; then
    proc_mem_access=denied
  fi
  cmdline="$(tr '\0' ' ' <"/proc/$pid/cmdline" 2>/dev/null | cut -c1-360)"
  log chrome.dump.identity "label=$label pid=$pid status=$status_fields namespaces=$namespace_fields uid_map=$uid_map gid_map=$gid_map security_label=$security_label proc_access=$proc_access same_uid_proc_mem_open=$proc_mem_access cmdline=$cmdline"
}

sample_chrome_main_stack() {
  local pid="$1" stack_log="$diag_dir/gdb-main-thread.log" gdb_exit=0
  log chrome.dump.gdb.start "pid=$pid timeout_seconds=$gdb_timeout_seconds"
  DEBUGINFOD_URLS= DEBUGINFOD_PROGRESS=0 timeout --signal=INT --kill-after=2s "${gdb_timeout_seconds}s" \
    gdb --nx --quiet --batch \
    -iex 'set debuginfod enabled off' \
    -iex 'set auto-load python-scripts off' \
    -iex 'set auto-solib-add off' \
    -iex 'set print thread-events off' \
    -p "$pid" \
    -ex 'set pagination off' -ex 'set confirm off' \
    -ex 'info threads' -ex 'thread 1' -ex 'bt 12' -ex 'thread apply all bt 4' -ex 'detach' -ex 'quit' \
    >"$stack_log" 2>&1 || gdb_exit=$?
  log chrome.dump.gdb.result "pid=$pid exit_code=$gdb_exit bytes=$(wc -c <"$stack_log" | tr -d ' ')"
  sed -n '1,200p' "$stack_log" | while IFS= read -r line; do log chrome.dump.gdb.line "${line:0:360}"; done
}

sample_chrome_main_syscalls() {
  local pid="$1" trace_log="$diag_dir/strace-main.log" stderr_log="$diag_dir/strace-main.stderr" trace_exit=0 setpriv_bin thread_count
  if [[ ! -d "$diag_dir" ]]; then log chrome.dump.strace.failed "reason=diagnostic-directory-missing directory=$diag_dir"; return 0; fi
  setpriv_bin="$(command -v setpriv || true)"
  if [[ -z "$setpriv_bin" ]]; then log chrome.dump.strace.failed "reason=setpriv-missing"; return 0; fi
  : >"$trace_log"
  : >"$stderr_log"
  chown "$desktop_user:$desktop_group" "$trace_log"
  thread_count="$(find "/proc/$pid/task" -mindepth 1 -maxdepth 1 -type d 2>/dev/null | wc -l | tr -d ' ')"
  log chrome.dump.strace.start "pid=$pid threads=$thread_count timeout_seconds=$strace_timeout_seconds scope=chrome-browser-process-and-threads tracer_uid=$desktop_uid"
  timeout --signal=INT --kill-after=2s "${strace_timeout_seconds}s" \
    "$setpriv_bin" --reuid="$desktop_uid" --regid="$desktop_gid" --clear-groups -- \
    strace -f -tt -T -s 96 -p "$pid" \
    -e trace=futex,epoll_wait,epoll_pwait,ppoll,poll,clock_nanosleep \
    -o "$trace_log" 2>"$stderr_log" || trace_exit=$?
  log chrome.dump.strace.result "pid=$pid exit_code=$trace_exit trace_bytes=$(wc -c <"$trace_log" | tr -d ' ') stderr_bytes=$(wc -c <"$stderr_log" | tr -d ' ')"
  sed -n '1,24p' "$stderr_log" | while IFS= read -r line; do log chrome.dump.strace.stderr "${line:0:360}"; done
  sed -n '1,32p' "$trace_log" | while IFS= read -r line; do log chrome.dump.strace.line "${line:0:360}"; done
}

sleep "$sample_delay_seconds"
cpu_snapshot_one_started_ns="$(date +%s%N)"
snapshot_chrome_threads one
if [[ "$strace_sample_enabled" == 1 ]]; then
  chrome_pid="$(find_main_chrome_pid)"
  if [[ "$chrome_pid" =~ ^[0-9]+$ ]]; then sample_chrome_main_syscalls "$chrome_pid"; else log chrome.dump.strace.skipped reason=chrome-process-not-found; fi
else
  sleep "$sample_gap_seconds"
fi
if [[ "$gdb_sample_enabled" == 1 ]]; then
  chrome_pid="$(find_main_chrome_pid)"
  if [[ "$chrome_pid" =~ ^[0-9]+$ ]]; then sample_chrome_main_stack "$chrome_pid"; else log chrome.dump.gdb.skipped reason=chrome-process-not-found; fi
fi
cpu_snapshot_two_started_ns="$(date +%s%N)"
snapshot_chrome_threads two
if [[ "$identity_sample_enabled" == 1 ]]; then snapshot_chrome_identity two; fi
if [[ -s "$diag_dir/threads-one.tsv" && -s "$diag_dir/threads-two.tsv" ]]; then
  cpu_snapshot_interval_ms=unknown
  if [[ "$cpu_snapshot_one_started_ns" =~ ^[0-9]+$ && "$cpu_snapshot_two_started_ns" =~ ^[0-9]+$ ]] && ((cpu_snapshot_two_started_ns >= cpu_snapshot_one_started_ns)); then
    cpu_snapshot_interval_ms=$(((cpu_snapshot_two_started_ns - cpu_snapshot_one_started_ns) / 1000000))
  fi
  awk -F '\t' 'NR==FNR {key=$1 ":" $2; ticks[key]=$5; comm[key]=$3; next} {key=$1 ":" $2; if (key in ticks && $5 >= ticks[key]) printf "%d\t%s\t%s\t%s\n", $5 - ticks[key], $1, $2, $3}' \
    "$diag_dir/threads-one.tsv" "$diag_dir/threads-two.tsv" | sort -nr -k1,1 | head -n 8 \
    | while IFS=$'\t' read -r delta pid tid comm; do log chrome.dump.thread.cpu "delta_ticks=$delta pid=$pid tid=$tid comm=$comm interval_ms=$cpu_snapshot_interval_ms configured_sleep_gap_seconds=$sample_gap_seconds"; done
fi
wait "$smoke_timeout_pid" || smoke_exit=$?

html_lines="$(grep -Eic '<html([[:space:]>])' "$chrome_log" 2>/dev/null || true)"
log chrome.dump.result "exit_code=$smoke_exit html_lines=${html_lines:-0} output_bytes=$(wc -c <"$chrome_log" | tr -d ' ')"
sed -n '1,12p' "$chrome_log" | while IFS= read -r line; do log chrome.dump.output "${line:0:360}"; done
if ((smoke_exit != 0)) || [[ ! "$html_lines" =~ ^[1-9][0-9]*$ ]]; then
  log chrome.dump.failed "reason=no-html exit_code=$smoke_exit"
  exit 7
fi
log chrome.dump.complete "result=html-rendered"
