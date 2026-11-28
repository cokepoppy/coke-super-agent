#!/bin/bash
set -euo pipefail
umask 077

repo_root="$(cd "$(dirname "$0")/../.." && pwd -P)"
release_id="$(basename "$(dirname "$0")")"
state_root="$HOME/.local/share/coke-super-agent"
artifact="$state_root/releases/$release_id"
env_file="$HOME/.local/share/csa-cube-node/coke-super-agent.env"
node_bin="$HOME/.local/opt/node-v24.18.0-darwin-arm64/bin/node"
launch_domain="gui/$(/usr/bin/id -u)"
label="com.coke.super-agent.public-web"
installed_plist="$HOME/Library/LaunchAgents/$label.plist"

if [ -e "$artifact" ]; then echo "Release already exists: $artifact" >&2; exit 1; fi
if [ ! -r "$env_file" ] || [ ! -x "$node_bin" ] || [ ! -r "$installed_plist" ]; then
  echo "Required local app configuration or public-web service is missing." >&2; exit 1
fi
if [ -n "$(git -C "$repo_root" status --porcelain)" ]; then echo "Commit all changes before deploying." >&2; exit 1; fi

cd "$repo_root"
branch="$(git branch --show-current)"
head_commit="$(git rev-parse HEAD)"
upstream_commit="$(git rev-parse '@{u}')"
main_commit="$(git rev-parse main)"
origin_main_commit="$(git rev-parse origin/main)"
if [ "$branch" != "feat/dsh-agent-runtime" ] || [ "$head_commit" != "$upstream_commit" ] || [ "$main_commit" != "$origin_main_commit" ]; then
  echo "Expected the pushed single feature branch and a current main branch." >&2; exit 1
fi

free_home_kib="$(df -Pk "$HOME" | awk 'NR == 2 { print $4 }')"
if [ "$free_home_kib" -lt 1048576 ]; then echo "Need at least 1 GiB free on the app volume." >&2; exit 1; fi
/bin/launchctl print "$launch_domain/com.coke.super-agent.api" >/dev/null
/bin/launchctl print "$launch_domain/com.coke.super-agent.public-tunnel" >/dev/null

read -r previous_source previous_web < <(python3 - "$installed_plist" <<'PY'
import pathlib, plistlib, sys
with pathlib.Path(sys.argv[1]).open("rb") as f: job = plistlib.load(f)
args = job.get("ProgramArguments", [])
index = args.index("--outDir")
print(job["WorkingDirectory"], args[index + 1])
PY
)
if [ -z "$previous_web" ] || [ ! -d "$previous_web" ] || [ ! -d "$previous_source" ]; then
  echo "Could not verify the currently served public-web release." >&2; exit 1
fi

mkdir -p "$state_root/releases"
chmod 0700 "$state_root"
mkdir -m 0700 "$artifact"
mkdir "$artifact/source" "$artifact/launch-agents"
exec > >(tee -a "$artifact/deploy.log") 2>&1
echo "release=$release_id stage=preflight commit=$head_commit web_only=true api_restart=false"

git archive "$head_commit" | tar -xf - -C "$artifact/source"
ln -s "$repo_root/node_modules" "$artifact/source/node_modules"
echo "release=$release_id stage=build-public-web"
(cd "$artifact/source" && CSA_PUBLIC_BASE_PATH=/super-agent/ npm run build -- --outDir "$artifact/web" --emptyOutDir)

python3 - "$artifact/state.json" "$previous_source" "$previous_web" "$head_commit" <<'PY'
import json, os, pathlib, sys
path = pathlib.Path(sys.argv[1])
state = {"release": path.parent.name, "previousSource": sys.argv[2], "previousWeb": sys.argv[3], "commit": sys.argv[4], "component": "public-web-only"}
path.write_text(json.dumps(state, sort_keys=True) + "\n")
os.chmod(path, 0o600)
PY

