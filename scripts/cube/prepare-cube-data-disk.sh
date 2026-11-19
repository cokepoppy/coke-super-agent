#!/usr/bin/env bash
set -euo pipefail

device=/dev/vdb
mount_path=/data/cubelet
fstab=/etc/fstab
expected_bytes=68719476736
expected_label=CSA_CUBE
apply=0

case "$#" in
  0) ;;
  1) if [[ "$1" == "--apply" ]]; then apply=1; else
       echo "Usage: $0 [--apply]" >&2; exit 2
     fi ;;
  *) echo "Usage: $0 [--apply]" >&2; exit 2 ;;
esac

if [[ "$(id -u)" -ne 0 ]]; then
  echo "Run this guest-side check as root (for example, via sudo -n)." >&2
  exit 1
fi

# Serialize apply runs before inspecting the disk. Check-only runs create nothing.
if [[ "$apply" -eq 1 ]]; then
  exec 9>/run/lock/csa-cube-data-disk.lock
  if ! flock -n 9; then
    echo "Another data-disk setup is already running." >&2
    exit 1
  fi
fi

if [[ ! -b "$device" ]] || ! size="$(blockdev --getsize64 "$device")" ||
   [[ "$size" != "$expected_bytes" ]]; then
  echo "Expected the dedicated 64 GiB Lima disk at $device." >&2
  exit 1
fi
if ! disk_type="$(lsblk -dn -o TYPE "$device")" ||
   ! disk_layout="$(lsblk -nr -o NAME "$device")" ||
   ! device_id="$(lsblk -dn -o MAJ:MIN "$device")"; then
  echo "Could not inspect the disk layout of $device." >&2
  exit 1
fi
disk_type="$(printf '%s' "$disk_type" | tr -d '[:space:]')"
device_id="$(printf '%s' "$device_id" | tr -d '[:space:]')"
if [[ "$disk_type" != "disk" || -z "$disk_layout" || "$disk_layout" == *$'\n'* || -z "$device_id" ]]; then
  echo "$device must be an unpartitioned whole disk without child devices." >&2
  exit 1
fi
if [[ -L "$mount_path" ]]; then
  echo "$mount_path is a symlink; inspect it before proceeding." >&2
  exit 1
fi

if ! mounts="$(findmnt --kernel --all --raw --noheadings --output TARGET,MAJ:MIN)"; then
  echo "Could not inspect mounted filesystems." >&2
  exit 1
fi
target_id="$(printf '%s\n' "$mounts" | awk -v target="$mount_path" '$1 == target { print $2 }')"
other_mount="$(printf '%s\n' "$mounts" | awk -v target="$mount_path" -v id="$device_id" '$2 == id && $1 != target { print $1; exit }')"
if [[ -n "$other_mount" ]]; then
  echo "$device is also mounted at $other_mount; inspect it before proceeding." >&2
  exit 1
fi
mounted=0
if [[ -n "$target_id" ]]; then
  if [[ "$target_id" != "$device_id" ]] ||
     ! target_info="$(findmnt --kernel --raw --noheadings --mountpoint "$mount_path" --output MAJ:MIN,FSTYPE,FSROOT,OPTIONS)"; then
    echo "$mount_path is mounted from an unexpected device." >&2
    exit 1
  fi
  read -r mounted_id mounted_type mounted_root mounted_options <<< "$target_info"
  if [[ "$mounted_id" != "$device_id" || "$mounted_type" != "xfs" || "$mounted_root" != "/" ]] ||
     [[ ",$mounted_options," != *,rw,* ]]; then
    echo "$mount_path is not a read-write mount of the expected XFS filesystem root." >&2
    exit 1
  fi
  mounted=1
elif [[ -e "$mount_path" ]]; then
  if [[ ! -d "$mount_path" ]] || ! contents="$(find "$mount_path" -mindepth 1 -maxdepth 1 -print -quit)" || [[ -n "$contents" ]]; then
    echo "$mount_path must be an empty directory before mounting." >&2
    exit 1
  fi
fi

if ! signatures="$(wipefs --no-act --noheadings --output TYPE "$device")"; then
  echo "Could not inspect filesystem signatures on $device." >&2
  exit 1
fi
signatures="$(printf '%s\n' "$signatures" | awk 'NF { print $1 }')"
uuid=
if [[ -n "$signatures" ]]; then
  if [[ "$signatures" != "xfs" ]] ||
     ! fs_type="$(blkid -p -s TYPE -o value "$device")" ||
     ! fs_label="$(blkid -p -s LABEL -o value "$device")" ||
     ! uuid="$(blkid -p -s UUID -o value "$device")" ||
     [[ "$fs_type" != "xfs" || "$fs_label" != "$expected_label" || ! "$uuid" =~ ^[[:xdigit:]]{8}-[[:xdigit:]]{4}-[[:xdigit:]]{4}-[[:xdigit:]]{4}-[[:xdigit:]]{12}$ ]]; then
    echo "$device contains an unexpected or ambiguous filesystem; refusing to modify it." >&2
    exit 1
  fi
  if ! xfs_details="$(xfs_info "$device")" ||
     [[ ! "$xfs_details" =~ (^|[[:space:]])reflink=1([[:space:]]|$) ]]; then
    echo "$device is not a verified XFS reflink filesystem." >&2
    exit 1
  fi
