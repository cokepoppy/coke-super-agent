#!/bin/bash
set -euo pipefail

release_id="$(basename "$(dirname "$0")")"
state_root="$HOME/.local/share/coke-super-agent"
state_file="$state_root/releases/$release_id/state.json"
current_link="$state_root/current"
env_file="$HOME/.local/share/csa-cube-node/coke-super-agent.env"
launch_domain="gui/$(/usr/bin/id -u)"

if [ ! -r "$state_file" ] || [ ! -r "$env_file" ]; then
  echo "No deployment state is available for release $release_id." >&2
  exit 1
fi

python3 - "$state_file" "$env_file" "$current_link" <<'PY'
import json, os, pathlib, stat, sys, tempfile
state = json.loads(pathlib.Path(sys.argv[1]).read_text())
env_path = pathlib.Path(sys.argv[2])
current = pathlib.Path(sys.argv[3])
lines = env_path.read_text().splitlines()
values = {"CSA_AGENT_RUNTIME": state["previousRuntime"], "CSA_CUBE_WORKSPACE_MODE": state["previousWorkspaceMode"]}
updated = []
seen = set()
for line in lines:
    key = line.split("=", 1)[0] if "=" in line else ""
    if key in values:
        if values[key]: updated.append(key + "=" + values[key])
        seen.add(key)
    else:
        updated.append(line)
for key, value in values.items():
    if key not in seen and value: updated.append(key + "=" + value)
fd, tmp = tempfile.mkstemp(prefix=".release-env.rollback.", dir=str(env_path.parent))
try:
    os.fchmod(fd, stat.S_IMODE(env_path.stat().st_mode))
    with os.fdopen(fd, "w") as out:
        out.write("\n".join(updated) + "\n")
        out.flush()
        os.fsync(out.fileno())
    os.replace(tmp, env_path)
finally:
    if os.path.exists(tmp): os.unlink(tmp)
target = pathlib.Path(state["previousTarget"])
if not target.is_dir(): raise SystemExit("Previous application snapshot is missing: " + str(target))
next_link = current.with_name(".current.rollback")
try: next_link.unlink()
except FileNotFoundError: pass
os.symlink(str(target), next_link)
os.replace(next_link, current)
PY

repo_root="$(cd "$(dirname "$0")/../.." && pwd -P)"
for label in com.coke.super-agent.api com.coke.super-agent.public-web; do
  plist="$repo_root/deploy/macos/$label.plist"
  destination="$HOME/Library/LaunchAgents/$label.plist"
  /usr/bin/plutil -lint "$plist"
  if /bin/launchctl print "$launch_domain/$label" >/dev/null 2>&1; then
    /bin/launchctl bootout "$launch_domain/$label"
  fi
  /usr/bin/install -m 0644 "$plist" "$destination"
  /bin/launchctl bootstrap "$launch_domain" "$destination"
done

ready=0
for _ in $(seq 1 60); do
  if curl -fsS --max-time 2 http://127.0.0.1:8080/health >/dev/null \
    && curl -fsS --max-time 2 http://127.0.0.1:5174/super-agent/health >/dev/null \
    && curl -fsS --max-time 3 https://codex.cokeagent.com/super-agent/health >/dev/null; then
    ready=1
    break
  fi
  sleep 1
done
if [ "$ready" != "1" ]; then
  echo "Rollback health checks failed." >&2
  exit 1
fi

echo "rolled_back=$release_id"
