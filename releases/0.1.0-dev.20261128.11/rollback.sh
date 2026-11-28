#!/bin/bash
set -euo pipefail
umask 077

release_id="$(basename "$(dirname "$0")")"
state_root="$HOME/.local/share/coke-super-agent"
state_file="$state_root/releases/$release_id/state.json"
label="com.coke.super-agent.public-web"
installed_plist="$HOME/Library/LaunchAgents/$label.plist"
launch_domain="gui/$(/usr/bin/id -u)"
if [ ! -r "$state_file" ]; then echo "No rollback state for $release_id." >&2; exit 1; fi

read -r previous_source previous_web < <(python3 - "$state_file" <<'PY'
import json, pathlib, sys
state = json.loads(pathlib.Path(sys.argv[1]).read_text())
if state.get("component") != "public-web-only": raise SystemExit("Unexpected release component")
print(state["previousSource"], state["previousWeb"])
PY
)
if [ ! -d "$previous_source" ] || [ ! -d "$previous_web" ]; then echo "Previous public-web build is missing." >&2; exit 1; fi

repo_root="$(cd "$(dirname "$0")/../.." && pwd -P)"
rollback_plist="$state_root/rollback/$release_id/$label.plist"
mkdir -p "$(dirname "$rollback_plist")"
python3 - "$repo_root/deploy/macos/$label.plist" "$previous_source" "$previous_web" "$rollback_plist" <<'PY'
import os, pathlib, plistlib, sys, tempfile
template, source, web, output = map(pathlib.Path, sys.argv[1:])
with template.open("rb") as f: job = plistlib.load(f)
node = "/Users/shangguan/.local/opt/node-v24.18.0-darwin-arm64/bin/node"
job["ProgramArguments"] = [node, str(source / "node_modules/vite/bin/vite.js"), "preview", "--host", "127.0.0.1", "--port", "5174", "--strictPort", "--outDir", str(web)]
job["WorkingDirectory"] = str(source)
output.parent.mkdir(parents=True, exist_ok=True)
fd, temporary = tempfile.mkstemp(prefix=".plist.rollback.", dir=str(output.parent))
try:
    with os.fdopen(fd, "wb") as f: plistlib.dump(job, f, sort_keys=False)
    os.chmod(temporary, 0o644)
    os.replace(temporary, output)
finally:
    if os.path.exists(temporary): os.unlink(temporary)
PY
/usr/bin/plutil -lint "$rollback_plist"

/bin/launchctl bootout "$launch_domain/$label" >/dev/null 2>&1 || true
removed=0
for _ in $(seq 1 100); do
  if ! /bin/launchctl print "$launch_domain/$label" >/dev/null 2>&1; then removed=1; break; fi
  sleep 0.3
done
if [ "$removed" != "1" ]; then echo "Public web LaunchAgent stayed loaded during rollback." >&2; exit 1; fi
/usr/bin/install -m 0644 "$rollback_plist" "$installed_plist"
/bin/launchctl bootstrap "$launch_domain" "$installed_plist"
curl --fail --silent --show-error --max-time 15 http://127.0.0.1:5174/super-agent/ -o /dev/null
curl --fail --silent --show-error --max-time 20 https://codex.cokeagent.com/super-agent/ -o /dev/null
curl --fail --silent --show-error --max-time 15 http://127.0.0.1:8080/health -o /dev/null
echo "rollback=$release_id stage=verification.complete api_restarted=false tunnel_restarted=false"
