#!/usr/bin/env bash
set -u

printf 'guest.profile.user='
id user 2>&1
getent passwd user

for path in /home/user /home/user/.config /home/user/.config/chromium /home/user/.cache /home/user/.cache/chromium /workspace /workspace/.desktop-home /workspace/.desktop-home/.config /workspace/.desktop-home/.config/chromium /workspace/.desktop-home/.config/chromium/Crashpad "/workspace/.desktop-home/.config/chromium/Crash Reports" /run/user/1000; do
  if [[ -e "$path" ]]; then
    stat -c 'guest.profile.path=%n type=%F uid=%u gid=%g mode=%a' "$path"
  else
    printf 'guest.profile.path=%s missing\n' "$path"
  fi
done

printf 'guest.profile.live_chromium_processes.start\n'
for pid in $(ps -eo pid=,stat=,comm= | awk '$3 == "chromium" && $2 !~ /Z|X/ { print $1 }'); do
  uid="$(awk '/^Uid:/ { print $2 }' "/proc/$pid/status" 2>/dev/null)"
  home="$(tr '\0' '\n' <"/proc/$pid/environ" 2>/dev/null | sed -n 's/^HOME=//p' | head -n 1)"
  user_data="$(tr '\0' '\n' <"/proc/$pid/cmdline" 2>/dev/null | sed -n 's/^--user-data-dir=//p' | head -n 1)"
  debug_port="$(tr '\0' '\n' <"/proc/$pid/cmdline" 2>/dev/null | sed -n 's/^--remote-debugging-port=//p' | head -n 1)"
  display="$(tr '\0' '\n' <"/proc/$pid/environ" 2>/dev/null | sed -n 's/^DISPLAY=//p' | head -n 1)"
  session_bus="$(tr '\0' '\n' <"/proc/$pid/environ" 2>/dev/null | grep -c '^DBUS_SESSION_BUS_ADDRESS=' || true)"
  home_display="$home"
  user_data_display="$user_data"
  debug_port_display="$debug_port"
  display_display="$display"
  [[ -n "$home_display" ]] || home_display=unset
  [[ -n "$user_data_display" ]] || user_data_display=unset
  [[ -n "$debug_port_display" ]] || debug_port_display=unset
  [[ -n "$display_display" ]] || display_display=unset
  printf 'guest.profile.chrome pid=%s uid=%s home=%s user_data_dir=%s debug_port=%s display=%s session_bus_present=%s\n' \
    "$pid" "$uid" "$home_display" "$user_data_display" "$debug_port_display" "$display_display" "$session_bus"
  for path in "$home" "$home/.config" "$home/.config/chromium" "$home/.cache" "$home/.cache/chromium" "$user_data" "$user_data/Crashpad" "$user_data/Crash Reports"; do
    [[ -n "$path" ]] || continue
    if [[ -e "$path" ]]; then
      stat -c 'guest.profile.path=%n type=%F uid=%u gid=%g mode=%a' "$path"
    else
      printf 'guest.profile.path=%s missing\n' "$path"
    fi
  done
done
printf 'guest.profile.live_chromium_processes.end\n'
if [[ -r /tmp/csa-desktop-session.log ]]; then
  printf 'guest.profile.desktop_session_log.start\n'
  grep -E 'chrome_cdp_diagnostics|chrome\.(started|cdp|launch)|chrome\.startup\.failed|event=.*(failed|error)' /tmp/csa-desktop-session.log | tail -n 100 | sed -E 's#(DevTools listening on ws://)[^[:space:]]+#\1[redacted]#g'
  printf 'guest.profile.desktop_session_log.end\n'
else
  printf 'guest.profile.desktop_session_log=missing\n'
fi
if [[ -r /tmp/csa-chromium.log ]]; then
  printf 'guest.profile.chromium_log.start\n'
  tail -n 40 /tmp/csa-chromium.log | sed -E 's#(DevTools listening on ws://)[^[:space:]]+#\1[redacted]#g'
  printf 'guest.profile.chromium_log.end\n'
else
  printf 'guest.profile.chromium_log=missing\n'
fi
df -h /
