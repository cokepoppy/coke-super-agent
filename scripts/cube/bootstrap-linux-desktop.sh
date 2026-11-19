#!/usr/bin/env bash
set -Eeuo pipefail

export DEBIAN_FRONTEND=noninteractive
export LANG=C.UTF-8
state_dir=/var/lib/csa-desktop
apt_log="$state_dir/apt.log"

install -d -m 0755 "$state_dir"

if ! command -v apt-get >/dev/null 2>&1; then
  echo "The CubeSandbox base image does not provide apt-get." >&2
  exit 1
fi

if ! apt-get -o Acquire::Retries=5 -o Acquire::http::Timeout=30 update >>"$apt_log" 2>&1; then
  tail -80 "$apt_log" >&2 || true
  exit 1
fi
if ! apt-get -o Acquire::Retries=5 -o Acquire::http::Timeout=30 install -y --no-install-recommends \
  ca-certificates chromium curl dbus-x11 fonts-dejavu-core fonts-noto-cjk locales \
  nodejs npm novnc procps python3 python3-pip python3-venv scrot sudo util-linux websockify \
  x11-utils x11vnc xdotool xfce4 xfce4-terminal xvfb >>"$apt_log" 2>&1; then
  tail -80 "$apt_log" >&2 || true
  exit 1
fi
apt-get clean
rm -rf /var/lib/apt/lists/*

desktop_user="$(getent passwd 1000 | cut -d: -f1 || true)"
if [[ -z "$desktop_user" ]]; then
  desktop_user=csa
  if ! id "$desktop_user" >/dev/null 2>&1; then
    useradd --uid 1000 --create-home --shell /bin/bash "$desktop_user"
  fi
fi

desktop_uid="$(id -u "$desktop_user")"
desktop_gid="$(id -g "$desktop_user")"
desktop_home=/workspace/.desktop-home
install -d -m 0755 /usr/local/bin /var/lib/csa-desktop /run/csa-desktop /workspace "$desktop_home/.config/chromium" "$desktop_home/.vnc"
mkdir -p /tmp/.X11-unix
chown -R "$desktop_uid:$desktop_gid" /workspace
printf '%s ALL=(ALL) NOPASSWD: ALL\n' "$desktop_user" > /etc/sudoers.d/csa-desktop
chmod 0440 /etc/sudoers.d/csa-desktop
visudo -cf /etc/sudoers.d/csa-desktop >/dev/null

install -m 0755 /tmp/csa-desktop-session.sh /usr/local/bin/csa-desktop-session
chrome_bin="$(command -v chromium || command -v chromium-browser || true)"
if [[ -z "$chrome_bin" ]]; then
  echo "Chromium was not installed from the configured CubeSandbox guest package sources." >&2
  exit 1
fi
if [[ ! -f /usr/share/novnc/vnc.html ]]; then
  echo "The noVNC web client files were not installed in the CubeSandbox guest." >&2
  exit 1
fi

if ! curl -fsS --max-time 5 http://127.0.0.1:6080/vnc.html >/dev/null 2>&1; then
  runuser -u "$desktop_user" -- env HOME="$desktop_home" DISPLAY=:1 \
    COKE_DESKTOP_CHROME_BIN="$chrome_bin" COKE_DESKTOP_START_URL=about:blank \
    /usr/local/bin/csa-desktop-session >/tmp/csa-desktop-session.log 2>&1 </dev/null &
fi

ready=0
deadline=$((SECONDS + 300))
while ((SECONDS < deadline)); do
  if curl -fsS --max-time 5 http://127.0.0.1:6080/vnc.html >/dev/null 2>&1 \
    && curl -fsS --max-time 5 http://127.0.0.1:9222/json/version >/dev/null 2>&1; then
    ready=1
    break
  fi
  sleep 2
done
if [[ "$ready" != 1 ]]; then
  tail -80 /tmp/csa-desktop-session.log >&2 || true
  echo "The Linux desktop did not become ready within 300 seconds." >&2
  exit 1
fi

printf '%s\n' "$(date -u +%FT%TZ)" > /var/lib/csa-desktop/ready
printf 'desktop_ready user=%s node=%s python=%s chromium=%s\n' \
  "$desktop_user" "$(node --version)" "$(python3 --version)" "$chrome_bin"
