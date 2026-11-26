#!/usr/bin/env bash
set +e

started_at="$(date -u +%FT%TZ)"
tag="$(date +%s)-$$"
diag_dir="/tmp/csa-chromium-diagnostic-$tag"
mkdir -p "$diag_dir"
desktop_user="$(getent passwd 1000 | cut -d: -f1)"
desktop_home=/workspace/.desktop-home
xvfb_pid=
profile="$diag_dir/direct-elf-profile"
chrome_log="$diag_dir/direct-elf.log"
trace_file="$desktop_home/.csa-chromium-startup-$tag.trace.json"
chrome_pid=
browser_pid=

log() { printf 'chromium.diag %s\n' "$*"; }

redact_devtools_urls() {
  sed -E 's#ws://[^"[:space:]]+#ws://[redacted]#g; s#(/devtools/browser/)[0-9a-fA-F-]+#\1[redacted]#g'
}

profile_pids() {
  ps -eo pid=,args= 2>/dev/null | awk -v needle="--user-data-dir=$profile" -v self="$$" '$1 != self && index($0, needle) && $0 !~ /awk -v needle=/ { print $1 }'
}

perf_record_is_running() {
  local stat_line state
  IFS= read -r stat_line <"/proc/$1/stat" 2>/dev/null || return 1
  stat_line="${stat_line##*) }"
  state="${stat_line%% *}"
  [[ -n "$state" && "$state" != *Z* && "$state" != *X* ]]
}

perf_record_state() {
  local pid="$1" stat_line proc_state proc_wchan proc_threads proc_ps data_bytes stdout_bytes stderr_bytes
  proc_state=absent
  proc_wchan=unavailable
  proc_threads=0
  if [[ -r "/proc/$pid/stat" ]]; then
    IFS= read -r stat_line <"/proc/$pid/stat" 2>/dev/null || stat_line=
    stat_line="${stat_line##*) }"
    proc_state="${stat_line%% *}"
    proc_wchan="$(cat "/proc/$pid/wchan" 2>/dev/null | cut -c1-80)"
    proc_threads="$(find "/proc/$pid/task" -mindepth 1 -maxdepth 1 -type d 2>/dev/null | wc -l | tr -d ' ')"
  fi
  proc_ps="$(ps -p "$pid" -o pid=,stat=,wchan=,etime=,%cpu=,comm= 2>/dev/null | tr '\n' ';' | cut -c1-240)"
  data_bytes="$(wc -c <"${perf_data:-/dev/null}" 2>/dev/null | tr -d ' ' || printf 0)"
  stdout_bytes="$(wc -c <"${perf_record_stdout:-/dev/null}" 2>/dev/null | tr -d ' ' || printf 0)"
  stderr_bytes="$(wc -c <"${perf_record_stderr:-/dev/null}" 2>/dev/null | tr -d ' ' || printf 0)"
  log "perf.record.process.sample pid=$pid running=$(perf_record_is_running "$pid" && printf yes || printf no) state=${proc_state:-unknown} wchan=${proc_wchan:-unknown} threads=${proc_threads:-unknown} ps=${proc_ps:-absent} data_bytes=$data_bytes stdout_bytes=$stdout_bytes stderr_bytes=$stderr_bytes"
}

cdp_listener_state() {
  local port_hex
  port_hex="$(printf '%04X' 19222)"
  if awk -v port="$port_hex" 'FNR > 1 { split($2, endpoint, ":"); if (toupper(endpoint[2]) == port && $4 == "0A") found = 1 } END { exit !found }' /proc/net/tcp /proc/net/tcp6 2>/dev/null; then
    printf present
  else
    printf absent
  fi
}

cdp_listener_queue_state() {
  local port_hex
  port_hex="$(printf '%04X' 19222)"
  awk -v port="$port_hex" 'FNR > 1 { split($2, endpoint, ":"); if (toupper(endpoint[2]) == port && $4 == "0A") { split($5, queues, ":"); printf "rx_queue_hex=%s tx_queue_hex=%s inode=%s", toupper(queues[2]), toupper(queues[1]), $10; found = 1 } } END { if (!found) printf "queue-unavailable" }' /proc/net/tcp /proc/net/tcp6 2>/dev/null
}

cdp_thread_tid_by_comm() {
  local requested_comm="$1" comm_file actual_comm
  [[ "$browser_pid" =~ ^[0-9]+$ && -d "/proc/$browser_pid/task" ]] || return 1
  for comm_file in "/proc/$browser_pid"/task/*/comm; do
    [[ -r "$comm_file" ]] || continue
    IFS= read -r actual_comm <"$comm_file" || actual_comm=
    if [[ "$actual_comm" == "$requested_comm" ]]; then
      comm_file="${comm_file%/comm}"
      printf '%s' "${comm_file##*/}"
      return 0
    fi
  done
  return 1
}

sample_chromium_thread() {
  local tid="$1" sample_comm sample_state sample_wchan sample_syscall sample_timestamp
  [[ "$tid" =~ ^[0-9]+$ ]] || return 1
  sample_comm="$(cat "/proc/$browser_pid/task/$tid/comm" 2>/dev/null | cut -c1-40)"
  sample_state="$(awk '/^State:/ { print $2 }' "/proc/$browser_pid/task/$tid/status" 2>/dev/null)"
  sample_wchan="$(timeout --kill-after=1s 2s cat "/proc/$browser_pid/task/$tid/wchan" 2>/dev/null | cut -c1-80)"
  sample_syscall="$(timeout --kill-after=1s 2s cat "/proc/$browser_pid/task/$tid/syscall" 2>&1 | cut -c1-180)"
  sample_timestamp="$(date +%s.%N 2>/dev/null || date +%s)"
  log "perf.overlap.thread-sample timestamp=$sample_timestamp tid=$tid comm=${sample_comm:-unknown} state=${sample_state:-unknown} wchan=${sample_wchan:-unknown} syscall=${sample_syscall:-unavailable}"
}

start_chromium_strace() {
  local target_pid="$1" attach_attempt
  perf_overlap_strace_trace="$diag_dir/perf-overlap-chromium-process.strace"
  perf_overlap_strace_stderr="$diag_dir/perf-overlap-chromium-process-strace.stderr"
  perf_overlap_strace_pid=
  if [[ "$strace_main" != 1 ]]; then
    log "perf.overlap.strace.skipped reason=disabled"
    return 1
  fi
  if [[ ! -x "$strace_binary" ]]; then
    log "perf.overlap.strace.skipped reason=not-installed pid=$target_pid"
    return 1
  fi
  timeout --signal=INT --kill-after=2s 30s "$strace_binary" -f -s 0 -tt -T -yy \
    -e trace=accept,accept4,connect,getsockopt,recvfrom,recvmsg,sendto,sendmsg,epoll_wait,epoll_pwait,read,write \
    -p "$target_pid" -o "$perf_overlap_strace_trace" 2>"$perf_overlap_strace_stderr" &
  perf_overlap_strace_pid=$!
  perf_overlap_strace_attached=no
  for attach_attempt in $(seq 1 40); do
    if grep -q 'Process .* attached' "$perf_overlap_strace_stderr" 2>/dev/null; then
      perf_overlap_strace_attached=yes
      break
    fi
    kill -0 "$perf_overlap_strace_pid" 2>/dev/null || break
    sleep 0.1
  done
  log "perf.overlap.strace.attach target=chromium-process pid=$target_pid tracer_pid=$perf_overlap_strace_pid status=$perf_overlap_strace_attached detail=$(tr '\n' ' ' <"$perf_overlap_strace_stderr" 2>/dev/null | cut -c1-180)"
  [[ "$perf_overlap_strace_attached" == yes ]]
}

finish_chromium_strace() {
  local target_pid="$1" exit_code trace_bytes accepts connects reads writes trace_lines
  [[ "${perf_overlap_strace_pid:-}" =~ ^[0-9]+$ ]] || return 0
  wait "$perf_overlap_strace_pid"
  exit_code=$?
  perf_overlap_strace_pid=
  trace_bytes="$(wc -c <"$perf_overlap_strace_trace" 2>/dev/null | tr -d ' ' || printf 0)"
  accepts="$(grep -Ec '(^|[[:space:]])accept4?\(' "$perf_overlap_strace_trace" 2>/dev/null || true)"
  connects="$(grep -Ec '(^|[[:space:]])connect\(' "$perf_overlap_strace_trace" 2>/dev/null || true)"
  reads="$(grep -Ec '(^|[[:space:]])(read|recvfrom|recvmsg)\(' "$perf_overlap_strace_trace" 2>/dev/null || true)"
  writes="$(grep -Ec '(^|[[:space:]])(write|sendto|sendmsg)\(' "$perf_overlap_strace_trace" 2>/dev/null || true)"
  trace_lines="$(wc -l <"$perf_overlap_strace_trace" 2>/dev/null | tr -d ' ' || printf 0)"
  log "perf.overlap.strace.result target=chromium-process pid=$target_pid exit_code=$exit_code bytes=${trace_bytes:-0} lines=${trace_lines:-0} accepts=${accepts:-0} connects=${connects:-0} reads=${reads:-0} writes=${writes:-0} stderr=$(tr '\n' ' ' <"$perf_overlap_strace_stderr" 2>/dev/null | cut -c1-180)"
  if [[ -s "$perf_overlap_strace_trace" ]]; then
    grep -E '19222|(^|[[:space:]])(accept4?|connect|recvfrom|recvmsg|sendto|sendmsg)\(' "$perf_overlap_strace_trace" \
      | head -n 100 \
      | redact_devtools_urls \
      | sed 's/^/chromium.diag perf.overlap.strace.trace /'
  fi
}

