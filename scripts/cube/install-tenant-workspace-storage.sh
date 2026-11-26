#!/usr/bin/env bash
set -euo pipefail

# Run on the Mac after the dedicated Cube node and its XFS disk are ready.
repo_root="$(cd "$(dirname "$0")/../.." && pwd)"
LIMACTL="${LIMACTL:-$HOME/Library/Application Support/Coke Super Agent/lab/lima-2.3.0/bin/limactl}"
LIMA_HOME="${LIMA_HOME:-$HOME/.local/share/csa-cube-node/lima}"
export LIMA_HOME
[[ -x "$LIMACTL" ]] || { echo 'Set LIMACTL to the local Lima executable.' >&2; exit 1; }

"$LIMACTL" shell cube-node -- sudo -n bash -s < "$repo_root/scripts/cube/setup-tenant-workspace-storage.sh"
"$LIMACTL" shell cube-node -- sudo -n bash -c '
  set -euo pipefail
  exec 9>/run/csa-tenant-helper-install.lock
  flock -x 9
  destination=/usr/local/sbin/csa-ensure-tenant-workspace
  [ ! -L "$destination" ] || { echo "Workspace helper must not be a symlink." >&2; exit 1; }
  tmp=$(mktemp /usr/local/sbin/.csa-tenant-workspace.XXXXXXXX)
  trap '\''rm -f -- "$tmp"'\'' EXIT
  cat > "$tmp"
  chmod 0755 "$tmp"
  chown root:root "$tmp"
  if [ -e "$destination" ] && ! cmp -s "$tmp" "$destination"; then
    backup="$destination.$(date -u +%Y%m%dT%H%M%SZ).bak"
    [ ! -e "$backup" ] || { echo "Helper backup already exists." >&2; exit 1; }
    cp -p -- "$destination" "$backup"
    printf "helper_backup=%s\n" "$backup"
  fi
  mv -f -- "$tmp" "$destination"
  trap - EXIT
  sha256sum "$destination"
' < "$repo_root/scripts/cube/provision-tenant-workspace.sh"
