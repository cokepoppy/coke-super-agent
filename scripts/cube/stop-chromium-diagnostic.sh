#!/usr/bin/env bash
set -Eeuo pipefail

pgid="${CSA_DIAGNOSTIC_PGID:-}"
profile="${CSA_DIAGNOSTIC_PROFILE:-}"
cdp_port="${CSA_DIAGNOSTIC_CDP_PORT:-}"

log() {
  printf 'chromium.diagnostic.cleanup timestamp=%s %s\n' "$(date -u +%FT%TZ)" "$*"
}

if [[ ! "$pgid" =~ ^[1-9][0-9]*$ || ! "$cdp_port" =~ ^[0-9]+$ || -z "$profile" ]]; then
  log "result=refused reason=invalid-identity pgid=${pgid:-missing} port=${cdp_port:-missing} profile=${profile:-missing}"
  exit 2
fi

if [[ ! -r "/proc/$pgid/cmdline" ]]; then
  log "result=already-stopped pgid=$pgid port=$cdp_port"
  exit 0
fi
leader_command="$(tr '\0' ' ' <"/proc/$pgid/cmdline" 2>/dev/null || true)"
if [[ "$leader_command" != *"$profile"* || "$leader_command" != *"--remote-debugging-port=$cdp_port"* ]]; then
  log "result=refused reason=identity-mismatch pgid=$pgid command=$(printf '%q' "$leader_command")"
  exit 3
fi

members() {
  ps -eo pid=,pgid=,stat=,comm=,args= | awk -v id="$pgid" '$2 == id { print }'
}
live_members() {
  ps -eo pid=,pgid=,stat=,comm= | awk -v id="$pgid" '$2 == id && $3 !~ /Z|X/ { print $1 }'
}

log "result=identity-verified pgid=$pgid port=$cdp_port profile=$profile"
members | while IFS= read -r line; do log "process.before $line"; done
curl_exit=0
curl_output="$(timeout --kill-after=1s 4s curl --noproxy '*' --connect-timeout 1 --max-time 3 -sS -i \
  "http://127.0.0.1:$cdp_port/json/version" 2>&1)" || curl_exit=$?
log "cdp.probe exit=$curl_exit response=$(printf '%q' "${curl_output:0:1200}")"

kill -TERM -- "-$pgid" 2>/dev/null || true
for _ in $(seq 1 20); do
  [[ -n "$(live_members)" ]] || break
  sleep 0.2
done
if [[ -n "$(live_members)" ]]; then
  pids="$(live_members | tr '\n' ',')"
  log "cleanup.kill pgid=$pgid live_pids=${pids%,}"
  kill -KILL -- "-$pgid" 2>/dev/null || true
fi
members | while IFS= read -r line; do log "process.after $line"; done
if ss -lnt 2>/dev/null | awk -v suffix=":$cdp_port" 'NR > 1 && substr($4, length($4) - length(suffix) + 1) == suffix { found=1 } END { exit !found }'; then
  log "result=failed reason=cdp-port-still-open port=$cdp_port"
  exit 4
fi
log "result=stopped pgid=$pgid cdp_port=$cdp_port listener=closed"
