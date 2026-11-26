#!/usr/bin/env bash
set -Eeuo pipefail

started_at=$SECONDS
phase=preflight
state_dir=/var/lib/csa-desktop
bootstrap=/tmp/csa-desktop-bootstrap.sh
install -d -m 0755 "$state_dir"

log_event() {
  local stage="$1"
  shift
  printf 'desktop_bootstrap_launcher timestamp=%s elapsed_seconds=%s tenant_id=%s sandbox_id=%s generation=%s run_id=%s phase=%s stage=%s %s\n' \
    "$(date -u +%FT%TZ)" "$((SECONDS - started_at))" "${CSA_TENANT_ID:-unknown}" "${CSA_CUBE_SANDBOX_ID:-unknown}" "${CSA_COMPUTER_GENERATION:-unknown}" "${CSA_RUN_ID:-none}" "$phase" "$stage" "$*"
}

machine_id_changed=0
ensure_sandbox_machine_id() {
  local sandbox_id="${CSA_CUBE_SANDBOX_ID:-}" marker_path="$state_dir/machine-id-sandbox" marker_value machine_id temp_file
  if [[ "$sandbox_id" =~ ^[a-zA-Z0-9_-]{1,80}$ ]]; then
    marker_value="$(cat "$marker_path" 2>/dev/null || true)"
    if [[ "$marker_value" == "$sandbox_id" && -s /etc/machine-id ]]; then
      log_event machine-id.reuse "source=sandbox-marker marker=$marker_path"
      return 0
    fi
    machine_id="$(tr -d '-' </proc/sys/kernel/random/uuid)"
    if [[ ! "$machine_id" =~ ^[[:xdigit:]]{32}$ ]]; then
      log_event failed "reason=kernel-uuid-invalid-output output_length=${#machine_id}"
      echo "The kernel UUID source did not produce a 32-digit machine ID." >&2
      return 1
    fi
    temp_file="/etc/machine-id.csa.$$"
    printf '%s\n' "$machine_id" >"$temp_file"
    chmod 0444 "$temp_file"
    mv -f -- "$temp_file" /etc/machine-id
    install -d -m 0755 /var/lib/dbus
    ln -sfn /etc/machine-id /var/lib/dbus/machine-id
    temp_file="$marker_path.$$"
    printf '%s\n' "$sandbox_id" >"$temp_file"
    chmod 0600 "$temp_file"
    mv -f -- "$temp_file" "$marker_path"
    machine_id_changed=1
    log_event machine-id.created "source=kernel-random-uuid marker=$marker_path machine_id_bytes=$(wc -c </etc/machine-id | tr -d ' ')"
    return 0
  fi

  if [[ ! -s /etc/machine-id ]]; then
    machine_id="$(tr -d '-' </proc/sys/kernel/random/uuid)"
    if [[ ! "$machine_id" =~ ^[[:xdigit:]]{32}$ ]]; then
      log_event failed "reason=kernel-uuid-invalid-output output_length=${#machine_id}"
      echo "The kernel UUID source did not produce a 32-digit machine ID." >&2
      return 1
    fi
    temp_file="/etc/machine-id.csa.$$"
    printf '%s\n' "$machine_id" >"$temp_file"
    chmod 0444 "$temp_file"
    mv -f -- "$temp_file" /etc/machine-id
    chmod 0444 /etc/machine-id
    machine_id_changed=1
    log_event machine-id.created "source=kernel-random-uuid machine_id_bytes=$(wc -c </etc/machine-id | tr -d ' ')"
  else
    log_event machine-id.reuse reason=sandbox-id-unavailable
  fi
}

websockify_listener_ready() {
  awk '$4 == "0A" { split($2, endpoint, ":"); if (toupper(endpoint[2]) == "17C0") found = 1 } END { exit !found }' /proc/net/tcp /proc/net/tcp6 2>/dev/null
}

on_error() {
  local status=$?
  trap - ERR
  local command
  printf -v command '%q' "${BASH_COMMAND:-unknown}"
  log_event failed "exit_code=$status line=${BASH_LINENO[0]:-unknown} command=${command:0:500}"
  exit "$status"
}
trap on_error ERR