cdp_listener_owner_state() {
  local port_hex owner_line inodes inode pid fd_path target comm found
  port_hex="$(printf '%04X' 19222)"
  if command -v ss >/dev/null 2>&1; then
    owner_line="$(ss -H -ltnp 'sport = :19222' 2>&1 | head -n 3)"
    if [[ -n "$owner_line" ]]; then
      printf 'ss:%s' "$(printf '%s' "$owner_line" | tr '\n' ';' | cut -c1-500)"
      return
    fi
  fi
  inodes="$(awk -v port="$port_hex" 'FNR > 1 { split($2, endpoint, ":"); if (toupper(endpoint[2]) == port && $4 == "0A") print $10 }' /proc/net/tcp /proc/net/tcp6 2>/dev/null | sort -u)"
  if [[ -z "$inodes" ]]; then printf 'owner-unavailable:no-listener-inode'; return; fi
  found=0
  while IFS= read -r inode; do
    [[ "$inode" =~ ^[0-9]+$ ]] || continue
    while IFS= read -r pid; do
      [[ "$pid" =~ ^[0-9]+$ ]] || continue
      for fd_path in /proc/"$pid"/fd/*; do
        target="$(readlink "$fd_path" 2>/dev/null)"
        [[ "$target" == "socket:[$inode]" ]] || continue
        comm="$(cat "/proc/$pid/comm" 2>/dev/null | cut -c1-40)"
        printf 'pid=%s comm=%s fd=%s inode=%s;' "$pid" "${comm:-unknown}" "${fd_path##*/}" "$inode"
        found=1
        break
      done
    done < <(profile_pids)
  done <<<"$inodes"
  if ((found == 0)); then printf 'owner-unresolved:listener_inode=%s profile_pid_count=%s' "$(printf '%s' "$inodes" | tr '\n' ',')" "$(profile_pids | wc -l | tr -d ' ')"; fi
}

stop_chrome() {
  local pid
  while IFS= read -r pid; do
    [[ "$pid" =~ ^[0-9]+$ ]] || continue
    [[ "$pid" == "$$" || "$pid" == "$PPID" ]] && continue
    kill -TERM "$pid" 2>/dev/null || true
  done < <(profile_pids)
  sleep 1
  while IFS= read -r pid; do
    [[ "$pid" =~ ^[0-9]+$ ]] || continue
    [[ "$pid" == "$$" || "$pid" == "$PPID" ]] && continue
    kill -KILL "$pid" 2>/dev/null || true
  done < <(profile_pids)
}

cleanup() {
  stop_chrome
  if [[ -n "$chrome_pid" ]] && kill -0 "$chrome_pid" 2>/dev/null; then kill -TERM "$chrome_pid" 2>/dev/null || true; fi
  if [[ -n "$xvfb_pid" ]] && kill -0 "$xvfb_pid" 2>/dev/null; then
    kill -TERM "$xvfb_pid" 2>/dev/null || true
    wait "$xvfb_pid" 2>/dev/null || true
  fi
  log "cleanup.complete browser_processes_remaining=$(profile_pids | tr '\n' ',') port_listener=$(cdp_listener_state) xvfb_pid=${xvfb_pid:-reused}"
}
trap cleanup EXIT

log "start utc=$started_at diagnostic_dir=$diag_dir user=${desktop_user:-missing} display=:1"
sed -n 's/^PRETTY_NAME=/chromium.diag os.PRETTY_NAME=/p' /etc/os-release 2>/dev/null
dpkg-query -W -f='chromium.package name=${binary:Package} version=${Version} status=${db:Status-Abbrev}\n' chromium chromium-common 2>&1 || true
log "package.owner.inspect.start timeout_seconds=5"
timeout --kill-after=1s 5s dpkg-query -S /usr/bin/chromium /usr/lib/chromium/chromium /etc/chromium.d/dev-shm >"$diag_dir/package-owner.log" 2>&1
package_owner_exit_code=$?
if ((package_owner_exit_code == 0)); then
  sed 's/^/chromium.diag package.owner /' "$diag_dir/package-owner.log"
else
  log "package.owner.inspect.incomplete exit_code=$package_owner_exit_code output=$(tr '\n' ' ' <"$diag_dir/package-owner.log" | cut -c1-300)"
fi
log "package.owner.inspect.complete exit_code=$package_owner_exit_code"

log "wrapper.source.begin path=/usr/bin/chromium"
nl -ba /usr/bin/chromium 2>/dev/null | sed -n '1,20p;105,165p' | sed 's/^/chromium.diag wrapper /'
log "wrapper.source.end"
log "dev-shm.source.begin path=/etc/chromium.d/dev-shm"
nl -ba /etc/chromium.d/dev-shm 2>&1 | sed 's/^/chromium.diag dev-shm /'
log "dev-shm.source.end"

elf=/usr/lib/chromium/chromium
elf_magic="$(od -An -tx1 -N4 "$elf" 2>/dev/null | tr -d ' \n')"
elf_size="$(stat -c %s "$elf" 2>/dev/null || printf unknown)"
printf 'chromium.diag elf.inspect path=%s magic=%s bytes=%s\n' "$elf" "${elf_magic:-missing}" "$elf_size"
if [[ "$elf_magic" != 7f454c46 || ! -x "$elf" ]]; then log "result status=elf-not-found"; exit 0; fi
if [[ -z "$desktop_user" ]]; then log "result status=desktop-user-missing"; exit 0; fi

install -d -o "$desktop_user" -g "$(id -g "$desktop_user")" -m 0755 "$desktop_home" "$profile"
desktop_uid="$(id -u "$desktop_user")"
desktop_gid="$(id -g "$desktop_user")"
original_home="$(getent passwd "$desktop_user" | cut -d: -f6)"
log "ownership.inspect user=$desktop_user uid=$desktop_uid gid=$desktop_gid original_home=$original_home override_home=$desktop_home profile=$profile"
for path in "$original_home" /workspace "$desktop_home" "$profile" "$profile/Crash Reports" "$profile/Crashpad" "$elf" /usr/bin/chromium; do
  if [[ -e "$path" ]]; then
    stat -c 'chromium.diag ownership path=%n owner=%U:%G uid=%u gid=%g mode=%a type=%F' "$path" 2>&1
  else
    printf 'chromium.diag ownership path=%s state=missing\n' "$path"
  fi
done
for path in "$original_home" "$desktop_home" "$profile"; do
  [[ -d "$path" ]] || continue
  probe="$path/.csa-chromium-write-probe-$$"
  if runuser -u "$desktop_user" -- env HOME="$desktop_home" sh -c 'umask 077; : >"$1"' _ "$probe" 2>/dev/null; then
    log "ownership.write_probe status=ok path=$path user=$desktop_user"
    runuser -u "$desktop_user" -- unlink "$probe" 2>/dev/null || true
  else
    log "ownership.write_probe status=failed path=$path user=$desktop_user"
  fi
done
if ! xdpyinfo -display :1 >/dev/null 2>&1; then
  Xvfb :1 -screen 0 1280x800x24 -nolisten tcp >"$diag_dir/xvfb.log" 2>&1 &
  xvfb_pid=$!
  log "display.started display=:1 pid=$xvfb_pid"
  for attempt in $(seq 1 20); do
    xdpyinfo -display :1 >/dev/null 2>&1 && { log "display.ready attempt=$attempt"; break; }
    sleep 1
  done
else
  log "display.ready display=:1 owner=preexisting"
fi
if ! xdpyinfo -display :1 >/dev/null 2>&1; then log "result status=display-unavailable"; tail -n 15 "$diag_dir/xvfb.log" 2>/dev/null; exit 0; fi

