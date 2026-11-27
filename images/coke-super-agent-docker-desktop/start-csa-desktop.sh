#!/usr/bin/env bash
set -Eeuo pipefail

desktop_uid=1000
agent_uid=1001
desktop_user="$(getent passwd "$desktop_uid" | cut -d: -f1)"
if [[ -z "$desktop_user" ]]; then
  echo "The desktop image does not contain UID ${desktop_uid}." >&2
  exit 1
fi
desktop_gid="$(id -g "$desktop_user")"
agent_user="$(getent passwd "$agent_uid" | cut -d: -f1 || true)"
if [[ -z "$agent_user" ]]; then
  useradd --uid "$agent_uid" --user-group --system --home-dir /var/lib/csa-agent-runtime --no-create-home --shell /usr/sbin/nologin csa-agent
  agent_user=csa-agent
fi
if [[ "$agent_user" != csa-agent ]]; then
  echo "UID ${agent_uid} is already assigned to ${agent_user}; refusing to start the Agent Runtime." >&2
  exit 1
fi
agent_gid="$(id -g "$agent_user")"
desktop_home=/workspace/.desktop-home

install -d -m 0755 -o "$desktop_uid" -g "$desktop_gid" /run/csa-desktop /var/lib/csa-desktop
rm -f /etc/sudoers.d/csa-desktop
install -d -m 0700 -o "$agent_uid" -g "$agent_gid" /var/lib/csa-agent-runtime
chown -R "$agent_uid:$agent_gid" /var/lib/csa-agent-runtime
find /var/lib/csa-agent-runtime -type d -exec chmod 0700 {} +
install -d -m 0700 -o "$desktop_uid" -g "$desktop_gid" "$desktop_home"

# Start the system bus while the entrypoint still has root privileges. The
# desktop runs with no-new-privileges, so it cannot use sudo to start dbus.
install -d -m 0755 /run/dbus
if ! /usr/bin/dbus-send --system --dest=org.freedesktop.DBus --type=method_call --print-reply /org/freedesktop/DBus org.freedesktop.DBus.ListNames >/dev/null 2>&1; then
  /usr/bin/dbus-daemon --system --fork --nopidfile >/dev/null
  bus_ready=0
  for _ in $(seq 1 25); do
    if /usr/bin/dbus-send --system --dest=org.freedesktop.DBus --type=method_call --print-reply /org/freedesktop/DBus org.freedesktop.DBus.ListNames >/dev/null 2>&1; then
      bus_ready=1
      break
    fi
    sleep 0.2
  done
  if [[ "$bus_ready" != 1 ]]; then
    echo 'The Docker desktop system D-Bus did not become ready.' >&2
    exit 1
  fi
  echo 'csa_desktop.system_dbus.ready uid=0'
fi

export HOME="$desktop_home"
export COKE_DESKTOP_CHROME_NO_SANDBOX="${COKE_DESKTOP_CHROME_NO_SANDBOX:-0}"

exec setpriv --reuid="$desktop_uid" --regid="$desktop_gid" --init-groups \
  --inh-caps=-all --ambient-caps=-all \
  /usr/local/bin/csa-desktop-session