session_pid_file=/run/csa-desktop/session.pid
session_ready_file=/run/csa-desktop/session.ready
session_lock_file=/workspace/.desktop-home/.csa-desktop-session.lock
ready_marker_present=0
session_pid_file_present=0
session_ready_file_present=0
session_process_ready=0
[[ -f "$state_dir/ready" ]] && ready_marker_present=1
[[ -s "$session_pid_file" ]] && session_pid_file_present=1
[[ -f "$session_ready_file" ]] && session_ready_file_present=1
ensure_sandbox_machine_id
if [[ -s "$session_pid_file" ]]; then
  session_pid="$(cat "$session_pid_file")"
  if [[ "$session_pid" =~ ^[0-9]+$ ]] && ((session_pid > 1)) && kill -0 "$session_pid" 2>/dev/null; then
    session_command="$(tr '\0' ' ' <"/proc/$session_pid/cmdline" 2>/dev/null || true)"
    case "$session_command" in *csa-desktop-session*) session_process_ready=1 ;; esac
  fi
fi

# Probe on every launch: old desktop sessions may have neither readiness marker
# nor session.pid, while their lock and child processes remain alive.
if [[ -f "$state_dir/ready" || -s "$session_pid_file" || -e "$session_lock_file" || "${CSA_FORCE_DESKTOP_BOOTSTRAP:-0}" == "1" || "$machine_id_changed" == "1" ]]; then
  websockify_ready=0
  x11_ready=0
  websockify_listener_ready && websockify_ready=1
  timeout --kill-after=1s 3s env DISPLAY=:1 xdpyinfo -display :1 >/dev/null 2>&1 && x11_ready=1
  log_event readiness.probe "ready_marker=$ready_marker_present session_pid_file=$session_pid_file_present session_process=$session_process_ready session_ready_file=$session_ready_file_present websockify=$websockify_ready x11=$x11_ready novnc_assets=app-hosted force_bootstrap=${CSA_FORCE_DESKTOP_BOOTSTRAP:-0} machine_id_changed=$machine_id_changed"
  if [[ "$machine_id_changed" != 1 && "$websockify_ready" == 1 && "$x11_ready" == 1 && "$session_process_ready" == 1 && "$session_ready_file_present" == 1 ]]; then
    if [[ "${CSA_FORCE_DESKTOP_BOOTSTRAP:-0}" != "1" ]]; then
      if [[ "$ready_marker_present" != 1 ]]; then
        printf '%s\n' "$(date -u +%FT%TZ)" >"$state_dir/ready"
        log_event readiness.marker.repaired reason=services-healthy
      fi
      log_event already-ready
      exit 0
    fi
    log_event force-refresh.desktop-healthy reason=required-desktop-diagnostic-package-missing
  else
    log_event readiness.stale "action=restart-session ready_marker=$ready_marker_present session_pid_file=$session_pid_file_present"
    rm -f "$state_dir/ready" "$state_dir/bootstrap.exitcode"

    session_pid_candidates=""
    add_session_pid() {
      local candidate="$1"
      [[ "$candidate" =~ ^[0-9]+$ ]] && ((candidate > 1)) || return 0
      case " $session_pid_candidates " in *" $candidate "*) return 0 ;; esac
      session_pid_candidates+=" $candidate"
    }
    if [[ -s "$session_pid_file" ]]; then add_session_pid "$(cat "$session_pid_file")"; fi
    desktop_uid="$(id -u user 2>/dev/null || true)"
    if [[ "$desktop_uid" =~ ^[0-9]+$ ]]; then
      desktop_gid="$(id -g user 2>/dev/null || true)"
      if [[ ! "$desktop_gid" =~ ^[0-9]+$ ]]; then
        log_event error "stale-session.lock.directory.failed reason=desktop-gid-unavailable uid=$desktop_uid"
        exit 1
      fi
      install -d -o "$desktop_uid" -g "$desktop_gid" -m 0755 "$(dirname "$session_lock_file")"
      if [[ -L "$session_lock_file" || (-e "$session_lock_file" && ! -f "$session_lock_file") ]]; then
        log_event error "stale-session.lock.path.invalid path=$session_lock_file type=not-regular-file"
        exit 1
      fi
      if [[ ! -e "$session_lock_file" ]]; then
        (umask 077; : >"$session_lock_file")
        log_event stale-session.lock.file.created "path=$session_lock_file uid=$desktop_uid gid=$desktop_gid"
      fi
      chown "$desktop_uid:$desktop_gid" "$session_lock_file"
      chmod 0600 "$session_lock_file"
      while read -r candidate; do
        [[ "$candidate" =~ ^[0-9]+$ ]] || continue
        candidate_uid="$(awk '/^Uid:/ {print $2; exit}' "/proc/$candidate/status" 2>/dev/null || true)"
        [[ "$candidate_uid" == "$desktop_uid" ]] || continue
        candidate_command="$(tr '\0' ' ' <"/proc/$candidate/cmdline" 2>/dev/null || true)"
        case "$candidate_command" in
          *"/usr/local/bin/csa-desktop-session"*|*"/tmp/csa-desktop-session.sh"*) add_session_pid "$candidate" ;;
        esac
      done < <(ps -u "$desktop_uid" -o pid= 2>/dev/null)
    fi

    if [[ -n "$session_pid_candidates" ]]; then
      log_event stale-session.scan "pids=${session_pid_candidates// /,} source=session-pid-and-desktop-user-process-table"
      for session_pid in $session_pid_candidates; do
        [[ -r "/proc/$session_pid/cmdline" ]] || continue
        session_uid="$(awk '/^Uid:/ {print $2; exit}' "/proc/$session_pid/status" 2>/dev/null || true)"
        session_command="$(tr '\0' ' ' <"/proc/$session_pid/cmdline" 2>/dev/null || true)"
        case "$session_command" in
          *"/usr/local/bin/csa-desktop-session"*|*"/tmp/csa-desktop-session.sh"*) ;;
          *) log_event stale-session.stop.skipped "reason=pid-identity-mismatch pid=$session_pid"; continue ;;
        esac
        if [[ "$session_uid" != "$desktop_uid" ]]; then
          log_event stale-session.stop.skipped "reason=uid-mismatch pid=$session_pid uid=${session_uid:-unknown}"
          continue
        fi
        log_event stale-session.stop.start "pid=$session_pid uid=$session_uid"
        kill -TERM "$session_pid" 2>/dev/null || true
        for attempt in $(seq 1 40); do
          kill -0 "$session_pid" 2>/dev/null || break
          sleep 0.25
        done
        if kill -0 "$session_pid" 2>/dev/null; then
          current_command="$(tr '\0' ' ' <"/proc/$session_pid/cmdline" 2>/dev/null || true)"
          current_uid="$(awk '/^Uid:/ {print $2; exit}' "/proc/$session_pid/status" 2>/dev/null || true)"
          case "$current_command" in
            *"/usr/local/bin/csa-desktop-session"*|*"/tmp/csa-desktop-session.sh"*)
              [[ "$current_uid" == "$desktop_uid" ]] && kill -KILL "$session_pid" 2>/dev/null || true
              ;;
          esac
        fi
        log_event stale-session.stop.complete "pid=$session_pid"
      done
    else
      log_event stale-session.stop.skipped reason=no-validated-supervisor-found
    fi

    lock_holder_pids=""
    if [[ "$desktop_uid" =~ ^[0-9]+$ ]]; then
      for lock_fd in /proc/[0-9]*/fd/9; do
        [[ -e "$lock_fd" ]] || continue
        [[ "$(readlink "$lock_fd" 2>/dev/null || true)" == "$session_lock_file" ]] || continue
        lock_pid="$(basename "$(dirname "$(dirname "$lock_fd")")")"
        lock_uid="$(awk '/^Uid:/ {print $2; exit}' "/proc/$lock_pid/status" 2>/dev/null || true)"
        [[ "$lock_uid" == "$desktop_uid" ]] || continue
        case " $lock_holder_pids " in *" $lock_pid "*) continue ;; esac
        lock_holder_pids+=" $lock_pid"
      done
    fi
    if [[ -n "$lock_holder_pids" ]]; then
      log_event stale-session.lock-holder.scan "pids=${lock_holder_pids// /,} uid=$desktop_uid fd=9 lock_file=$session_lock_file"
      for lock_pid in $lock_holder_pids; do
        lock_uid="$(awk '/^Uid:/ {print $2; exit}' "/proc/$lock_pid/status" 2>/dev/null || true)"
        lock_target="$(readlink "/proc/$lock_pid/fd/9" 2>/dev/null || true)"
        if [[ "$lock_uid" != "$desktop_uid" || "$lock_target" != "$session_lock_file" ]]; then
          log_event stale-session.lock-holder.stop.skipped "reason=fd-or-uid-identity-changed pid=$lock_pid"
          continue
        fi
        log_event stale-session.lock-holder.stop.start "pid=$lock_pid uid=$lock_uid fd=9"
        kill -TERM "$lock_pid" 2>/dev/null || true
        for attempt in $(seq 1 20); do
          [[ "$(readlink "/proc/$lock_pid/fd/9" 2>/dev/null || true)" == "$session_lock_file" ]] || break
          sleep 0.25
        done
        if [[ "$(readlink "/proc/$lock_pid/fd/9" 2>/dev/null || true)" == "$session_lock_file" ]]; then
          lock_uid="$(awk '/^Uid:/ {print $2; exit}' "/proc/$lock_pid/status" 2>/dev/null || true)"
          [[ "$lock_uid" == "$desktop_uid" ]] && kill -KILL "$lock_pid" 2>/dev/null || true
        fi
        log_event stale-session.lock-holder.stop.complete "pid=$lock_pid"
      done
    else
      log_event stale-session.lock-holder.scan pids=none
    fi
    if flock -n "$session_lock_file" -c true; then
      log_event stale-session.lock.released lock_file="$session_lock_file"
    else
      log_event error stale-session.lock.release.failed lock_file="$session_lock_file"
      exit 1
    fi
  fi
