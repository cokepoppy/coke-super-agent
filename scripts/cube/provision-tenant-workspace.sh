#!/usr/bin/env bash
set -euo pipefail

# Installed root-owned on the dedicated Cube node; called by the local API.
source_dir=/data/cubelet/csa-tenant-workspaces
target_dir=/data/shared/csa-tenant-workspaces
tenant_id="${1:-}"
[[ "$(id -u)" == 0 && "$#" == 1 ]] || { echo 'Expected one tenant UUID and root.' >&2; exit 1; }
[[ "$tenant_id" =~ ^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$ ]] || { echo 'Invalid tenant UUID.' >&2; exit 1; }

exec 9>/run/csa-tenant-workspaces.lock
flock -x 9
[[ "$(findmnt -n -o FSTYPE --mountpoint /data/cubelet)" == xfs ]] || { echo 'Cube XFS data disk is unavailable.' >&2; exit 1; }
[[ ! -L "$source_dir" && ! -L "$target_dir" ]] || { echo 'Workspace storage paths must not be symlinks.' >&2; exit 1; }
mountpoint -q "$target_dir" || { echo 'The tenant workspace bind mount is unavailable.' >&2; exit 1; }
[[ "$(stat -c '%d:%i' "$source_dir")" == "$(stat -c '%d:%i' "$target_dir")" ]] || { echo 'Workspace bind mount points to an unexpected directory.' >&2; exit 1; }

workspace="$target_dir/$tenant_id"
[[ ! -L "$workspace" ]] || { echo 'Tenant workspace must not be a symlink.' >&2; exit 1; }
if [[ ! -e "$workspace" ]]; then
  mkdir -m 0700 -- "$workspace"
  chown 1000:1000 -- "$workspace"
elif [[ ! -d "$workspace" ]]; then
  echo 'Tenant workspace exists but is not a directory.' >&2
  exit 1
fi
printf '%s\n' "$workspace"
