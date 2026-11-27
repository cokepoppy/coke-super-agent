#!/bin/bash
set -euo pipefail
umask 077

repo_root="$(cd "$(dirname "$0")/../.." && pwd -P)"
release_id="$(basename "$(dirname "$0")")"
state_root="$HOME/.local/share/coke-super-agent"
artifact_root="$state_root/releases"
artifact="$artifact_root/$release_id"
baseline="$state_root/rollback/$release_id"
current_link="$state_root/current"
env_file="$HOME/.local/share/csa-cube-node/coke-super-agent.env"
node_bin="$HOME/.local/opt/node-v24.18.0-darwin-arm64/bin/node"
lima_bin="$HOME/Library/Application Support/Coke Super Agent/lab/lima-2.3.0/bin/limactl"
launch_domain="gui/$(/usr/bin/id -u)"

if [ -e "$artifact" ]; then
  echo "Release artifacts already exist: $artifact" >&2
  exit 1
fi
if [ ! -r "$env_file" ] || [ ! -x "$node_bin" ] || [ ! -x "$lima_bin" ]; then
  echo "Required application or Cube node configuration is missing." >&2
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

mkdir -p "$artifact_root" "$state_root/rollback"
chmod 0700 "$state_root"
mkdir -m 0700 "$artifact" "$baseline"
mkdir "$artifact/source" "$baseline/source"
git archive "$head_commit" | tar -xf - -C "$artifact/source"
git archive "$main_commit" | tar -xf - -C "$baseline/source"
ln -s "$repo_root/node_modules" "$artifact/source/node_modules"
ln -s "$repo_root/node_modules" "$baseline/source/node_modules"

(cd "$artifact/source" && CSA_PUBLIC_BASE_PATH=/super-agent/ npm run build -- --outDir "$artifact/web" --emptyOutDir)
(cd "$baseline/source" && CSA_PUBLIC_BASE_PATH=/super-agent/ npm run build -- --outDir "$baseline/web" --emptyOutDir)

active_runs="$(active_run_count)"
if [ "$active_runs" != "0" ]; then
  echo "An Agent run started while building the release; refusing the API restart." >&2
  exit 1
fi

CSA_RELEASE_COMMIT="$head_commit" DOTENV_CONFIG_PATH="$env_file" npm run db:migrate

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

CSA_RELEASE_COMMIT="$head_commit" python3 - "$env_file" "$artifact/state.json" "$baseline" <<'PY'
import json, os, pathlib, stat, sys, tempfile
env_path = pathlib.Path(sys.argv[1])
state_path = pathlib.Path(sys.argv[2])
baseline = pathlib.Path(sys.argv[3])
lines = env_path.read_text().splitlines()
values = {}
for key in ("CSA_AGENT_RUNTIME", "CSA_CUBE_WORKSPACE_MODE"):
    matches = [line.split("=", 1)[1] for line in lines if line.startswith(key + "=")]
    values[key] = matches[-1] if matches else ""
current = pathlib.Path.home() / ".local/share/coke-super-agent/current"
if current.is_symlink():
    previous = pathlib.Path(os.readlink(current))
    if not previous.is_absolute(): previous = (current.parent / previous).resolve()
else:
    previous = baseline
state = {
    "release": state_path.parent.name,
    "previousRuntime": values["CSA_AGENT_RUNTIME"],
    "previousWorkspaceMode": values["CSA_CUBE_WORKSPACE_MODE"],
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
updated = []
seen = set()
for line in lines:
    key = line.split("=", 1)[0] if "=" in line else ""
    if key == "CSA_AGENT_RUNTIME":
        updated.append("CSA_AGENT_RUNTIME=dsh"); seen.add(key)
    elif key == "CSA_CUBE_WORKSPACE_MODE":
        updated.append("CSA_CUBE_WORKSPACE_MODE=lima"); seen.add(key)
    else:
        updated.append(line)
if "CSA_AGENT_RUNTIME" not in seen: updated.append("CSA_AGENT_RUNTIME=dsh")
if "CSA_CUBE_WORKSPACE_MODE" not in seen: updated.append("CSA_CUBE_WORKSPACE_MODE=lima")
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

python3 - "$artifact" "$current_link" <<'PY'
import os, pathlib, sys
target, link = sys.argv[1], pathlib.Path(sys.argv[2])
tmp = link.with_name(".current.next")
try: tmp.unlink()
except FileNotFoundError: pass
os.symlink(target, tmp)
os.replace(tmp, link)
PY

restart_service() {
  label="$1"
  plist="$repo_root/deploy/macos/$label.plist"
  destination="$HOME/Library/LaunchAgents/$label.plist"
  /usr/bin/plutil -lint "$plist"
  if /bin/launchctl print "$launch_domain/$label" >/dev/null 2>&1; then
    /bin/launchctl bootout "$launch_domain/$label"
  fi
  /usr/bin/install -m 0644 "$plist" "$destination"
  /bin/launchctl bootstrap "$launch_domain" "$destination"
}
restart_service com.coke.super-agent.api
restart_service com.coke.super-agent.public-web

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
  echo "Release did not pass local and public health checks. Run this release's rollback.sh." >&2
  exit 1
fi

auth_status="$(curl -sS --max-time 3 -o /dev/null -w '%{http_code}' http://127.0.0.1:8080/api/auth/session)"
if [ "$auth_status" != "401" ]; then
  echo "Expected unauthenticated API session request to return 401; got $auth_status." >&2
  exit 1
fi

echo "release=$release_id commit=$head_commit local_api=200 local_public=200 public=200 anonymous_api=$auth_status migration=4 active_runs=$active_runs"
