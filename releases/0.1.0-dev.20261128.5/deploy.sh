#!/bin/bash
set -euo pipefail
umask 077

repo_root="$(cd "$(dirname "$0")/../.." && pwd -P)"
release_id="$(basename "$(dirname "$0")")"
state_root="$HOME/.local/share/coke-super-agent"
artifact_root="$state_root/releases"
artifact="$artifact_root/$release_id"
baseline="$state_root/rollback/$release_id"
env_file="$HOME/.local/share/csa-cube-node/coke-super-agent.env"
node_bin="$HOME/.local/opt/node-v24.18.0-darwin-arm64/bin/node"
lima_bin="$HOME/Library/Application Support/Coke Super Agent/lab/lima-2.3.0/bin/limactl"
launch_domain="gui/$(/usr/bin/id -u)"
api_plist="$HOME/Library/LaunchAgents/com.coke.super-agent.api.plist"

if [ -e "$artifact" ]; then
  echo "Release artifacts already exist: $artifact" >&2
  exit 1
fi
if [ ! -r "$env_file" ] || [ ! -x "$node_bin" ] || [ ! -x "$lima_bin" ]; then
  echo "Required application or Cube node configuration is missing." >&2
  exit 1
fi
desktop_image="csa-super-agent-desktop:20261128.10"
expected_runtime_key="993ab6f3b625cc1775cd07ef68b1efa5877fbe11de4c4c941af4f9e8387f85b0"
desktop_image_platform="$(docker image inspect --format '{{.Os}}/{{.Architecture}}' "$desktop_image")"
desktop_runtime_key="$(docker image inspect --format '{{index .Config.Labels "com.coke-super-agent.dsh-runtime-key"}}' "$desktop_image")"
if [ "$desktop_image_platform" != "linux/arm64" ] || [ "$desktop_runtime_key" != "$expected_runtime_key" ]; then
  echo "The Docker DSH image is missing, has the wrong architecture, or does not match this release." >&2
  exit 1
fi
if [ -n "$(git -C "$repo_root" status --porcelain)" ]; then
  echo "Commit all source, release scripts, and plist changes before deploying." >&2
  exit 1
fi
cd "$repo_root"

branch="$(git branch --show-current)"
head_commit="$(git rev-parse HEAD)"
upstream_commit="$(git rev-parse '@{u}')"
main_commit="$(git rev-parse main)"
origin_main_commit="$(git rev-parse origin/main)"
if [ "$branch" != "feat/dsh-agent-runtime" ] || [ "$head_commit" != "$upstream_commit" ] || [ "$main_commit" != "$origin_main_commit" ]; then
  echo "Expected the pushed single feature branch and a current main branch." >&2
  exit 1
fi

free_lab_kib="$(df -Pk "$HOME/.local/share/csa-cube-node" | awk 'NR == 2 { print $4 }')"
free_home_kib="$(df -Pk "$HOME" | awk 'NR == 2 { print $4 }')"
if [ "$free_lab_kib" -lt 12582912 ] || [ "$free_home_kib" -lt 1048576 ]; then
  echo "Disk preflight failed: Cube requires 12 GiB free and the app volume requires 1 GiB free." >&2
  exit 1
fi
LIMA_HOME="$HOME/.local/share/csa-cube-node/lima" "$lima_bin" shell cube-node -- sudo -n bash -lc 'mountpoint -q /data/shared/csa-tenant-workspaces && test -x /usr/local/sbin/csa-ensure-tenant-workspace'

mkdir -p "$artifact_root" "$state_root/rollback"
chmod 0700 "$state_root"
mkdir -m 0700 "$artifact" "$baseline"
mkdir "$artifact/source" "$baseline/source"
exec > >(tee -a "$artifact/deploy.log") 2>&1
echo "release=$release_id stage=preflight commit=$head_commit"

