#!/usr/bin/env bash
set -euo pipefail

registry_name="csa-local-registry"
registry_image="registry:2.8.3"
registry_port="15001"
registry_data_dir="${CSA_LOCAL_REGISTRY_DATA_DIR:-$HOME/.local/share/csa-cube-node/registry-data}"

command -v docker >/dev/null 2>&1 || {
  echo "Docker is required to run the local image registry." >&2
  exit 1
}

mkdir -p "$registry_data_dir"
container_id="$(docker ps -aq --filter "name=^/${registry_name}$")"
if [[ -n "$container_id" ]]; then
  current_image="$(docker inspect --format '{{.Config.Image}}' "$registry_name")"
  current_port="$(docker inspect --format '{{with index .HostConfig.PortBindings "5000/tcp"}}{{with index . 0}}{{.HostIp}}:{{.HostPort}}{{end}}{{end}}' "$registry_name")"
  current_data_dir="$(docker inspect --format '{{range .Mounts}}{{if eq .Destination "/var/lib/registry"}}{{.Source}}{{end}}{{end}}' "$registry_name")"
  if [[ "$current_image" != "$registry_image" || "$current_port" != "127.0.0.1:${registry_port}" || "$current_data_dir" != "$registry_data_dir" ]]; then
    echo "Existing ${registry_name} does not match the expected image, loopback port, or persistent data path; leaving it unchanged." >&2
    echo "image=${current_image} port=${current_port} data=${current_data_dir}" >&2
    exit 1
  fi
  if [[ "$(docker inspect --format '{{.State.Status}}' "$registry_name")" != "running" ]]; then
    docker start "$registry_name"
  fi
else
  docker run --detach \
    --name "$registry_name" \
    --restart unless-stopped \
    --publish "127.0.0.1:${registry_port}:5000" \
    --volume "${registry_data_dir}:/var/lib/registry" \
    "$registry_image"
fi

for attempt in {1..10}; do
  if curl --fail --silent --show-error --max-time 2 "http://127.0.0.1:${registry_port}/v2/" >/dev/null 2>&1; then
    echo "Local OCI registry is ready at http://127.0.0.1:${registry_port}; data: ${registry_data_dir}."
    exit 0
  fi
  sleep 1
done

echo "Local OCI registry did not become ready at 127.0.0.1:${registry_port}." >&2
docker logs --tail 40 "$registry_name" >&2 || true
exit 1
