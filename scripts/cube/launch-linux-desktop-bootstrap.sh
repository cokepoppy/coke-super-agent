#!/usr/bin/env bash
set -Eeuo pipefail

state_dir=/var/lib/csa-desktop
bootstrap=/tmp/csa-desktop-bootstrap.sh
install -d -m 0755 "$state_dir"

if [[ -f "$state_dir/ready" ]]; then
  echo "desktop bootstrap is already complete"
  exit 0
fi

if [[ -s "$state_dir/bootstrap.pid" ]]; then
  pid="$(cat "$state_dir/bootstrap.pid")"
  if [[ "$pid" =~ ^[0-9]+$ && -r "/proc/$pid/cmdline" ]]; then
    command_line="$(tr '\0' ' ' <"/proc/$pid/cmdline")"
    if [[ "$command_line" == *"$bootstrap"* ]]; then
      echo "desktop bootstrap is already running"
      exit 0
    fi
  fi
fi

rm -f "$state_dir/bootstrap.exitcode"
nohup setsid bash -c '
  set +e
  bash /tmp/csa-desktop-bootstrap.sh >>/var/lib/csa-desktop/bootstrap.log 2>&1
  result=$?
  printf "%s\n" "$result" >/var/lib/csa-desktop/bootstrap.exitcode
  exit "$result"
' </dev/null >/dev/null 2>&1 &
printf '%s\n' "$!" >"$state_dir/bootstrap.pid"
echo "desktop bootstrap started in the background"
