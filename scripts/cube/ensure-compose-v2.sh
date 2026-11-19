#!/usr/bin/env bash
set -euo pipefail

check_only=0
case "$#" in
  0) ;;
  1) if [[ "$1" == "--check" ]]; then check_only=1; else
       echo "Usage: $0 [--check]" >&2; exit 2
     fi ;;
  *) echo "Usage: $0 [--check]" >&2; exit 2 ;;
esac

is_compose_v2() {
  [[ "$1" =~ ^Docker[[:space:]]Compose[[:space:]]version[[:space:]]v?2[.][0-9] ]]
}

if command -v docker-compose >/dev/null 2>&1 &&
   version="$(docker-compose version 2>/dev/null)" && is_compose_v2 "$version"; then
  echo "Docker Compose v2 is already available as docker-compose: $version"
  exit 0
fi
if [[ "$check_only" -eq 1 ]]; then
  echo "Docker Compose v2 is not available as docker-compose on PATH." >&2
  exit 1
fi
if [[ "$(id -u)" -ne 0 ]]; then
  echo "Run this guest-side setup as root (for example, via sudo -n)." >&2
  exit 1
fi

# Check for a collision before installing anything; never replace an existing command.
compat_path=/usr/local/bin/docker-compose
if [[ -e "$compat_path" || -L "$compat_path" ]]; then
  echo "$compat_path already exists, but the selected docker-compose is not v2; inspect the command and PATH before proceeding." >&2
  exit 1
fi

package_status="$(dpkg-query -W -f='${Status}' docker-compose-v2 2>/dev/null || true)"
if [[ "$package_status" != "install ok installed" ]]; then
  apt-get install -y --no-install-recommends docker-compose-v2
fi
if ! package_files="$(dpkg-query -L docker-compose-v2)"; then
  echo "Could not inspect the docker-compose-v2 package." >&2
  exit 1
fi
plugin_path="$(printf '%s\n' "$package_files" | awk '/\/docker\/cli-plugins\/docker-compose$/ && !found { print; found = 1 }')"
if [[ -z "$plugin_path" || ! -x "$plugin_path" ]] ||
   ! version="$("$plugin_path" version 2>/dev/null)" || ! is_compose_v2 "$version"; then
  echo "Could not verify the docker-compose-v2 plugin installed by apt." >&2
  exit 1
fi

ln -s "$plugin_path" "$compat_path"
if ! version="$(PATH="/usr/local/bin:$PATH" docker-compose version 2>/dev/null)" || ! is_compose_v2 "$version"; then
  echo "The docker-compose compatibility command could not be verified." >&2
  exit 1
fi
echo "Docker Compose v2 is available as docker-compose: $version"
