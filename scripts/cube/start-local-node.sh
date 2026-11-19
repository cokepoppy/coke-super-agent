#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "$0")/../.." && pwd)"
CSA_CUBE_LAB_HOME="$(printenv CSA_CUBE_LAB_HOME 2>/dev/null || true)"
if [[ -z "$CSA_CUBE_LAB_HOME" ]]; then
  CSA_CUBE_LAB_HOME="$HOME/.local/share/csa-cube-node"
fi
LIMA_HOME="$(printenv LIMA_HOME 2>/dev/null || true)"
if [[ -z "$LIMA_HOME" ]]; then
  LIMA_HOME="$CSA_CUBE_LAB_HOME/lima"
fi
LIMACTL="$(printenv LIMACTL 2>/dev/null || command -v limactl || true)"

if [[ -z "$LIMACTL" || ! -x "$LIMACTL" ]]; then
  echo "Set LIMACTL to the Lima 2.3.0 binary or add limactl to PATH." >&2
  exit 1
fi
if [[ ! -d "$CSA_CUBE_LAB_HOME" ]]; then
  echo "CSA_CUBE_LAB_HOME must be a mounted, capacity-limited lab volume: $CSA_CUBE_LAB_HOME" >&2
  exit 1
fi

lab_device="$(stat -f %d "$CSA_CUBE_LAB_HOME")"
home_device="$(stat -f %d "$HOME")"
if [[ "$lab_device" == "$home_device" ]]; then
  echo "The lab path is on the same filesystem as HOME; mount a dedicated lab volume first." >&2
  exit 1
fi
mkdir -p "$LIMA_HOME"
if [[ "$(stat -f %d "$LIMA_HOME")" != "$lab_device" ]]; then
  echo "LIMA_HOME must stay on the dedicated lab volume: $LIMA_HOME" >&2
  exit 1
fi
available_kib="$(df -Pk "$LIMA_HOME" | awk 'NR == 2 { print $4 }')"
minimum_kib=12582912
if [[ ! "$available_kib" =~ ^[0-9]+$ || "$available_kib" -lt "$minimum_kib" ]]; then
  echo "The lab volume needs at least 12 GiB free before starting CubeSandbox." >&2
  exit 1
fi

lima_version="$("$LIMACTL" --version)"
if [[ "$lima_version" != *"2.3.0"* ]]; then
  echo "Expected Lima 2.3.0; found: $lima_version" >&2
  exit 1
fi

export LIMA_HOME
disk_row="$("$LIMACTL" disk ls | awk '$1 == "cube-xfs" { print; found = 1 } END { if (!found) exit 1 }' || true)"
if [[ -z "$disk_row" ]]; then
  "$LIMACTL" disk create cube-xfs --size 64GiB --format raw
else
  read -r disk_name disk_size disk_format disk_dir disk_owner <<< "$disk_row"
  if [[ "$disk_size" != "64GiB" || "$disk_format" != "raw" ]]; then
    echo "Existing cube-xfs disk is not the expected 64 GiB raw disk; inspect it before proceeding." >&2
    exit 1
  fi
  if [[ -n "$disk_owner" && "$disk_owner" != "cube-node" ]]; then
    echo "cube-xfs is attached to another Lima instance: $disk_owner" >&2
    exit 1
  fi
fi

instance_names="$("$LIMACTL" list --quiet 2>/dev/null || true)"
if printf '%s\n' "$instance_names" | grep -qx cube-node; then
  "$LIMACTL" --tty=false start cube-node
else
  "$LIMACTL" --tty=false --name=cube-node start "$repo_root/infra/lima/cube-node.yaml"
fi

"$LIMACTL" shell cube-node -- sudo -n python3 - --kvm-only < "$repo_root/scripts/cube/preflight.py"