elif [[ "$mounted" -eq 1 ]]; then
  echo "$device is mounted but has no readable filesystem signature." >&2
  exit 1
fi

if [[ ! -r "$fstab" ]]; then
  echo "Cannot read $fstab; refusing to change the disk." >&2
  exit 1
fi
if [[ -s "$fstab" && -n "$(tail -c 1 "$fstab")" ]]; then
  echo "$fstab has no trailing newline; inspect it before proceeding." >&2
  exit 1
fi
fstab_entry=0
while read -r entry_source entry_target entry_type entry_options _; do
  [[ -z "$entry_source" || "$entry_source" == \#* ]] && continue
  if [[ "$entry_target" == "$mount_path" ]]; then
    if [[ "$fstab_entry" -eq 1 || -z "$uuid" || "$entry_source" != "UUID=$uuid" || "$entry_type" != "xfs" || -z "$entry_options" ]] ||
       [[ ",$entry_options," == *,ro,* || ",$entry_options," == *,noauto,* || ",$entry_options," == *,bind,* || ",$entry_options," == *,rbind,* ]]; then
      echo "$fstab has a conflicting entry for $mount_path; inspect it before proceeding." >&2
      exit 1
    fi
    fstab_entry=1
  elif [[ "$entry_source" == "$device" || "$entry_source" == "LABEL=$expected_label" || ( -n "$uuid" && "$entry_source" == "UUID=$uuid" ) ]] ||
       { [[ "$entry_source" == /dev/* && -e "$entry_source" ]] && [[ "$(readlink -f "$entry_source")" == "$(readlink -f "$device")" ]]; }; then
    echo "$fstab references this disk at $entry_target; inspect it before proceeding." >&2
    exit 1
  fi
done < "$fstab"

if [[ "$apply" -eq 0 ]]; then
  if [[ -z "$signatures" ]]; then
    echo "CHECK: $device is a blank 64 GiB disk. Pass --apply to format and mount it."
  elif [[ "$mounted" -eq 1 && "$fstab_entry" -eq 1 ]]; then
    echo "PASS: $device is mounted at $mount_path with XFS reflink and an fstab entry."
  else
    echo "CHECK: $device contains the expected XFS filesystem. Pass --apply to finish mounting and persistence."
  fi
  exit 0
fi

if [[ -z "$signatures" ]]; then
  if ! command -v mkfs.xfs >/dev/null 2>&1; then
    echo "Install xfsprogs in the guest before formatting this disk." >&2
    exit 1
  fi
  mkfs.xfs -m reflink=1 -L "$expected_label" "$device"
  if ! uuid="$(blkid -p -s UUID -o value "$device")" ||
     [[ ! "$uuid" =~ ^[[:xdigit:]]{8}-[[:xdigit:]]{4}-[[:xdigit:]]{4}-[[:xdigit:]]{4}-[[:xdigit:]]{12}$ ]] ||
     ! xfs_details="$(xfs_info "$device")" ||
     [[ ! "$xfs_details" =~ (^|[[:space:]])reflink=1([[:space:]]|$) ]]; then
    echo "Formatting finished, but the new XFS filesystem could not be verified; inspect it before proceeding." >&2
    exit 1
  fi
fi

if [[ "$mounted" -eq 0 ]]; then
  mkdir -p "$mount_path"
  mount "$device" "$mount_path"
  if ! target_info="$(findmnt --kernel --raw --noheadings --mountpoint "$mount_path" --output MAJ:MIN,FSTYPE,FSROOT,OPTIONS)"; then
    echo "Could not verify the new mount at $mount_path." >&2
    exit 1
  fi
  read -r mounted_id mounted_type mounted_root mounted_options <<< "$target_info"
  if [[ "$mounted_id" != "$device_id" || "$mounted_type" != "xfs" || "$mounted_root" != "/" ]] ||
     [[ ",$mounted_options," != *,rw,* ]]; then
    echo "The new mount at $mount_path does not match the expected filesystem." >&2
    exit 1
  fi
fi
if [[ "$fstab_entry" -eq 0 ]]; then
  printf 'UUID=%s %s xfs defaults,nofail 0 2\n' "$uuid" "$mount_path" >> "$fstab"
fi
systemctl daemon-reload
echo "PASS: $device is mounted at $mount_path with XFS reflink and an fstab entry."