active_run_count() {
  DOTENV_CONFIG_PATH="$env_file" "$node_bin" "$repo_root/node_modules/tsx/dist/cli.mjs" -e '
import mysql from "mysql2/promise";
import { config } from "./src/server/config.ts";
void (async () => {
  const db = await mysql.createConnection(config.mysql);
  const [rows] = await db.query("SELECT COUNT(*) AS n FROM runs WHERE status NOT IN (?, ?, ?)", ["done", "failed", "cancelled"]);
  console.log(Number(rows[0].n));
  await db.end();
})().catch(error => { console.error("Database run-status query failed: " + (error instanceof Error ? error.message : String(error))); process.exitCode = 1; });
'
}
active_runs="$(active_run_count)"
if [ "$active_runs" != "0" ]; then
  echo "There are active or queued Agent runs; refusing the API restart." >&2
  exit 1
fi
echo "release=$release_id stage=tasks-clear active_runs=$active_runs"

git archive "$head_commit" | tar -xf - -C "$artifact/source"
git archive "$main_commit" | tar -xf - -C "$baseline/source"
ln -s "$repo_root/node_modules" "$artifact/source/node_modules"
ln -s "$repo_root/node_modules" "$baseline/source/node_modules"

echo "release=$release_id stage=build-current"
(cd "$artifact/source" && CSA_PUBLIC_BASE_PATH=/super-agent/ npm run build -- --outDir "$artifact/web" --emptyOutDir)
echo "release=$release_id stage=build-rollback commit=$main_commit"
(cd "$baseline/source" && CSA_PUBLIC_BASE_PATH=/super-agent/ npm run build -- --outDir "$baseline/web" --emptyOutDir)

active_runs="$(active_run_count)"
if [ "$active_runs" != "0" ]; then
  echo "An Agent run started while building; refusing the API restart." >&2
  exit 1
fi

echo "release=$release_id stage=migrate"
DOTENV_CONFIG_PATH="$env_file" npm run db:migrate
migration_four="$(DOTENV_CONFIG_PATH="$env_file" "$node_bin" "$repo_root/node_modules/tsx/dist/cli.mjs" -e '
import mysql from "mysql2/promise";
import { config } from "./src/server/config.ts";
void (async () => {
  const db = await mysql.createConnection(config.mysql);
  const [rows] = await db.query("SELECT COUNT(*) AS n FROM schema_migrations WHERE version = 4");
  console.log(Number(rows[0].n));
  await db.end();
})().catch(error => { console.error("Database migration check failed: " + (error instanceof Error ? error.message : String(error))); process.exitCode = 1; });
')"
if [ "$migration_four" != "1" ]; then
  echo "Database migration 4 was not applied; refusing the API restart." >&2
  exit 1
fi

CSA_RELEASE_COMMIT="$head_commit" python3 - "$env_file" "$artifact/state.json" "$baseline" "$api_plist" <<'PY'
import json, os, pathlib, plistlib, sys
env_path, state_path, baseline, installed_plist = map(pathlib.Path, sys.argv[1:])
lines = env_path.read_text().splitlines()
values = {}
for key in ("CSA_AGENT_RUNTIME", "CSA_CUBE_WORKSPACE_MODE", "CSA_DSH_PLACEMENT", "CSA_DOCKER_DESKTOP_IMAGE"):
    matches = [line.split("=", 1)[1] for line in lines if line.startswith(key + "=")]
    values[key] = matches[-1] if matches else ""
previous = baseline.resolve()
try:
    with installed_plist.open("rb") as f:
        working = pathlib.Path(plistlib.load(f).get("WorkingDirectory", ""))
    if working.name == "source":
        candidate = working.parent.resolve()
        if (candidate / "source").is_dir() and (candidate / "web").is_dir():
            previous = candidate
except (OSError, ValueError, plistlib.InvalidFileException):
    pass
state = {
    "release": state_path.parent.name,
    "previousRuntime": values["CSA_AGENT_RUNTIME"],
    "previousWorkspaceMode": values["CSA_CUBE_WORKSPACE_MODE"],
    "previousPlacement": values["CSA_DSH_PLACEMENT"],
    "previousDesktopImage": values["CSA_DOCKER_DESKTOP_IMAGE"],
    "previousTarget": str(previous),
    "commit": os.environ["CSA_RELEASE_COMMIT"],
}
state_path.write_text(json.dumps(state, sort_keys=True) + "\n")
os.chmod(state_path, 0o600)
PY