chown "$desktop_user:$(id -g "$desktop_user")" "$profile"
wait_seconds="${CSA_CHROMIUM_CDP_WAIT_SECONDS:-210}"
if [[ ! "$wait_seconds" =~ ^[1-9][0-9]{0,2}$ ]] || ((wait_seconds > 360)); then wait_seconds=210; fi
flags_mode="${CSA_CHROMIUM_DIAGNOSTIC_FLAGS_MODE:-desktop}"
no_startup_window="${CSA_CHROMIUM_DIAGNOSTIC_NO_STARTUP_WINDOW:-0}"
if [[ "$no_startup_window" != 0 && "$no_startup_window" != 1 ]]; then no_startup_window=0; fi
trace_startup="${CSA_CHROMIUM_DIAGNOSTIC_TRACE_STARTUP:-0}"
if [[ "$trace_startup" != 0 && "$trace_startup" != 1 ]]; then trace_startup=0; fi
trace_args=()
if [[ "$trace_startup" == 1 ]]; then
  trace_args=(--disable-perfetto --trace-startup=toplevel,browser,startup --trace-startup-duration=210 --trace-startup-owner=controller --trace-startup-format=json "--trace-startup-file=$trace_file")
fi
strace_main="${CSA_CHROMIUM_DIAGNOSTIC_STRACE_MAIN:-0}"
if [[ "$strace_main" != 0 && "$strace_main" != 1 ]]; then strace_main=0; fi
perf_capture="${CSA_CHROMIUM_DIAGNOSTIC_PERF:-0}"
if [[ "$perf_capture" != 0 && "$perf_capture" != 1 ]]; then perf_capture=0; fi
perf_after_seconds="${CSA_CHROMIUM_DIAGNOSTIC_PERF_AFTER_SECONDS:-90}"
if [[ ! "$perf_after_seconds" =~ ^[0-9]+$ ]] || ((perf_after_seconds < 15 || perf_after_seconds > 240)); then perf_after_seconds=90; fi
perf_bundle="${CSA_CHROMIUM_DIAGNOSTIC_PERF_BUNDLE:-}"
perf_bundle_sha256_expected="${CSA_CHROMIUM_DIAGNOSTIC_PERF_BUNDLE_SHA256:-}"
perf_symbols_file="${CSA_CHROMIUM_DIAGNOSTIC_PERF_SYMBOLS_FILE:-}"
perf_symbols_sha256_expected="${CSA_CHROMIUM_DIAGNOSTIC_PERF_SYMBOLS_SHA256:-}"
perf_symbols_root=
perf_symbols_ready=no
perf_ready=no
perf_sampled=0
perf_binary=
perf_library_path=
install_strace="${CSA_CHROMIUM_DIAGNOSTIC_INSTALL_STRACE:-0}"
if [[ "$install_strace" != 0 && "$install_strace" != 1 ]]; then install_strace=0; fi
strace_package="${CSA_CHROMIUM_DIAGNOSTIC_STRACE_DEB:-}"
strace_binary="$(command -v strace 2>/dev/null || true)"
if [[ "$strace_main" == 1 && -z "$strace_binary" && -n "$strace_package" && -f "$strace_package" ]]; then
  if command -v dpkg-deb >/dev/null 2>&1; then
    package_arch="$(dpkg-deb -f "$strace_package" Architecture 2>/dev/null)"
    package_version="$(dpkg-deb -f "$strace_package" Version 2>/dev/null)"
  else
    package_arch=unknown
    package_version=unknown
  fi
  if [[ "$package_arch" == arm64 ]]; then
    strace_root="$diag_dir/strace-package"
    mkdir -p "$strace_root"
    if dpkg-deb -x "$strace_package" "$strace_root" 2>"$diag_dir/strace-extract.stderr"; then
      strace_binary="$strace_root/usr/bin/strace"
      if [[ -x "$strace_binary" ]] && "$strace_binary" -V >"$diag_dir/strace-version.log" 2>&1; then
        log "strace.package.ready architecture=$package_arch version=$package_version binary=$strace_binary"
      else
        log "strace.package.failed architecture=$package_arch version=$package_version reason=extracted-binary-unusable detail=$(tr '\n' ' ' <"$diag_dir/strace-version.log" 2>/dev/null | cut -c1-180)"
        strace_binary=""
      fi
    else
      log "strace.package.failed architecture=$package_arch version=$package_version reason=extract-failed detail=$(tr '\n' ' ' <"$diag_dir/strace-extract.stderr" 2>/dev/null | cut -c1-180)"
    fi
  else
    log "strace.package.skipped architecture=${package_arch:-unknown} reason=requires-arm64-deb-and-dpkg-deb"
  fi
elif [[ "$strace_main" == 1 && -n "$strace_package" ]]; then
  log "strace.package.skipped path_state=missing-or-strace-already-installed"
fi
strace_stack_supported=no
strace_stack_args=()
if [[ "$strace_main" == 1 && -x "$strace_binary" ]]; then
  strace_stack_probe_trace="$diag_dir/strace-stack-probe.trace"
  strace_stack_probe_stderr="$diag_dir/strace-stack-probe.stderr"
  timeout --kill-after=1s 3s "$strace_binary" -k -e trace=execve -o "$strace_stack_probe_trace" /bin/true 2>"$strace_stack_probe_stderr"
  strace_stack_probe_exit=$?
  if ((strace_stack_probe_exit == 0)); then
    strace_stack_supported=yes
    strace_stack_args=(-k)
  fi
  strace_stack_probe_bytes=0
  if [[ -f "$strace_stack_probe_trace" ]]; then strace_stack_probe_bytes="$(wc -c <"$strace_stack_probe_trace" | tr -d ' ')"; fi
  log "strace.stack.capability supported=$strace_stack_supported exit_code=$strace_stack_probe_exit trace_bytes=$strace_stack_probe_bytes detail=$(tr '\n' ' ' <"$strace_stack_probe_stderr" 2>/dev/null | cut -c1-180)"
fi
chrome_args=()
if [[ "$flags_mode" == desktop ]]; then
  chrome_args=(
    --show-component-extension-options --enable-gpu-rasterization --no-default-browser-check
    --disable-pings --media-router=0 --enable-remote-extensions --load-extension=
    --disable-dev-shm-usage --disable-gpu --no-first-run --no-default-browser-check
    --password-store=basic --remote-debugging-address=127.0.0.1 --remote-debugging-port=19222
    "--user-data-dir=$profile" --start-maximized --no-sandbox --enable-logging=stderr "${trace_args[@]}" about:blank
  )
elif [[ "$flags_mode" == minimal ]]; then
  chrome_args=(
    --no-sandbox --disable-dev-shm-usage --disable-gpu --no-first-run
    --remote-debugging-address=127.0.0.1 --remote-debugging-port=19222
    "--user-data-dir=$profile" --enable-logging=stderr "${trace_args[@]}" about:blank
  )
else
  log "result status=invalid-flags-mode flags_mode=$flags_mode"
  exit 7
fi
if [[ "$no_startup_window" == 1 ]]; then chrome_args+=(--no-startup-window); fi
if [[ "$strace_main" == 1 && "$install_strace" == 1 && -z "$strace_binary" ]]; then
  log "strace.install.start package=strace update_timeout_seconds=25 install_timeout_seconds=25 scope=disposable-clone"
  apt_source_args=()
  apt_mirror="${CSA_DESKTOP_APT_MIRROR%/}"
  if [[ -n "$apt_mirror" ]]; then
    . /etc/os-release
    suite="${VERSION_CODENAME:-bookworm}"
    security_mirror="${apt_mirror%/debian}/debian-security"
    apt_sources_file="$diag_dir/strace-sources.list"
    cat >"$apt_sources_file" <<EOF
deb [signed-by=/usr/share/keyrings/debian-archive-keyring.gpg] $apt_mirror $suite main
deb [signed-by=/usr/share/keyrings/debian-archive-keyring.gpg] $apt_mirror $suite-updates main
deb [signed-by=/usr/share/keyrings/debian-archive-keyring.gpg] $security_mirror $suite-security main
EOF
    apt_source_args=(-o "Dir::Etc::sourcelist=$apt_sources_file" -o Dir::Etc::sourceparts=- -o APT::Get::List-Cleanup=0)
    log "strace.install.mirror.configured host=$(printf '%s' "$apt_mirror" | sed -E 's#^[a-zA-Z]+://([^/]+).*#\1#') suite=$suite source_file=$apt_sources_file"
  else
    log "strace.install.mirror.default source=guest-configured"
  fi
  timeout --signal=TERM --kill-after=2s 25s apt-get "${apt_source_args[@]}" -o Dpkg::Use-Pty=0 -o Acquire::Retries=0 -o Acquire::http::Timeout=8 -o Acquire::https::Timeout=8 update
  apt_update_exit=$?
  log "strace.install.update.result exit_code=$apt_update_exit"
  if ((apt_update_exit == 0)); then
    timeout --signal=TERM --kill-after=2s 25s apt-get "${apt_source_args[@]}" -o Dpkg::Use-Pty=0 -o Acquire::Retries=0 -o Acquire::http::Timeout=8 -o Acquire::https::Timeout=8 install -y --no-install-recommends strace
    apt_install_exit=$?
    log "strace.install.package.result exit_code=$apt_install_exit available=$(command -v strace >/dev/null 2>&1 && printf yes || printf no)"
  fi
  strace_binary="$(command -v strace 2>/dev/null || true)"