fi

if [[ "${CSA_FORCE_DESKTOP_BOOTSTRAP:-0}" == "1" ]]; then
  log_event force-refresh "reason=required-desktop-diagnostic-package-missing"
  rm -f "$state_dir/ready" "$state_dir/bootstrap.exitcode"
fi

if [[ -s "$state_dir/bootstrap.pid" ]]; then
  pid="$(cat "$state_dir/bootstrap.pid")"
  if [[ "$pid" =~ ^[0-9]+$ && -r "/proc/$pid/cmdline" ]]; then
    command_line="$(tr '\0' ' ' <"/proc/$pid/cmdline")"
    if [[ "$command_line" == *"$bootstrap"* ]]; then
      log_event already-running "pid=$pid"
      exit 0
    fi
  fi
fi

rm -f "$state_dir/bootstrap.exitcode"
phase=bootstrap-launch
nohup bash -c '
set +e
bootstrap=$1
state_dir=$2
printf "desktop_bootstrap_launcher timestamp=%s tenant_id=%s run_id=%s stage=guest-process.start pid=%s bootstrap=%s\n" "$(date -u +%FT%TZ)" "${CSA_TENANT_ID:-unknown}" "${CSA_RUN_ID:-none}" "$$" "$bootstrap"
bash "$bootstrap"
result=$?
printf "desktop_bootstrap_launcher timestamp=%s tenant_id=%s run_id=%s stage=guest-process.exit exit_code=%s\n" "$(date -u +%FT%TZ)" "${CSA_TENANT_ID:-unknown}" "${CSA_RUN_ID:-none}" "$result"
printf "%s\n" "$result" >"$state_dir/bootstrap.exitcode"
exit "$result"
' csa-desktop-bootstrap-runner "$bootstrap" "$state_dir" \
  </dev/null >>"$state_dir/bootstrap.log" 2>&1 &
bootstrap_pid=$!
bootstrap_pid_tmp="$state_dir/bootstrap.pid.$$"
printf '%s\n' "$bootstrap_pid" >"$bootstrap_pid_tmp"
mv -f "$bootstrap_pid_tmp" "$state_dir/bootstrap.pid"
log_event started "pid=$bootstrap_pid bootstrap=$bootstrap log=$state_dir/bootstrap.log apt_log=$state_dir/apt.log detached_fds=closed"