python3 - "$env_file" <<'PY'
import os, pathlib, stat, sys, tempfile
path = pathlib.Path(sys.argv[1])
lines = path.read_text().splitlines()
desired = {
    "CSA_AGENT_RUNTIME": "dsh",
    "CSA_CUBE_WORKSPACE_MODE": "lima",
    "CSA_DSH_PLACEMENT": "docker",
    "CSA_DOCKER_DESKTOP_IMAGE": "csa-super-agent-desktop:20261128.10",
}
updated = []
seen = set()
for line in lines:
    key = line.split("=", 1)[0] if "=" in line else ""
    if key in desired:
        updated.append(key + "=" + desired[key])
        seen.add(key)
    else:
        updated.append(line)
for key, value in desired.items():
    if key not in seen:
        updated.append(key + "=" + value)
fd, tmp = tempfile.mkstemp(prefix=".release-env.", dir=str(path.parent))
try:
    os.fchmod(fd, stat.S_IMODE(path.stat().st_mode))
    with os.fdopen(fd, "w") as out:
        out.write("\n".join(updated) + "\n")
        out.flush()
        os.fsync(out.fileno())
    os.replace(tmp, path)
finally:
    if os.path.exists(tmp): os.unlink(tmp)
PY

python3 - "$artifact" "$state_root/current" <<'PY'
import os, pathlib, sys
target, link = sys.argv[1], pathlib.Path(sys.argv[2])
tmp = link.with_name(".current.next")
try: tmp.unlink()
except FileNotFoundError: pass
os.symlink(target, tmp)
os.replace(tmp, link)
PY

write_launch_agent() {
  label="$1"
  target="$2"
  template="$repo_root/deploy/macos/$label.plist"
  output="$artifact/launch-agents/$label.plist"
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
  source_plist="$artifact/launch-agents/$label.plist"
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
  echo "release=$release_id stage=launchagent.loaded label=$label bootstrap_status=$bootstrap_status"
}

require_listener_release() {
  port="$1"
  expected_cwd="$2"
  expected_arg="$3"
  pids="$(/usr/sbin/lsof -nP -tiTCP:"$port" -sTCP:LISTEN 2>/dev/null || true)"
  count="$(printf '%s\n' "$pids" | awk 'NF { n += 1 } END { print n + 0 }')"
  if [ "$count" != "1" ]; then
    echo "Expected one listener on port $port after restart; found $count." >&2
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
    *) echo "Port $port listener does not reference the expected release path: $expected_arg" >&2; return 1 ;;
  esac
  echo "release=$release_id stage=listener.verified port=$port pid=$pid cwd=$actual_cwd"
}

write_launch_agent com.coke.super-agent.api "$artifact"
write_launch_agent com.coke.super-agent.public-web "$artifact"
active_runs="$(active_run_count)"
if [ "$active_runs" != "0" ]; then
  echo "An Agent run started before restart; refusing to stop the API." >&2
  exit 1
fi
echo "release=$release_id stage=service.restart"
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
  echo "Release did not pass local and public health checks. Run this release's rollback.sh." >&2
  exit 1
fi
require_listener_release 8080 "$artifact/source" "src/server/index.ts"
require_listener_release 5174 "$artifact/source" "$artifact/web"
auth_status="$(curl -sS --max-time 3 -o /dev/null -w '%{http_code}' http://127.0.0.1:8080/api/auth/session)"
if [ "$auth_status" != "401" ]; then
  echo "Expected unauthenticated API session to return 401; got $auth_status." >&2
  exit 1
fi
echo "release=$release_id stage=complete commit=$head_commit migration=4 runtime=dsh workspace=lima desktop_probe=filesystem x11_probe=10s-x4 desktop_lease=mysql-advisory session_reuse=live-probe api=200 local_web=200 public=200 anonymous_api=$auth_status"