fi
if [[ "$perf_capture" == 1 ]]; then
  perf_bundle_sha256_actual=
  if [[ -f "$perf_bundle" ]]; then
    perf_bundle_sha256_actual="$(sha256sum "$perf_bundle" 2>/dev/null | awk '{print $1}')"
  fi
  log "perf.bundle.inspect path=${perf_bundle:-missing} bytes=$(stat -c %s "$perf_bundle" 2>/dev/null || printf 0) sha256=${perf_bundle_sha256_actual:-unavailable} expected_sha256=${perf_bundle_sha256_expected:-missing}"
  if [[ -n "$perf_bundle_sha256_expected" && "$perf_bundle_sha256_actual" == "$perf_bundle_sha256_expected" ]] \
    && command -v tar >/dev/null 2>&1; then
    perf_extract_started_seconds="$SECONDS"
    if timeout --kill-after=2s 25s tar -xzf "$perf_bundle" -C "$diag_dir" 2>"$diag_dir/perf-bundle-extract.stderr"; then
      perf_root="$diag_dir/perf-root"
      perf_binary="$perf_root/usr/bin/perf"
      perf_library_path="$perf_root/usr/lib/aarch64-linux-gnu:$perf_root/lib/aarch64-linux-gnu:$perf_root/usr/lib:$perf_root/lib"
      perf_ldd_output=
      perf_ldd_exit_code=127
      if [[ -x "$perf_binary" ]]; then
        perf_ldd_output="$(timeout --kill-after=1s 5s env LD_LIBRARY_PATH="$perf_library_path" ldd "$perf_binary" 2>&1)"
        perf_ldd_exit_code=$?
        printf '%s\n' "$perf_ldd_output" | sed 's/^/chromium.diag perf.ldd /'
        perf_version_output="$(timeout --kill-after=1s 5s env LD_LIBRARY_PATH="$perf_library_path" PAGER=cat PERF_PAGER=cat "$perf_binary" --version 2>&1)"
        perf_version_exit_code=$?
      else
        perf_version_output=missing
        perf_version_exit_code=127
      fi
      if ((perf_ldd_exit_code == 0 && perf_version_exit_code == 0)) \
        && [[ "$perf_version_output" == *"perf version 6.1.192"* ]] \
        && ! printf '%s\n' "$perf_ldd_output" | grep -q 'not found'; then
        perf_ready=yes
        perf_root_file_count="$(find "$perf_root" -type f 2>/dev/null | wc -l | tr -d ' ')"
        log "perf.package.ready source_packages=52 linux_perf_version=6.1.192-2 architecture=arm64 root_files=$perf_root_file_count extract_duration_seconds=$((SECONDS - perf_extract_started_seconds)) binary=$perf_binary version_output=$(printf '%s' "$perf_version_output" | tr '\n' ' ' | cut -c1-180)"
        perf_record_help="$diag_dir/perf-record-help.log"
        timeout --kill-after=1s 5s env LD_LIBRARY_PATH="$perf_library_path" PAGER=cat PERF_PAGER=cat "$perf_binary" record -h >"$perf_record_help" 2>&1
        if grep -q -- '--proc-map-timeout' "$perf_record_help" && grep -q -- '--control' "$perf_record_help" && grep -q -- '--tid' "$perf_record_help"; then
          log "perf.record.option.ready options=--proc-map-timeout,--control,--tid"
        else
          perf_ready=no
          log "perf.record.option.missing options=--proc-map-timeout,--control,--tid detail=$(tr '\n' ' ' <"$perf_record_help" | cut -c1-240)"
        fi
        perf_symbols_sha256_actual=
        if [[ -f "$perf_symbols_file" ]]; then
          perf_symbols_sha256_actual="$(sha256sum "$perf_symbols_file" 2>/dev/null | awk '{print $1}')"
        fi
        perf_symbols_file_bytes="$(stat -c %s "$perf_symbols_file" 2>/dev/null || printf 0)"
        log "perf.symbols.file.inspect path=${perf_symbols_file:-missing} bytes=$perf_symbols_file_bytes sha256=${perf_symbols_sha256_actual:-unavailable} expected_sha256=${perf_symbols_sha256_expected:-missing}"
        if [[ -n "$perf_symbols_sha256_expected" \
          && "$perf_symbols_sha256_actual" == "$perf_symbols_sha256_expected" \
          && "$perf_symbols_file_bytes" == 222504784 ]]; then
          perf_symbols_root="$diag_dir/perf-symbols"
          perf_symbols_link="$perf_symbols_root/usr/lib/debug/.build-id/eb/dba7517d4639a3afb9a4ffec8584b97fc384ba.debug"
          mkdir -p "${perf_symbols_link%/*}"
          if ln -s "$perf_symbols_file" "$perf_symbols_link"; then
            perf_symbols_ready=yes
            log "perf.symbols.file.ready package=chromium-dbgsym version=156.0.8078.79-1~deb12u1 architecture=arm64 build_id=ebdba7517d4639a3afb9a4ffec8584b97fc384ba bytes=$perf_symbols_file_bytes host_extracted=yes symfs=$perf_symbols_root"
          else
            log "perf.symbols.file.failed reason=build-id-symlink-creation-failed link=$perf_symbols_link"
          fi
        else
          log "perf.symbols.file.skipped reason=checksum-or-size-preflight-failed actual_sha256=${perf_symbols_sha256_actual:-unavailable} bytes=$perf_symbols_file_bytes"
        fi
      else
        log "perf.package.failed source_packages=52 architecture=arm64 ldd_exit_code=$perf_ldd_exit_code version_exit_code=$perf_version_exit_code version_output=$(printf '%s' "$perf_version_output" | tr '\n' ' ' | cut -c1-240) missing_libraries=$(printf '%s\n' "$perf_ldd_output" | grep 'not found' | tr '\n' ';' | cut -c1-300)"
      fi
    else
      log "perf.bundle.extract.failed exit_code=$? duration_seconds=$((SECONDS - perf_extract_started_seconds)) detail=$(tr '\n' ' ' <"$diag_dir/perf-bundle-extract.stderr" 2>/dev/null | cut -c1-240)"
    fi
  else
    log "perf.bundle.skipped reason=checksum-or-tool-preflight-failed tar=$(command -v tar 2>/dev/null || printf missing)"
  fi
