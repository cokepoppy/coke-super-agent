#!/usr/bin/env bash
set -euo pipefail

target="${CSA_VPS_SSH_TARGET:-ubuntu@119.29.119.26}"
remote_port="${CSA_VPS_SUPER_AGENT_PORT:-14331}"
local_port="${CSA_SUPER_AGENT_WEB_PORT:-5173}"
ssh_bin="${CSA_SSH_BIN:-ssh}"

if [[ ! "$target" =~ ^[A-Za-z0-9._@-]+$ ]]; then
  echo "CSA_VPS_SSH_TARGET must be an SSH user@host or configured SSH alias." >&2
  exit 2
fi
for item in "$remote_port" "$local_port"; do
  if [[ ! "$item" =~ ^[0-9]+$ ]] || ((item < 1 || item > 65535)); then
    echo "Tunnel ports must be between 1 and 65535." >&2
    exit 2
  fi
done

ssh_args=(
  -N -T
  -o BatchMode=yes
  -o ExitOnForwardFailure=yes
  -o StrictHostKeyChecking=yes
  -o ServerAliveInterval=30
  -o ServerAliveCountMax=3
  -o TCPKeepAlive=yes
  -R "127.0.0.1:${remote_port}:127.0.0.1:${local_port}"
)
if [[ -n "${CSA_VPS_SSH_IDENTITY_FILE:-}" ]]; then
  if [[ ! -r "$CSA_VPS_SSH_IDENTITY_FILE" ]]; then
    echo "CSA_VPS_SSH_IDENTITY_FILE does not name a readable SSH identity file." >&2
    exit 2
  fi
  ssh_args+=(-i "$CSA_VPS_SSH_IDENTITY_FILE" -o IdentitiesOnly=yes)
fi

printf 'Starting loopback-only Super Agent tunnel remote_port=%s local_port=%s target=%s\n' "$remote_port" "$local_port" "$target"
exec "$ssh_bin" "${ssh_args[@]}" "$target"
