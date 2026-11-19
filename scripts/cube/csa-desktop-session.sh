#!/usr/bin/env bash
set -Eeuo pipefail

export DISPLAY="${DISPLAY:-:1}"
export HOME="${HOME:-/workspace/.desktop-home}"
resolution="${COKE_DESKTOP_RESOLUTION:-1440x900}"
start_url="${COKE_DESKTOP_START_URL:-about:blank}"
chrome_bin="${COKE_DESKTOP_CHROME_BIN:-$(command -v chromium || command -v chromium-browser)}"
profile_dir="$HOME/.config/chromium"

if [[ "$(id -u)" == 0 ]]; then
  echo "Run the desktop session as the non-root UID 1000 user." >&2
  exit 1
fi

exec 9>"$HOME/.csa-desktop-session.lock"
if ! flock -n 9; then
  echo "A Linux desktop session is already running."
  exit 0
fi

if ! pgrep -x Xvfb >/dev/null 2>&1; then
  rm -f /tmp/.X1-lock /tmp/.X11-unix/X1
fi

mkdir -p "$profile_dir" "$HOME/.vnc" /workspace/.coke-desktop /tmp/.X11-unix
rm -f "$profile_dir/SingletonLock" "$profile_dir/SingletonCookie" "$profile_dir/SingletonSocket"

Xvfb "$DISPLAY" -screen 0 "${resolution}x24" -nolisten tcp -ac +extension GLX +render -noreset >/tmp/csa-xvfb.log 2>&1 &
xvfb_pid=$!
xfce_pid=""; vnc_pid=""; websockify_pid=""; chrome_pid=""
cleanup() {
  trap - EXIT INT TERM
  kill "$xvfb_pid" "$xfce_pid" "$vnc_pid" "$websockify_pid" "$chrome_pid" 2>/dev/null || true
  wait 2>/dev/null || true
}
trap cleanup EXIT INT TERM

for _ in $(seq 1 50); do
  xdpyinfo -display "$DISPLAY" >/dev/null 2>&1 && break
  sleep 0.2
done
xdpyinfo -display "$DISPLAY" >/dev/null 2>&1

dbus-launch --exit-with-session startxfce4 >/tmp/csa-xfce.log 2>&1 &
xfce_pid=$!
x11vnc -display "$DISPLAY" -nopw -localhost -rfbport 5900 -forever -shared -noxdamage >/tmp/csa-vnc.log 2>&1 &
vnc_pid=$!
websockify --web=/usr/share/novnc 0.0.0.0:6080 127.0.0.1:5900 >/tmp/csa-websockify.log 2>&1 &
websockify_pid=$!

chrome_flags=(
  --disable-dev-shm-usage --disable-gpu --no-first-run --no-default-browser-check
  --password-store=basic --remote-debugging-address=127.0.0.1 --remote-debugging-port=9222
  --user-data-dir="$profile_dir" --start-maximized
)
"$chrome_bin" "${chrome_flags[@]}" "$start_url" >/tmp/csa-chromium.log 2>&1 &
chrome_pid=$!

while true; do
  for pid in "$xfce_pid" "$vnc_pid" "$websockify_pid"; do
    kill -0 "$pid" 2>/dev/null || { echo "desktop component exited" >&2; exit 1; }
  done
  if ! kill -0 "$chrome_pid" 2>/dev/null; then
    "$chrome_bin" "${chrome_flags[@]}" "$start_url" >>/tmp/csa-chromium.log 2>&1 &
    chrome_pid=$!
  fi
  sleep 5
done
