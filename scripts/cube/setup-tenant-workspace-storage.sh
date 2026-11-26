#!/usr/bin/env bash
set -euo pipefail

# Run as root inside the dedicated Cube node, after /data/cubelet is mounted.
# The bind target is under CubeMaster's default allowed /data/shared prefix;
# the actual files live on the capacity-limited XFS data disk.
source_dir=/data/cubelet/csa-tenant-workspaces
target_dir=/data/shared/csa-tenant-workspaces
expected_fstab="$source_dir $target_dir none bind,nofail,x-systemd.requires-mounts-for=/data/cubelet 0 0"

[[ "$(id -u)" == 0 ]] || { echo 'Run as root on the Cube node.' >&2; exit 1; }
exec 9>/run/csa-tenant-storage.lock
flock -x 9
[[ "$(findmnt -n -o FSTYPE --mountpoint /data/cubelet)" == xfs ]] || { echo 'The Cube XFS data disk is not mounted at /data/cubelet.' >&2; exit 1; }
[[ ! -L "$source_dir" && ! -L "$target_dir" ]] || { echo 'Workspace storage paths must not be symlinks.' >&2; exit 1; }

existing_entry="$(awk -v target="$target_dir" '$1 !~ /^#/ && $2 == target {print}' /etc/fstab)"
if [[ -n "$existing_entry" && "$existing_entry" != "$expected_fstab" ]]; then
  echo 'A different fstab entry already owns the workspace mount target.' >&2
  exit 1
fi

mkdir -p -m 0700 -- "$source_dir" "$target_dir"
if ! mountpoint -q "$target_dir"; then
  [[ -z "$(find "$target_dir" -mindepth 1 -maxdepth 1 -print -quit)" ]] || { echo 'The unmounted workspace target is not empty.' >&2; exit 1; }
  mount --bind "$source_dir" "$target_dir"
fi
[[ "$(stat -c '%d:%i' "$source_dir")" == "$(stat -c '%d:%i' "$target_dir")" ]] || { echo 'Workspace bind mount does not point to the expected XFS directory.' >&2; exit 1; }

if [[ -z "$existing_entry" ]]; then
  backup="/etc/fstab.csa-tenant-workspaces.$(date -u +%Y%m%dT%H%M%SZ).bak"
  cp -p -- /etc/fstab "$backup"
  printf '\n%s\n' "$expected_fstab" >> /etc/fstab
  systemctl daemon-reload
  printf 'fstab_backup=%s\n' "$backup"
fi
printf 'workspace_storage_ready source=%s target=%s filesystem=xfs\n' "$source_dir" "$target_dir"