fi
log "cdp.start executable=$elf port=19222 wait_seconds=$wait_seconds flags_mode=$flags_mode no_startup_window=$no_startup_window trace_startup=$trace_startup trace_file=$([[ "$trace_startup" == 1 ]] && printf '%s' "$trace_file" || printf disabled) profile=$profile"
for chrome_arg in "${chrome_args[@]}"; do printf 'chromium.diag cdp.argument %q\n' "$chrome_arg"; done
log "cdp.strace.config requested=$strace_main available=$([[ -x "$strace_binary" ]] && printf yes || printf no) staged_package=${strace_package:+yes}"
runuser -u "$desktop_user" -- env HOME="$desktop_home" DISPLAY=:1 "$elf" "${chrome_args[@]}" >"$chrome_log" 2>&1 &
chrome_pid=$!
log "cdp.process.launcher_pid=$chrome_pid"
status=timeout
http_code=not-probed
cdp_started_seconds="$SECONDS"
cdp_deadline_seconds=$((cdp_started_seconds + wait_seconds))
attempt=0
last_diagnostic_elapsed=-45
last_listener=unknown
main_strace_sampled=0
listener_owner_sampled=0
main_maps_sampled=0
while ((SECONDS < cdp_deadline_seconds)); do
  attempt=$((attempt + 1))
  log "cdp.probe.start attempt=$attempt elapsed_seconds=$((SECONDS - cdp_started_seconds)) url=http://127.0.0.1:19222/json/version"
  http_code="$(timeout --kill-after=1s 3s curl --noproxy '*' --connect-timeout 1 --max-time 2 -sS -o "$diag_dir/cdp-version.json" -w '%{http_code}' http://127.0.0.1:19222/json/version 2>"$diag_dir/curl.log")"
  curl_exit_code=$?
  cdp_elapsed_seconds=$((SECONDS - cdp_started_seconds))
  last_listener="$(cdp_listener_state)"
  last_listener_queue=unavailable
  if [[ "$last_listener" == present ]]; then last_listener_queue="$(cdp_listener_queue_state)"; fi
  if [[ "$last_listener" == present && "$listener_owner_sampled" == 0 ]]; then
    listener_owner_sampled=1
    listener_owner="$(cdp_listener_owner_state)"
    log "cdp.listener.owner.sample elapsed_seconds=$cdp_elapsed_seconds owner=$listener_owner queue=$last_listener_queue"
  fi
  if ((curl_exit_code == 0)) && [[ "$http_code" == 200 ]]; then
    status=ready
    log "cdp.probe.result attempt=$attempt status=ready elapsed_seconds=$cdp_elapsed_seconds http_code=$http_code curl_exit_code=$curl_exit_code listener=$last_listener queue=$last_listener_queue"
    break
  fi
  log "cdp.probe.result attempt=$attempt status=pending elapsed_seconds=$cdp_elapsed_seconds http_code=${http_code:-failed} curl_exit_code=$curl_exit_code listener=$last_listener queue=$last_listener_queue curl_error=$(tr '\n' ' ' <"$diag_dir/curl.log" | cut -c1-240)"
  if ((cdp_elapsed_seconds - last_diagnostic_elapsed >= 45)) \
    || [[ "$last_listener" == present && "$strace_main" == 1 && "$main_strace_sampled" == 0 ]] \
    || [[ "$perf_capture" == 1 && "$perf_sampled" == 0 && "$cdp_elapsed_seconds" -ge "$perf_after_seconds" ]]; then
    printf 'chromium.diag cdp.wait elapsed_seconds=%s attempt=%s status=%s http_code=%s listener=%s launcher=' "$cdp_elapsed_seconds" "$attempt" "$status" "${http_code:-failed}" "$last_listener"
    ps -p "$chrome_pid" -o pid=,ppid=,stat=,wchan=,etime=,%cpu=,rss=,comm= 2>/dev/null | tr '\n' ';'
    printf '\n'
    process_snapshot=
    if [[ ! "$browser_pid" =~ ^[0-9]+$ ]] || ! kill -0 "$browser_pid" 2>/dev/null; then
      process_snapshot="$(timeout --kill-after=1s 3s ps -eo pid=,ppid=,stat=,wchan=,etime=,%cpu=,rss=,comm=,args= 2>/dev/null \
        | awk -v profile="$profile" 'index($0, profile) && $0 !~ /awk -v profile=/ { print; if (++count >= 4) exit }' \
      )"
      if [[ -n "$process_snapshot" ]]; then
        candidate_browser_pid="$(printf '%s\n' "$process_snapshot" | awk '$8 == "chromium" && $0 !~ /--type=/ { print $1; exit }')"
        if [[ "$candidate_browser_pid" =~ ^[0-9]+$ ]]; then
          browser_pid="$candidate_browser_pid"
          log "cdp.browser-pid.discovered pid=$browser_pid profile=$profile"
        fi
      fi
    fi
    if [[ -n "$process_snapshot" ]]; then
      printf '%s\n' "$process_snapshot" | sed 's/^/chromium.diag cdp.process /'
    fi
    if [[ "$browser_pid" =~ ^[0-9]+$ && -r "/proc/$browser_pid/status" ]]; then
        browser_state="$(awk '/^State:/ { print $2 }' "/proc/$browser_pid/status" 2>/dev/null)"
        browser_rss_kb="$(awk '/^VmRSS:/ { print $2 }' "/proc/$browser_pid/status" 2>/dev/null)"
        browser_threads="$(awk '/^Threads:/ { print $2 }' "/proc/$browser_pid/status" 2>/dev/null)"
        browser_wchan="$(cat "/proc/$browser_pid/wchan" 2>/dev/null | cut -c1-80)"
        browser_syscall="$(cat "/proc/$browser_pid/syscall" 2>&1 | cut -c1-180)"
        log "cdp.main-thread.sample pid=$browser_pid state=${browser_state:-unknown} rss_kb=${browser_rss_kb:-unknown} threads=${browser_threads:-unknown} wchan=${browser_wchan:-unknown} syscall=${browser_syscall:-unavailable}"
        if [[ "$main_maps_sampled" == 0 ]]; then
          browser_binary_maps="$(awk '$NF == "/usr/lib/chromium/chromium" { printf "%s:%s:%s:%s:%s;", $1, $2, $3, $4, $5 }' "/proc/$browser_pid/maps" 2>/dev/null | cut -c1-1800)"
          if [[ -n "$browser_binary_maps" ]]; then
            main_maps_sampled=1
            log "cdp.browser.binary-maps.sample pid=$browser_pid maps=$browser_binary_maps"
          fi
        fi
        thread_snapshot="$(timeout --kill-after=1s 3s ps -L -p "$browser_pid" -o tid=,stat=,wchan=,pcpu=,time=,comm= 2>/dev/null | sort -k4,4nr | head -n 3)"
        if [[ -n "$thread_snapshot" ]]; then
          thread_summary="$(printf '%s\n' "$thread_snapshot" | awk 'BEGIN { separator="" } { printf "%s%s:%s:%s:%s:%s%%", separator, $1, $6, $2, $3, $4; separator="," }')"
          log "cdp.thread.top pid=$browser_pid samples=$thread_summary"
          hot_thread_tid="$(printf '%s\n' "$thread_snapshot" | awk 'NR == 1 {print $1}')"
          if [[ "$hot_thread_tid" =~ ^[0-9]+$ ]]; then
            hot_thread_syscall="$(timeout --kill-after=1s 2s cat "/proc/$hot_thread_tid/syscall" 2>&1 | cut -c1-180)"
            log "cdp.thread.hot.sample pid=$browser_pid tid=$hot_thread_tid syscall=${hot_thread_syscall:-unavailable}"
          fi
        fi
        perf_live_elapsed_seconds=$((SECONDS - cdp_started_seconds))
        if [[ "$perf_capture" == 1 && "$perf_sampled" == 0 && "$perf_live_elapsed_seconds" -ge "$perf_after_seconds" ]]; then
          perf_sampled=1
          perf_data="$diag_dir/chromium-perf.data"
          perf_record_stdout="$diag_dir/perf-record.stdout"
          perf_record_stderr="$diag_dir/perf-record.stderr"
          perf_control_fifo="$diag_dir/perf-control.fifo"
          perf_ack_fifo="$diag_dir/perf-ack.fifo"
          perf_record_pid=
          perf_control_ack=unavailable
          perf_forced_stop=no
          perf_sample_duration_seconds=6
          perf_devtools_tid="$(cdp_thread_tid_by_comm Chrome_DevTools 2>/dev/null || true)"
          if [[ "$strace_main" == 1 && -x "$strace_binary" ]]; then perf_sample_duration_seconds=10; fi
          perf_target_tids=
          if [[ "$browser_pid" =~ ^[0-9]+$ && "$perf_devtools_tid" =~ ^[0-9]+$ ]]; then
            perf_target_tids="$browser_pid,$perf_devtools_tid"
          fi
          if [[ "$perf_ready" == yes && "$last_listener" == present && "$perf_target_tids" == *,* ]]; then
            log "perf.record.start main_tid=$browser_pid devtools_tid=$perf_devtools_tid target_tids=$perf_target_tids elapsed_seconds=$perf_live_elapsed_seconds event_elapsed_seconds=$cdp_elapsed_seconds listener=$last_listener sample_after_seconds=$perf_after_seconds duration_seconds=$perf_sample_duration_seconds event=cpu-clock:u frequency_hz=49 call_graph=fp proc_map_timeout_ms=30000 stop_method=control-fifo output=$perf_data"
            if mkfifo "$perf_control_fifo" "$perf_ack_fifo" 2>"$diag_dir/perf-control-fifo.stderr"; then
            exec {perf_control_fd}<>"$perf_control_fifo"
            exec {perf_ack_fd}<>"$perf_ack_fifo"
            env LD_LIBRARY_PATH="$perf_library_path" PAGER=cat PERF_PAGER=cat \
              "$perf_binary" record -o "$perf_data" -F 49 -e cpu-clock:u --call-graph fp --proc-map-timeout 30000 \
              --control "fd:${perf_control_fd},${perf_ack_fd}" -t "$perf_target_tids" \
              >"$perf_record_stdout" 2>"$perf_record_stderr" &
            perf_record_pid=$!
            log "perf.record.process.start pid=$perf_record_pid control_fd=$perf_control_fd ack_fd=$perf_ack_fd"
            printf 'ping\n' >&"$perf_control_fd"
            if IFS= read -r -t 35 -u "$perf_ack_fd" perf_control_ack; then
              log "perf.record.control.ready ack=$(printf '%s' "$perf_control_ack" | tr -cd '[:alnum:]_-' | cut -c1-40)"
            else
              log "perf.record.control.ready.delayed pid=$perf_record_pid ack_timeout_seconds=35"
              perf_record_state "$perf_record_pid"
              if perf_record_is_running "$perf_record_pid" && IFS= read -r -t 15 -u "$perf_ack_fd" perf_control_ack; then
                log "perf.record.control.ready.late ack=$(printf '%s' "$perf_control_ack" | tr -cd '[:alnum:]_-' | cut -c1-40) extra_wait_seconds=15"
              else
                log "perf.record.control.ack.timeout pid=$perf_record_pid total_wait_seconds=50"
                perf_record_state "$perf_record_pid"
              fi
            fi
            perf_overlap_curl_pid=
            if perf_record_is_running "$perf_record_pid" && [[ "$perf_control_ack" != unavailable ]]; then
              perf_overlap_body="$diag_dir/perf-overlap-response.body"
              perf_overlap_meta="$diag_dir/perf-overlap-curl.meta"
              perf_overlap_stderr="$diag_dir/perf-overlap-curl.stderr"
              perf_overlap_curl_trace="$diag_dir/perf-overlap-curl.strace"
              perf_overlap_strace_pid=
              if [[ "$strace_main" == 1 ]]; then
                start_chromium_strace "$browser_pid" || true
              fi
              perf_overlap_start_epoch="$(date +%s.%N 2>/dev/null || date +%s)"
              : >"$perf_overlap_body"
              if [[ "$strace_main" == 1 && -x "$strace_binary" ]]; then
                timeout --signal=INT --kill-after=1s 30s "$strace_binary" -f -s 0 -tt -T -yy \
                  -e trace=execve,socket,connect,getsockopt,poll,ppoll,select,pselect6,epoll_wait,epoll_pwait,sendto,recvfrom,sendmsg,recvmsg,shutdown \
                  -o "$perf_overlap_curl_trace" \
                  curl --noproxy '*' --connect-timeout 10 --max-time 25 -sS \
                  -o "$perf_overlap_body" \
                  -w '%{http_code}|%{time_connect}|%{time_starttransfer}|%{time_total}|%{size_download}' \
                  http://127.0.0.1:19222/json/version >"$perf_overlap_meta" 2>"$perf_overlap_stderr" &
                log "perf.overlap.curl.strace.start path=$perf_overlap_curl_trace target=launched-curl timeout_seconds=30"
              else
                timeout --kill-after=1s 30s curl --noproxy '*' --connect-timeout 10 --max-time 25 -sS \
                  -o "$perf_overlap_body" \
                  -w '%{http_code}|%{time_connect}|%{time_starttransfer}|%{time_total}|%{size_download}' \
                  http://127.0.0.1:19222/json/version >"$perf_overlap_meta" 2>"$perf_overlap_stderr" &
              fi
              perf_overlap_curl_pid=$!
              log "perf.overlap.request.start tid=$perf_devtools_tid timestamp=$perf_overlap_start_epoch timeout_seconds=25"
              sleep 1
              sample_chromium_thread "$browser_pid"
              sample_chromium_thread "$perf_devtools_tid"
              sleep 1
              sample_chromium_thread "$browser_pid"
              sample_chromium_thread "$perf_devtools_tid"
              wait "$perf_overlap_curl_pid"
              perf_overlap_curl_exit=$?
              perf_overlap_curl_pid=
              perf_overlap_end_epoch="$(date +%s.%N 2>/dev/null || date +%s)"
              if [[ -s "$perf_overlap_curl_trace" ]]; then
                curl_trace_bytes="$(wc -c <"$perf_overlap_curl_trace" 2>/dev/null | tr -d ' ' || printf 0)"
                curl_trace_lines="$(wc -l <"$perf_overlap_curl_trace" 2>/dev/null | tr -d ' ' || printf 0)"
                curl_trace_connects="$(grep -Ec '(^|[[:space:]])connect\(' "$perf_overlap_curl_trace" 2>/dev/null || true)"
                curl_trace_polls="$(grep -Ec '(^|[[:space:]])(poll|ppoll|select|pselect6|epoll_wait|epoll_pwait)\(' "$perf_overlap_curl_trace" 2>/dev/null || true)"
                log "perf.overlap.curl.strace.result exit_code=$perf_overlap_curl_exit bytes=$curl_trace_bytes lines=$curl_trace_lines connects=${curl_trace_connects:-0} polls=${curl_trace_polls:-0}"
                grep -E '19222|(^|[[:space:]])(socket|connect|getsockopt|poll|ppoll|select|pselect6|epoll_wait|epoll_pwait|sendto|recvfrom|sendmsg|recvmsg|shutdown|close|read|write)\(' "$perf_overlap_curl_trace" \
                  | tail -n 50 \
                  | redact_devtools_urls \
                  | sed 's/^/chromium.diag perf.overlap.curl.strace.trace /'
              else
                log "perf.overlap.curl.strace.result state=missing"
              fi
              perf_overlap_body_bytes="$(wc -c <"$perf_overlap_body" 2>/dev/null | tr -d ' ' || printf 0)"
              perf_overlap_body_preview="$(tr '\n' ' ' <"$perf_overlap_body" 2>/dev/null | sed -E 's/(\"webSocketDebuggerUrl\"[[:space:]]*:[[:space:]]*\")[^\"]+/\1[redacted]/g' | cut -c1-520)"
              log "perf.overlap.request.result tid=$perf_devtools_tid start=$perf_overlap_start_epoch end=$perf_overlap_end_epoch exit_code=$perf_overlap_curl_exit listener=$(cdp_listener_state) queue=$(cdp_listener_queue_state) http_time_status_size=$(cat "$perf_overlap_meta" 2>/dev/null) body_bytes=$perf_overlap_body_bytes stderr=$(tr '\n' ' ' <"$perf_overlap_stderr" 2>/dev/null | cut -c1-180) body=$(printf '%q' "$perf_overlap_body_preview")"
              finish_chromium_strace "$browser_pid"
            else
              log "perf.overlap.request.skipped recorder_running=$(perf_record_is_running "$perf_record_pid" && printf yes || printf no) ack=$(printf '%s' "$perf_control_ack" | tr -cd '[:alnum:]_-' | cut -c1-40)"
            fi
            if perf_record_is_running "$perf_record_pid"; then
              printf 'stop\n' >&"$perf_control_fd"
              log "perf.record.control.stop.sent pid=$perf_record_pid ack=$(printf '%s' "${perf_control_ack:-pending}" | tr -cd '[:alnum:]_-' | cut -c1-40)"
            else
              log "perf.record.control.stop.skipped pid=$perf_record_pid reason=recorder-exited-before-stop"
            fi
            for perf_wait_attempt in $(seq 1 20); do
              perf_record_is_running "$perf_record_pid" || break
              sleep 1
            done
            if perf_record_is_running "$perf_record_pid"; then
              perf_forced_stop=yes
              log "perf.record.control.stop.timeout pid=$perf_record_pid wait_seconds=20 action=SIGINT"
              kill -INT "$perf_record_pid" 2>/dev/null || true
              for perf_wait_attempt in $(seq 1 4); do
                perf_record_is_running "$perf_record_pid" || break
                sleep 1
              done
            fi
            if perf_record_is_running "$perf_record_pid"; then
              log "perf.record.control.stop.escalate pid=$perf_record_pid action=SIGTERM"
              kill -TERM "$perf_record_pid" 2>/dev/null || true
              sleep 1
            fi
            if perf_record_is_running "$perf_record_pid"; then
              log "perf.record.control.stop.escalate pid=$perf_record_pid action=SIGKILL"
              kill -KILL "$perf_record_pid" 2>/dev/null || true
            fi
            wait "$perf_record_pid"
            perf_record_exit_code=$?
            exec {perf_ack_fd}>&-
            exec {perf_control_fd}>&-
          else
            perf_record_exit_code=127
            log "perf.record.control.fifo.failed detail=$(tr '\n' ' ' <"$diag_dir/perf-control-fifo.stderr" 2>/dev/null | cut -c1-180)"
          fi
          perf_data_state=missing
          perf_data_bytes=0
          if [[ -e "$perf_data" ]]; then
            perf_data_state=empty
            perf_data_bytes="$(wc -c <"$perf_data" | tr -d ' ')"
            if ((perf_data_bytes > 0)); then perf_data_state=ready; fi
          fi
          log "perf.record.complete pid=$browser_pid recorder_pid=${perf_record_pid:-missing} exit_code=$perf_record_exit_code forced_stop=$perf_forced_stop data_state=$perf_data_state data_bytes=$perf_data_bytes stdout_bytes=$(wc -c <"$perf_record_stdout" 2>/dev/null | tr -d ' ' || printf 0) stderr_bytes=$(wc -c <"$perf_record_stderr" 2>/dev/null | tr -d ' ' || printf 0)"
          if [[ -s "$perf_record_stdout" ]]; then tail -n 25 "$perf_record_stdout" | sed 's/^/chromium.diag perf.record.stdout /'; fi
          if [[ -s "$perf_record_stderr" ]]; then tail -n 40 "$perf_record_stderr" | sed 's/^/chromium.diag perf.record.stderr /'; fi
          if [[ "$strace_main" == 1 ]]; then
            log "perf.report.skipped reason=process-wide-strace-run data_bytes=$perf_data_bytes"
          elif [[ -s "$perf_data" && "$perf_forced_stop" == no && "$perf_record_exit_code" == 0 ]]; then
            perf_report="$diag_dir/perf-report.txt"
            perf_report_stderr="$diag_dir/perf-report.stderr"
            perf_report_args=(report --stdio -i "$perf_data" --sort comm,dso,symbol --call-graph graph,0.5,caller --no-children --max-stack 24 --percent-limit 1)
            if [[ "$perf_symbols_ready" == yes ]]; then perf_report_args+=(--symfs "$perf_symbols_root"); fi
            log "perf.report.start symbols=$perf_symbols_ready symfs=${perf_symbols_root:-disabled} call_graph=graph max_stack=24 timeout_seconds=45"
            timeout --kill-after=3s 45s env LD_LIBRARY_PATH="$perf_library_path" PAGER=cat PERF_PAGER=cat \
              "$perf_binary" "${perf_report_args[@]}" \
              >"$perf_report" 2>"$perf_report_stderr"
            perf_report_exit_code=$?
            perf_report_bytes="$(wc -c <"$perf_report" 2>/dev/null | tr -d ' ' || printf 0)"
            log "perf.report.complete exit_code=$perf_report_exit_code bytes=$perf_report_bytes"
            if [[ -s "$perf_report" ]]; then sed -n '1,70p' "$perf_report" | sed 's/^/chromium.diag perf.report /'; fi
            if [[ -s "$perf_report_stderr" ]]; then tail -n 20 "$perf_report_stderr" | sed 's/^/chromium.diag perf.report.stderr /'; fi
          elif [[ -s "$perf_data" ]]; then
            log "perf.report.skipped reason=record-not-cleanly-stopped exit_code=$perf_record_exit_code forced_stop=$perf_forced_stop data_bytes=$perf_data_bytes"
          else
            log "perf.report.skipped reason=recording-not-created state=$perf_data_state"
          fi
          perf_leftovers="$(ps -eo pid=,ppid=,stat=,comm=,args= 2>/dev/null | awk -v binary="$perf_binary" 'index($0, binary) && $3 !~ /Z|X/ { print }' | head -n 8)"
          log "perf.process.cleanup-check remaining=$(printf '%s' "$perf_leftovers" | tr '\n' ';' | cut -c1-500)"
          else
            if [[ "$perf_ready" != yes ]]; then
              perf_sampled=1
              log "perf.record.skipped reason=profiler-not-ready elapsed_seconds=$cdp_elapsed_seconds listener=$last_listener"
            else
              perf_sampled=0
              perf_after_seconds=$((perf_live_elapsed_seconds + 15))
              if [[ "$last_listener" != present ]]; then
                perf_retry_reason=listener-not-ready
              else
                perf_retry_reason=devtools-thread-not-found
              fi
              log "perf.record.retry.scheduled reason=$perf_retry_reason main_tid=$browser_pid devtools_tid=${perf_devtools_tid:-missing} elapsed_seconds=$perf_live_elapsed_seconds next_elapsed_seconds=$perf_after_seconds"
            fi
          fi
        fi
        if [[ "$last_listener" == present && "$strace_main" == 1 && "$perf_capture" != 1 && "$main_strace_sampled" == 0 ]]; then
          main_strace_sampled=1
          if [[ -x "$strace_binary" ]]; then
            strace_trace="$diag_dir/chromium-network.strace"
            strace_stderr="$diag_dir/main-thread-strace.stderr"
            overlap_curl_meta="$diag_dir/cdp-overlap-curl.meta"
            overlap_curl_stderr="$diag_dir/cdp-overlap-curl.stderr"
            log "cdp.main-strace.start pid=$browser_pid duration_seconds=8 attach=all-threads filter=network-and-io stack_traces=$strace_stack_supported"
            timeout --signal=INT --kill-after=2s 8s "$strace_binary" -f "${strace_stack_args[@]}" -tt -T -yy \
              -e trace=accept,accept4,bind,listen,connect,getsockopt,recvfrom,recvmsg,sendto,sendmsg,epoll_wait,epoll_pwait,futex,read,write \
              -p "$browser_pid" -o "$strace_trace" 2>"$strace_stderr" &
            strace_runner_pid=$!
            strace_attach_ready=no
            for attach_attempt in $(seq 1 40); do
              if grep -q 'Process .* attached with' "$strace_stderr" 2>/dev/null; then strace_attach_ready=yes; break; fi
              kill -0 "$strace_runner_pid" 2>/dev/null || break
              sleep 0.1
            done
            log "cdp.main-strace.attach pid=$browser_pid status=$strace_attach_ready detail=$(tr '\n' ' ' <"$strace_stderr" 2>/dev/null | cut -c1-180)"
            if [[ "$strace_attach_ready" == yes ]]; then
              timeout --kill-after=1s 5s curl --noproxy '*' --connect-timeout 1 --max-time 4 -sS -o "$diag_dir/cdp-overlap-response.body" -w '%{http_code}|%{time_connect}|%{time_total}|%{size_download}' http://127.0.0.1:19222/json/version >"$overlap_curl_meta" 2>"$overlap_curl_stderr" &
              overlap_curl_pid=$!
              sleep 1
              overlap_queue="$(cdp_listener_queue_state)"
              log "cdp.overlap.listener-queue elapsed_seconds=$((SECONDS - cdp_started_seconds)) queue=$overlap_queue"
              wait "$overlap_curl_pid"
              overlap_curl_exit=$?
              log "cdp.overlap.curl.result exit_code=$overlap_curl_exit http_time_size=$(cat "$overlap_curl_meta" 2>/dev/null) queue_after=$(cdp_listener_queue_state) stderr=$(tr '\n' ' ' <"$overlap_curl_stderr" 2>/dev/null | cut -c1-180)"
              overlap_body_bytes="$(wc -c <"$diag_dir/cdp-overlap-response.body" 2>/dev/null | tr -d ' ' || printf 0)"
              overlap_body_preview="$(tr '\n' ' ' <"$diag_dir/cdp-overlap-response.body" 2>/dev/null | sed -E 's/(\"webSocketDebuggerUrl\"[[:space:]]*:[[:space:]]*\")[^\"]+/\1[redacted]/g' | cut -c1-520)"
              log "cdp.overlap.response bytes=$overlap_body_bytes body=$(printf '%q' "$overlap_body_preview")"
            fi
            wait "$strace_runner_pid"
            strace_exit_code=$?
            strace_trace_bytes="$(wc -c <"$strace_trace" 2>/dev/null | tr -d ' ' || printf 0)"
            log "cdp.main-strace.result pid=$browser_pid exit_code=$strace_exit_code trace_bytes=${strace_trace_bytes:-0} stderr=$(tr '\n' ' ' <"$strace_stderr" 2>/dev/null | cut -c1-240)"
            http_handler_tid="$(grep -m 1 'GET /json/version HTTP' "$strace_trace" 2>/dev/null | awk '{print $1}')"
            if [[ "$http_handler_tid" =~ ^[0-9]+$ ]]; then
              handler_comm="$(cat "/proc/$http_handler_tid/comm" 2>/dev/null | cut -c1-50)"
              handler_state="$(awk '/^State:/ { print $2 }' "/proc/$http_handler_tid/status" 2>/dev/null)"
              handler_wchan="$(timeout --kill-after=1s 2s cat "/proc/$http_handler_tid/wchan" 2>/dev/null | cut -c1-80)"
              handler_syscall="$(timeout --kill-after=1s 2s cat "/proc/$http_handler_tid/syscall" 2>&1 | cut -c1-180)"
              handler_trace_count="$(grep -c "^$http_handler_tid " "$strace_trace" 2>/dev/null || true)"
              log "cdp.main-strace.http-handler tid=$http_handler_tid comm=${handler_comm:-unknown} state=${handler_state:-unknown} wchan=${handler_wchan:-unknown} syscall=${handler_syscall:-unavailable} trace_lines=${handler_trace_count:-0}"
              grep "^$http_handler_tid " "$strace_trace" | tail -n 32 | sed 's/^/chromium.diag cdp.main-strace.http-handler.trace /'
              if [[ "$strace_stack_supported" == yes ]]; then
                awk -v tid="$http_handler_tid" 'BEGIN { include_stack = 0; hits = 0 } $1 == tid { if ($0 ~ /(epoll_pwait|accept4?|read\(|futex\()/) { if (++hits > 8) exit; include_stack = 1; print; next } include_stack = 0; next } include_stack && /^[[:space:]]*>/ { print; next } include_stack && /^[[:space:]]*$/ { print; next } { include_stack = 0 }' "$strace_trace" | sed 's/^/chromium.diag cdp.main-strace.http-handler.stack /'
              fi
            else
              log "cdp.main-strace.http-handler.unresolved reason=request-read-tid-not-found"
            fi
            browser_comm_after="$(cat "/proc/$browser_pid/comm" 2>/dev/null | cut -c1-50)"
            browser_state_after="$(awk '/^State:/ { print $2 }' "/proc/$browser_pid/status" 2>/dev/null)"
            browser_wchan_after="$(timeout --kill-after=1s 2s cat "/proc/$browser_pid/wchan" 2>/dev/null | cut -c1-80)"
            browser_syscall_after="$(timeout --kill-after=1s 2s cat "/proc/$browser_pid/syscall" 2>&1 | cut -c1-180)"
            browser_trace_count="$(grep -c "^$browser_pid " "$strace_trace" 2>/dev/null || true)"
            log "cdp.main-strace.browser-leader pid=$browser_pid comm=${browser_comm_after:-unknown} state=${browser_state_after:-unknown} wchan=${browser_wchan_after:-unknown} syscall=${browser_syscall_after:-unavailable} trace_lines=${browser_trace_count:-0}"
            grep "^$browser_pid " "$strace_trace" | tail -n 32 | sed 's/^/chromium.diag cdp.main-strace.browser-leader.trace /'
            if [[ "$strace_stack_supported" == yes ]]; then
              awk -v tid="$browser_pid" 'BEGIN { include_stack = 0; hits = 0 } $1 == tid { if ($0 ~ /futex\(/) { if (++hits > 8) exit; include_stack = 1; print; next } include_stack = 0; next } include_stack && /^[[:space:]]*>/ { print; next } include_stack && /^[[:space:]]*$/ { print; next } { include_stack = 0 }' "$strace_trace" | sed 's/^/chromium.diag cdp.main-strace.browser-leader.stack /'
            fi
            network_trace_pattern='accept4?\(|bind\(|listen\(|connect\(|getsockopt\(|recvfrom\(|recvmsg\(|sendto\(|sendmsg\(|AF_INET|TCP:|127\.0\.0\.1:19222'
            network_trace_count="$(grep -Ec "$network_trace_pattern" "$strace_trace" 2>/dev/null || true)"
            [[ "$network_trace_count" =~ ^[0-9]+$ ]] || network_trace_count=0
            log "cdp.main-strace.network.summary pid=$browser_pid matching_lines=$network_trace_count listener_queue=$last_listener_queue"
            if ((network_trace_count > 0)); then
              if ((network_trace_count > 80)); then
                grep -E "$network_trace_pattern" "$strace_trace" | sed -n '1,40p' | sed 's/^/chromium.diag cdp.main-strace.network /'
                grep -E "$network_trace_pattern" "$strace_trace" | tail -n 40 | sed 's/^/chromium.diag cdp.main-strace.network /'
              else
                grep -E "$network_trace_pattern" "$strace_trace" | sed 's/^/chromium.diag cdp.main-strace.network /'
              fi
            else
              log "cdp.main-strace.network.empty pid=$browser_pid duration_seconds=8"
            fi
            tcp_trace_pattern='accept4?\(|AF_INET|TCP:|127\.0\.0\.1:19222'
            tcp_trace_count="$(grep -Ec "$tcp_trace_pattern" "$strace_trace" 2>/dev/null || true)"
            [[ "$tcp_trace_count" =~ ^[0-9]+$ ]] || tcp_trace_count=0
            log "cdp.main-strace.tcp.summary pid=$browser_pid matching_lines=$tcp_trace_count"
            if ((tcp_trace_count > 0)); then
              if ((tcp_trace_count > 80)); then
                grep -E "$tcp_trace_pattern" "$strace_trace" | sed -n '1,40p' | sed 's/^/chromium.diag cdp.main-strace.tcp /'
                grep -E "$tcp_trace_pattern" "$strace_trace" | tail -n 40 | sed 's/^/chromium.diag cdp.main-strace.tcp /'
              else
                grep -E "$tcp_trace_pattern" "$strace_trace" | sed 's/^/chromium.diag cdp.main-strace.tcp /'
              fi
            else
              log "cdp.main-strace.tcp.empty pid=$browser_pid duration_seconds=8 overlap_curl=$([[ "$strace_attach_ready" == yes ]] && printf yes || printf no)"
            fi
            epoll_trace_count="$(grep -Ec 'epoll_(pwait|wait)' "$strace_trace" 2>/dev/null || true)"
            log "cdp.main-strace.epoll.summary pid=$browser_pid matching_lines=${epoll_trace_count:-0}"
          else
            log "cdp.main-strace.skipped reason=not-installed pid=$browser_pid"
          fi
        fi
    fi
    if [[ "$perf_capture" == 1 && "$perf_sampled" == 1 ]]; then
      log "cdp.probe.stop reason=perf-sample-finished"
      break
    fi
    tail -n 5 "$chrome_log" 2>/dev/null | redact_devtools_urls | sed 's/^/chromium.diag cdp.log /'
    last_diagnostic_elapsed=$cdp_elapsed_seconds
  fi
  if ! kill -0 "$chrome_pid" 2>/dev/null; then status=launcher-exited; break; fi
  sleep 1
