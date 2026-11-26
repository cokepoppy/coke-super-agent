#!/usr/bin/env bash
set -uo pipefail
umask 077

state_dir=/var/lib/csa-agent-runtime
phase_file="$state_dir/install.phase"
install_log="$state_dir/install.log"
install -d -m 0755 "$state_dir"
install_started_at=$SECONDS
exec 9>"$state_dir/bootstrap.lock"
lock_deadline=$((SECONDS + 2700))
until flock -n 9; do
  if ((SECONDS >= lock_deadline)); then
    printf 'dsh_runtime_install_wait.failed tenant_id=%s run_id=%s elapsed_seconds=%s reason=lock-timeout\n' "${CSA_TENANT_ID:-unknown}" "${CSA_RUN_ID:-none}" "$((SECONDS - install_started_at))" >&2
    exit 1
  fi
  printf 'dsh_runtime_install_waiting tenant_id=%s run_id=%s timestamp=%s elapsed_seconds=%s\n' "${CSA_TENANT_ID:-unknown}" "${CSA_RUN_ID:-none}" "$(date -u +%FT%TZ)" "$((SECONDS - install_started_at))"
  sleep 15
done

rm -f "$state_dir/install.exit"
: > "$install_log"
printf 'dsh_runtime_install_started tenant_id=%s run_id=%s pid=%s timestamp=%s\n' "${CSA_TENANT_ID:-unknown}" "${CSA_RUN_ID:-none}" "$$" "$(date -u +%FT%TZ)"
printf 'dsh_runtime_install_output_stream tenant_id=%s run_id=%s stdout_stderr_destination=%s\n' "${CSA_TENANT_ID:-unknown}" "${CSA_RUN_ID:-none}" "$install_log"

# Keep the installer attached to this process group and tee its complete log
# to both the guest log file and the calling PTY. Template builds can therefore
# stream guest diagnostics directly without polling Cube's guest-file API.
if command -v stdbuf >/dev/null 2>&1; then
  stdbuf -oL -eL bash /tmp/csa-bootstrap-dsh-runtime.sh 2>&1 | tee "$install_log"
  status=${PIPESTATUS[0]}
else
  bash /tmp/csa-bootstrap-dsh-runtime.sh 2>&1 | tee "$install_log"
  status=${PIPESTATUS[0]}
fi
printf '%s\n' "$status" > "$state_dir/install.exit"
phase="unknown"
if [[ -s "$phase_file" ]]; then phase="$(tail -n 1 "$phase_file" | cut -f2-)"; fi
printf 'dsh_runtime_install_complete tenant_id=%s run_id=%s status=%s elapsed_seconds=%s phase=%s timestamp=%s\n' "${CSA_TENANT_ID:-unknown}" "${CSA_RUN_ID:-none}" "$status" "$((SECONDS - install_started_at))" "$phase" "$(date -u +%FT%TZ)"
exit "$status"
