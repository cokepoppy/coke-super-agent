#!/usr/bin/env bash
set -euo pipefail

repo_root="/Users/shangguan/Documents/home2026/coke-super-agent"
launch_agents="$HOME/Library/LaunchAgents"
launch_domain="gui/$(/usr/bin/id -u)"
labels=(
  com.coke.super-agent.api
  com.coke.super-agent.public-web
  com.coke.super-agent.public-tunnel
)

mkdir -p "$launch_agents" "$HOME/Library/Logs"
for label in "${labels[@]}"; do
  source="$repo_root/deploy/macos/$label.plist"
  destination="$launch_agents/$label.plist"
  /usr/bin/plutil -lint "$source"
  if /bin/launchctl print "$launch_domain/$label" >/dev/null 2>&1; then
    /bin/launchctl bootout "$launch_domain/$label"
  fi
  /usr/bin/install -m 0644 "$source" "$destination"
  /bin/launchctl bootstrap "$launch_domain" "$destination"
done

for label in "${labels[@]}"; do
  /bin/launchctl print "$launch_domain/$label" >/dev/null
  printf 'loaded %s\n' "$label"
done