python3 - "$repo_root/deploy/macos/$label.plist" "$artifact/source" "$artifact/web" "$artifact/launch-agents/$label.plist" <<'PY'
import os, pathlib, plistlib, sys, tempfile
template, source, web, output = map(pathlib.Path, sys.argv[1:])
with template.open("rb") as f: job = plistlib.load(f)
node = "/Users/shangguan/.local/opt/node-v24.18.0-darwin-arm64/bin/node"
job["ProgramArguments"] = [node, str(source / "node_modules/vite/bin/vite.js"), "preview", "--host", "127.0.0.1", "--port", "5174", "--strictPort", "--outDir", str(web)]
job["WorkingDirectory"] = str(source)
output.parent.mkdir(parents=True, exist_ok=True)
fd, temporary = tempfile.mkstemp(prefix=".plist.", dir=str(output.parent))
try:
    with os.fdopen(fd, "wb") as f: plistlib.dump(job, f, sort_keys=False)
    os.chmod(temporary, 0o644)
    os.replace(temporary, output)
finally:
    if os.path.exists(temporary): os.unlink(temporary)
PY
/usr/bin/plutil -lint "$artifact/launch-agents/$label.plist"

bootout_status=0
/bin/launchctl bootout "$launch_domain/$label" >/dev/null 2>&1 || bootout_status=$?
removed=0
for _ in $(seq 1 100); do
  if ! /bin/launchctl print "$launch_domain/$label" >/dev/null 2>&1; then removed=1; break; fi
  sleep 0.3
done
if [ "$removed" != "1" ]; then echo "Public web LaunchAgent stayed loaded (bootout status $bootout_status)." >&2; exit 1; fi
/usr/bin/install -m 0644 "$artifact/launch-agents/$label.plist" "$installed_plist"
bootstrap_status=0
/bin/launchctl bootstrap "$launch_domain" "$installed_plist" >/dev/null 2>&1 || bootstrap_status=$?
loaded=0
for _ in $(seq 1 100); do
  if /bin/launchctl print "$launch_domain/$label" >/dev/null 2>&1; then loaded=1; break; fi
  sleep 0.3
done
if [ "$loaded" != "1" ]; then echo "Public web LaunchAgent failed to register (bootstrap status $bootstrap_status)." >&2; exit 1; fi

curl --fail --silent --show-error --max-time 15 http://127.0.0.1:5174/super-agent/ -o "$artifact/index.html"
css_path="$(python3 - "$artifact/index.html" <<'PY'
import re, sys
text = open(sys.argv[1], encoding="utf-8").read()
match = re.search(r'href="([^"]+\.css)"', text)
if not match: raise SystemExit("No CSS bundle in built page")
print(match.group(1))
PY
)"
css_path="${css_path#/}"
curl --fail --silent --show-error --max-time 15 "http://127.0.0.1:5174/$css_path" -o "$artifact/served.css"
if ! grep -q 'desktop-frame' "$artifact/served.css" || ! grep -q 'height:0' "$artifact/served.css"; then
  echo "Served CSS does not contain the cloud-desktop fill sizing." >&2; exit 1
fi
curl --fail --silent --show-error --max-time 20 https://codex.cokeagent.com/super-agent/ -o "$artifact/public.html"
public_css_path="$(python3 - "$artifact/public.html" <<'PY'
import re, sys
text = open(sys.argv[1], encoding="utf-8").read()
match = re.search(r'href="([^"]+\.css)"', text)
if not match: raise SystemExit("No public CSS bundle in page")
print(match.group(1))
PY
)"
curl --fail --silent --show-error --max-time 20 "https://codex.cokeagent.com$public_css_path" -o "$artifact/public.css"
if ! grep -q 'desktop-frame' "$artifact/public.css" || ! grep -q 'height:0' "$artifact/public.css"; then
  echo "Public CSS does not contain the cloud-desktop fill sizing." >&2; exit 1
fi
curl --fail --silent --show-error --max-time 15 http://127.0.0.1:8080/health -o /dev/null
/bin/launchctl print "$launch_domain/com.coke.super-agent.api" >/dev/null
/bin/launchctl print "$launch_domain/com.coke.super-agent.public-tunnel" >/dev/null
echo "release=$release_id stage=verification.complete public_page=200 api_health=200 api_restarted=false tunnel_restarted=false"
echo "release=$release_id stage=rollback_target source=$previous_source web=$previous_web"
rm -f -- "$artifact/index.html" "$artifact/served.css" "$artifact/public.html" "$artifact/public.css"
