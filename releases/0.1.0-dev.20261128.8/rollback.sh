#!/bin/bash
set -euo pipefail
umask 077

repo_root="$(cd "$(dirname "$0")/../.." && pwd -P)"
release_id="$(basename "$(dirname "$0")")"
state_root="$HOME/.local/share/coke-super-agent"
state_file="$state_root/releases/$release_id/state.json"
env_file="$HOME/.local/share/csa-cube-node/coke-super-agent.env"
launch_domain="gui/$(/usr/bin/id -u)"

if [ ! -r "$state_file" ] || [ ! -r "$env_file" ]; then
  echo "No deployment state is available for release $release_id." >&2
  exit 1
fi

target="$(python3 - "$state_file" <<'PY'
import json, pathlib, sys
state = json.loads(pathlib.Path(sys.argv[1]).read_text())
target = pathlib.Path(state["previousTarget"])
if not target.is_dir(): raise SystemExit("Previous application snapshot is missing: " + str(target))
print(target)
PY
)"

python3 - "$state_file" "$env_file" <<'PY'
import json, os, pathlib, stat, sys, tempfile
state = json.loads(pathlib.Path(sys.argv[1]).read_text())
env_path = pathlib.Path(sys.argv[2])
lines = env_path.read_text().splitlines()
values = {
    "CSA_AGENT_RUNTIME": state["previousRuntime"],
    "CSA_CUBE_WORKSPACE_MODE": state["previousWorkspaceMode"],
    "CSA_DSH_PLACEMENT": state["previousPlacement"],
    "CSA_DOCKER_DESKTOP_IMAGE": state["previousDesktopImage"],
}
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
PY

python3 - "$target" "$state_root/current" <<'PY'
import os, pathlib, sys
target, link = sys.argv[1], pathlib.Path(sys.argv[2])
tmp = link.with_name(".current.rollback")
try: tmp.unlink()
except FileNotFoundError: pass
os.symlink(target, tmp)
os.replace(tmp, link)
PY

write_launch_agent() {
  label="$1"
  template="$repo_root/deploy/macos/$label.plist"
  output="$state_root/rollback/$release_id/launch-agents/$label.plist"
  mkdir -p "$(dirname "$output")"
  python3 - "$template" "$target" "$output" <<'PY'
import os, pathlib, plistlib, sys, tempfile
template, target, output = map(pathlib.Path, sys.argv[1:])
source = target / "source"
web = target / "web"
with template.open("rb") as f: job = plistlib.load(f)
args = list(job["ProgramArguments"])
for i, arg in enumerate(args):
    if arg.endswith("/current/source/node_modules/tsx/dist/cli.mjs"):
        args[i] = str(source / "node_modules/tsx/dist/cli.mjs")
    elif arg.endswith("/current/source/node_modules/vite/bin/vite.js"):
        args[i] = str(source / "node_modules/vite/bin/vite.js")
    elif arg == "/Users/shangguan/.local/share/coke-super-agent/current/web":
        args[i] = str(web)
job["ProgramArguments"] = args
job["WorkingDirectory"] = str(source)
output.parent.mkdir(parents=True, exist_ok=True)
fd, tmp = tempfile.mkstemp(prefix=".plist.", dir=str(output.parent))
try:
    with os.fdopen(fd, "wb") as f: plistlib.dump(job, f, sort_keys=False)
    os.chmod(tmp, 0o644)
    os.replace(tmp, output)
finally:
    if os.path.exists(tmp): os.unlink(tmp)
PY
  /usr/bin/plutil -lint "$output"
}

restart_service() {
  label="$1"
  source_plist="$state_root/rollback/$release_id/launch-agents/$label.plist"
  destination="$HOME/Library/LaunchAgents/$label.plist"
  if /bin/launchctl print "$launch_domain/$label" >/dev/null 2>&1; then
    bootout_status=0
    /bin/launchctl bootout "$launch_domain/$label" >/dev/null 2>&1 || bootout_status=$?
    removed=0
    for _ in $(seq 1 100); do
      if ! /bin/launchctl print "$launch_domain/$label" >/dev/null 2>&1; then removed=1; break; fi
      sleep 0.3
    done
    if [ "$removed" != "1" ]; then
      echo "LaunchAgent $label remained loaded after bootout status $bootout_status." >&2
      return 1
    fi
  fi
  /usr/bin/install -m 0644 "$source_plist" "$destination"
  bootstrap_status=0
  /bin/launchctl bootstrap "$launch_domain" "$destination" >/dev/null 2>&1 || bootstrap_status=$?
  loaded=0
  for _ in $(seq 1 100); do
    if /bin/launchctl print "$launch_domain/$label" >/dev/null 2>&1; then loaded=1; break; fi
    sleep 0.3
  done
  if [ "$loaded" != "1" ]; then
    echo "LaunchAgent $label failed to register (bootstrap status $bootstrap_status)." >&2
    return 1
  fi
  echo "rollback stage=launchagent.loaded label=$label bootstrap_status=$bootstrap_status"
}

require_listener_release() {
  port="$1"
  expected_cwd="$2"
  expected_arg="$3"
  pids="$(/usr/sbin/lsof -nP -tiTCP:"$port" -sTCP:LISTEN 2>/dev/null || true)"
  count="$(printf '%s\n' "$pids" | awk 'NF { n += 1 } END { print n + 0 }')"
  if [ "$count" != "1" ]; then
    echo "Expected one listener on port $port after rollback; found $count." >&2
    return 1
  fi
  pid="$(printf '%s\n' "$pids" | sed -n '1p')"
  actual_cwd="$(/usr/sbin/lsof -a -p "$pid" -d cwd -Fn 2>/dev/null | sed -n 's/^n//p' | sed -n '1p')"
  if [ "$actual_cwd" != "$expected_cwd" ]; then
    echo "Port $port is served from unexpected process cwd: $actual_cwd" >&2
    return 1
  fi
  command_line="$(ps -p "$pid" -o command=)"
  case "$command_line" in
    *"$expected_arg"*) ;;
    *) echo "Port $port listener does not reference the expected rollback path: $expected_arg" >&2; return 1 ;;
  esac
  echo "rollback stage=listener.verified port=$port pid=$pid cwd=$actual_cwd"
}

write_launch_agent com.coke.super-agent.api
write_launch_agent com.coke.super-agent.public-web
restart_service com.coke.super-agent.api
restart_service com.coke.super-agent.public-web

ready=0
for _ in $(seq 1 60); do
  if curl -fsS --max-time 2 http://127.0.0.1:8080/health >/dev/null \
    && curl -fsS --max-time 2 http://127.0.0.1:5174/super-agent/health >/dev/null \
    && curl -fsS --max-time 3 https://codex.cokeagent.com/super-agent/health >/dev/null \
    && curl -fsS --max-time 3 https://codex.cokeagent.com/super-agent/ >/dev/null; then
    ready=1
    break
  fi
  sleep 1
done
if [ "$ready" != "1" ]; then
  echo "Rollback health checks failed." >&2
  exit 1
fi
require_listener_release 8080 "$target/source" "src/server/index.ts"
require_listener_release 5174 "$target/source" "$target/web"
echo "rollback=$release_id local_api=200 local_web=200 public=200"
