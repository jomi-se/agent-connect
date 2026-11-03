#!/usr/bin/env bash
# Checks that the egress keeps its connection to the outside after leaving a
# session's network, the way a session ends. On Podman 4 this needs the egress
# keepalive; without it the shared rootless network is torn down and the
# egress is cut off. Any other running container on a Podman network keeps
# that network up and would hide the failure, so this refuses to run beside
# one: stop the gateway service and other containers first.
#
#   scripts/egress-keepalive.sh BOX_IMAGE [AGENT_CONNECT_BINARY] [--without-keepalive]
#
# --without-keepalive removes the keepalive before the cycle and must then
# FAIL on Podman 4, which shows the check can see the bug at all. Needs
# internet access (it connects to 1.1.1.1:443). Creates only acp-keepalive-*
# containers and networks and removes them on exit.
set -euo pipefail

image="${1:?box image}"
gateway="${2:-agent-connect}"
without="${3:-}"
name=acp-keepalive-check
network=acp-keepalive-check-net

others=$(podman ps --format '{{.Names}}' | grep -v "^$name" || true)
if [[ -n "$others" ]]; then
  echo "refusing: other running containers would keep the network up and hide the bug:" >&2
  echo "$others" >&2
  exit 2
fi

cleanup() {
  "$gateway" --container-engine podman egress stop --name "$name" >/dev/null 2>&1 || true
  podman network rm "$network" >/dev/null 2>&1 || true
}
trap cleanup EXIT

online() {
  podman exec "$name" node -e '
    const s = require("net").connect(443, "1.1.1.1", () => { console.log("online"); process.exit(0); });
    s.on("error", (e) => { console.log("offline: " + e.code); process.exit(1); });
    setTimeout(() => { console.log("offline: timeout"); process.exit(1); }, 4000);'
}

"$gateway" --container-engine podman egress start --name "$name" --box-image "$image" >/dev/null
if [[ "$without" == --without-keepalive ]]; then
  podman rm --force --time 0 "$name-keepalive" >/dev/null
fi
echo -n "before: "; online
podman network create --internal "$network" >/dev/null
podman network connect "$network" "$name"
podman network disconnect "$network" "$name"
echo -n "after the egress leaves a session network: "
online
