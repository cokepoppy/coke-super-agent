#!/usr/bin/env bash
set +e

cpu_summary() {
  local phase="$1"
  printf 'websockify.diag.cpu phase=%s nproc=%s cpu.max=' "$phase" "$(nproc 2>/dev/null || printf unknown)"
  cat /sys/fs/cgroup/cpu.max 2>/dev/null || printf unknown
  printf 'websockify.diag.cpu.stat phase=%s ' "$phase"
  tr '\n' ';' < /sys/fs/cgroup/cpu.stat 2>/dev/null || printf unknown
  printf '\nwebsockify.diag.cpu.pressure phase=%s ' "$phase"
  tr '\n' ';' < /proc/pressure/cpu 2>/dev/null || printf unknown
  printf '\n'
}

process_summary() {
  local phase="$1"
  printf 'websockify.diag.process phase=%s\n' "$phase"
  ps -eo pid=,ppid=,stat=,etimes=,pcpu=,rss=,comm= --sort=-pcpu 2>/dev/null | head -n 12 | sed 's/^/websockify.diag.process.top /'
}

awk -F ': ' '/^(processor|model name|Hardware|CPU implementer|CPU part|CPU architecture)/ { print "websockify.diag.cpuinfo " $1 "=" $2; count++; if (count >= 6) exit }' /proc/cpuinfo 2>/dev/null
cpu_summary before
process_summary before

/usr/bin/python3 -S -u -c 'import importlib,sys,time; sys.modules["numpy"] = None; sys.path.insert(0, "/usr/lib/python3/dist-packages"); overall=time.monotonic(); names=("random", "socket", "ssl", "http.server", "multiprocessing", "websockify");
for name in names:
    started=time.monotonic(); importlib.import_module(name); print("websockify.diag.import stage=%s elapsed_seconds=%.3f cumulative_seconds=%.3f" % (name, time.monotonic()-started, time.monotonic()-overall), flush=True)
print("websockify.diag.import.complete elapsed_seconds=%.3f module=%s" % (time.monotonic()-overall, sys.modules["websockify"].__file__), flush=True)'
import_status=$?
cpu_summary after
process_summary after

printf 'websockify.diag.result mode=staged-import status=%s\n' "$import_status"
printf 'websockify.diag.files websockify=%s novnc_page=%s python=%s\n' \
  "$(command -v websockify 2>/dev/null || printf missing)" \
  "$(test -f /usr/share/novnc/vnc.html && printf present || printf missing)" \
  "$(command -v python3 2>/dev/null || printf missing)"

websockify_path="$(command -v websockify 2>/dev/null || true)"
if [[ -z "$websockify_path" ]]; then
  printf 'websockify.diag.server.result status=missing-binary\n'
  exit 0
fi

server_log=/tmp/csa-websockify-direct-diagnostic.log
: >"$server_log"
existing_listener="$(awk '$4 == "0A" { split($2, endpoint, ":"); if (toupper(endpoint[2]) == "17C0") print FILENAME ":" $0 }' /proc/net/tcp /proc/net/tcp6 2>/dev/null | tr '\n' ';')"
if [[ -n "$existing_listener" ]]; then
  printf 'websockify.diag.server.skip reason=preexisting-listener listener=%s\n' "$existing_listener"
  exit 0
fi
started_at="$(date +%s)"
PYTHONUNBUFFERED=1 "$websockify_path" --web=/usr/share/novnc 6080 localhost:5900 >"$server_log" 2>&1 &
server_pid=$!
server_status=timeout
http_status=not-probed
trap 'kill "$server_pid" 2>/dev/null; wait "$server_pid" 2>/dev/null' EXIT
printf 'websockify.diag.server.start pid=%s command=%s --web=/usr/share/novnc 6080 localhost:5900\n' "$server_pid" "$websockify_path"

for attempt in $(seq 1 50); do
  listener="$(awk '$4 == "0A" { split($2, endpoint, ":"); if (toupper(endpoint[2]) == "17C0") print FILENAME ":" $0 }' /proc/net/tcp /proc/net/tcp6 2>/dev/null | tr '\n' ';')"
  if [[ -n "$listener" ]] && command -v curl >/dev/null 2>&1; then
    http_status="$(curl --noproxy '*' --connect-timeout 1 --max-time 2 -sS -o /dev/null -w '%{http_code}' http://127.0.0.1:6080/vnc.html 2>/dev/null || printf request-failed)"
    if [[ "$http_status" == 200 ]]; then
      server_status=ready
      printf 'websockify.diag.server.ready attempt=%s elapsed_seconds=%s http_status=%s listener=%s\n' "$attempt" "$(( $(date +%s) - started_at ))" "$http_status" "$listener"
      break
    fi
  fi
  if ! kill -0 "$server_pid" 2>/dev/null; then
    server_status=exited
    wait "$server_pid" 2>/dev/null
    server_exit=$?
    printf 'websockify.diag.server.exit attempt=%s exit_status=%s elapsed_seconds=%s http_status=%s\n' "$attempt" "$server_exit" "$(( $(date +%s) - started_at ))" "$http_status"
    break
  fi
  if ((attempt % 5 == 0)); then
    process_state="$(ps -p "$server_pid" -o stat=,wchan=,etime=,comm= 2>/dev/null | tr '\n' ';')"
    cpu_ticks="$(awk '{ print $14 + $15 }' "/proc/$server_pid/stat" 2>/dev/null || printf unknown)"
    printf 'websockify.diag.server.wait attempt=%s elapsed_seconds=%s http_status=%s state=%s cpu_ticks=%s\n' "$attempt" "$(( $(date +%s) - started_at ))" "$http_status" "${process_state:-missing}" "$cpu_ticks"
    tail -n 12 "$server_log" 2>/dev/null | sed 's/^/websockify.diag.server.log /'
  fi
  sleep 1
done

printf 'websockify.diag.server.result status=%s http_status=%s elapsed_seconds=%s\n' "$server_status" "$http_status" "$(( $(date +%s) - started_at ))"
tail -n 30 "$server_log" 2>/dev/null | sed 's/^/websockify.diag.server.log /'
exit 0
