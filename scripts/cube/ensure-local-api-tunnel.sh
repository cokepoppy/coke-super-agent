#!/usr/bin/env bash
set -euo pipefail

LIMA_HOME="${LIMA_HOME:-$HOME/.local/share/csa-cube-node/lima}"
ssh_config="$LIMA_HOME/cube-node/ssh.config"

if [[ ! -f "$ssh_config" ]]; then
  echo "Cube node SSH config not found. Start the local node first." >&2
  exit 1
fi

if ! ssh -F "$ssh_config" -O check lima-cube-node >/dev/null 2>&1; then
  ssh -F "$ssh_config" -MNf lima-cube-node
fi

if ! curl -fsS --max-time 2 http://127.0.0.1:13000/health 2>/dev/null | grep -qx '{"status":"ok"}'; then
  ssh -F "$ssh_config" -O forward -L 127.0.0.1:13000:127.0.0.1:3000 lima-cube-node
fi

proxy_status="$(curl -sS --max-time 2 -o /dev/null -w '%{http_code}' \
  -H 'Host: 49983-00000000000000000000000000000000.cube.app' \
  http://127.0.0.1:28080/ 2>/dev/null || true)"
if [[ "$proxy_status" != 404 ]]; then
  ssh -F "$ssh_config" -O cancel -L 127.0.0.1:28080:127.0.0.1:80 lima-cube-node >/dev/null 2>&1 || true
  ssh -F "$ssh_config" -O forward -L 127.0.0.1:28080:127.0.0.1:80 lima-cube-node
fi
proxy_status="$(curl -sS --max-time 2 -o /dev/null -w '%{http_code}' \
  -H 'Host: 49983-00000000000000000000000000000000.cube.app' \
  http://127.0.0.1:28080/ 2>/dev/null || true)"
if [[ "$proxy_status" != 404 ]]; then
  echo "CubeProxy tunnel did not reach the CubeProxy HTTP ingress (status ${proxy_status:-unreachable})." >&2
  exit 1
fi
curl -fsS --max-time 5 http://127.0.0.1:13000/health >/dev/null
echo "CubeAPI loopback tunnel is ready on 127.0.0.1:13000."
echo "CubeProxy loopback tunnel responds on 127.0.0.1:28080."