done
cdp_elapsed_seconds=$((SECONDS - cdp_started_seconds))
if [[ "$status" == ready ]]; then
  printf 'chromium.diag cdp.result status=ready elapsed_seconds=%s attempts=%s http_code=%s listener=%s body=' "$cdp_elapsed_seconds" "$attempt" "$http_code" "$last_listener"
  tr '\n' ' ' <"$diag_dir/cdp-version.json" | redact_devtools_urls | cut -c1-500
  printf '\n'
else
  devtools_log_seen=no
  grep -Fq 'DevTools listening' "$chrome_log" 2>/dev/null && devtools_log_seen=yes
  last_listener="$(cdp_listener_state)"
  printf 'chromium.diag cdp.result status=%s elapsed_seconds=%s attempts=%s last_http_code=%s listener=%s devtools_log_seen=%s launcher_pid=%s\n' "$status" "$cdp_elapsed_seconds" "$attempt" "${http_code:-failed}" "$last_listener" "$devtools_log_seen" "$chrome_pid"
fi
tail -n 35 "$chrome_log" 2>/dev/null | redact_devtools_urls | sed 's/^/chromium.diag cdp.log /'
if [[ "$trace_startup" == 1 ]]; then
  log "trace.startup.flush.begin browser_pid=${browser_pid:-unknown}"
  stop_chrome
  sleep 2
  log "trace.startup.flush.complete browser_processes_remaining=$(profile_pids | tr '\n' ',')"
  grep -Ei 'trace|startup_tracing' "$chrome_log" 2>/dev/null | tail -n 20 | redact_devtools_urls | sed 's/^/chromium.diag trace.startup.log /'
  trace_wait_attempt=0
  while [[ ! -s "$trace_file" ]] && ((trace_wait_attempt < 5)); do
    trace_wait_attempt=$((trace_wait_attempt + 1))
    trace_wait_state=missing
    [[ -e "$trace_file" ]] && trace_wait_state=empty
    log "trace.startup.file.wait attempt=$trace_wait_attempt state=$trace_wait_state"
    sleep 1
  done
  trace_file_state=missing
  trace_bytes=0
  trace_header_hex=
  if [[ -e "$trace_file" ]]; then
    trace_file_state=empty
    trace_bytes="$(wc -c <"$trace_file" | tr -d ' ')"
    if ((trace_bytes > 0)); then trace_file_state=ready; fi
    trace_header_hex="$(od -An -tx1 -N24 "$trace_file" 2>/dev/null | tr -s ' ' | sed 's/^ //;s/ $//')"
  fi
  log "trace.startup.file state=$trace_file_state bytes=$trace_bytes header_hex=${trace_header_hex:-unavailable} path=$trace_file"
  if [[ -s "$trace_file" ]]; then
    python3 - "$trace_file" "${browser_pid:-}" "$trace_bytes" <<'PY'
import base64
import math
import sys
from pathlib import Path

path, browser_pid, trace_bytes = sys.argv[1:]
if int(trace_bytes) > 1_000_000:
    print(f"chromium.diag trace.startup.export-skipped bytes={trace_bytes} limit=1000000")
    raise SystemExit(0)
data = Path(path).read_bytes()
encoded = base64.b64encode(data).decode("ascii")
chunk_size = 1200
total = math.ceil(len(encoded) / chunk_size)
print(f"chromium.diag trace.startup.export.begin bytes={len(data)} browser_pid={browser_pid} chunks={total} encoding=base64")
for index in range(total):
    part = encoded[index * chunk_size:(index + 1) * chunk_size]
    print(f"chromium.diag trace.startup.export.chunk index={index + 1} total={total} data={part}")
print(f"chromium.diag trace.startup.export.complete bytes={len(data)} chunks={total}")
PY
  else
    log "trace.startup.missing path=$trace_file browser_pid=${browser_pid:-unknown}"
  fi
fi
log "result status=direct-elf-probe-finished diagnostic_dir=$diag_dir"
exit 0
