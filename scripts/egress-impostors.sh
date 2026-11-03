#!/usr/bin/env bash
# Starts containers that carry the egress owner label and the egress proxy's
# own arguments with one weakening each, and checks that `agent-connect egress
# start` refuses every one of them. Run against each supported engine:
#
#   scripts/egress-impostors.sh docker|podman BOX_IMAGE [AGENT_CONNECT_BINARY]
#
# Creates only the containers acp-impostor and, on Podman, the gateway's
# acp-impostor-keepalive, refuses to start if either already exists, and
# removes both on exit. A weakening the engine refuses to create cannot be
# impersonated and is reported as skipped; a run that skips them all fails.
set -euo pipefail

engine="${1:?engine: docker or podman}"
image="${2:?box image}"
gateway="${3:-agent-connect}"
name=acp-impostor

baseline=(
  --detach --name "$name" --label org.agent-connect.component=acp-egress
  --restart=unless-stopped --log-driver=json-file --log-opt max-size=10m
  --read-only --cap-drop=ALL --security-opt=no-new-privileges
  --memory=256m --cpus=1 --pids-limit=64
)
[[ "$engine" == docker ]] && baseline+=(--log-opt max-file=3)

for existing in "$name" "$name-keepalive"; do
  if "$engine" inspect --type container "$existing" >/dev/null 2>&1; then
    echo "refusing: a container named $existing already exists and is not this run's" >&2
    exit 2
  fi
done
cleanup() { "$engine" rm -f "$name" >/dev/null 2>&1 || true; }
trap 'cleanup; "$engine" rm -f "$name-keepalive" >/dev/null 2>&1 || true' EXIT

# Each case is one weakening, given as extra run arguments.
cases=(
  "--privileged"
  "--security-opt seccomp=unconfined"
  "--security-opt apparmor=unconfined"
  "--pid=host"
  "--network=host"
  "-v /tmp:/impostor"
  "--mount type=tmpfs,dst=/impostor"
  "--device /dev/fuse"
  "-p 3128:3128"
  "--memory=512m"
  "-e NODE_OPTIONS=--inspect"
  "--cap-add=NET_RAW"
)

start() {
  cleanup
  local network=()
  # The gateway starts a Podman egress on the default bridge; a case that
  # chooses its own network replaces it, since Podman takes only one.
  [[ "$engine" == podman && "$1" != *--network* ]] && network=(--network podman)
  # shellcheck disable=SC2086  # each case is a word list on purpose
  "$engine" run "${network[@]}" "${baseline[@]}" $1 --entrypoint node "$image" \
    /opt/agent-connect/egress-proxy.mjs >/dev/null
}

failures=0
tried=0
egress() { "$gateway" --container-engine "$engine" egress start --name "$name" --box-image "$image"; }
# The gateway's own egress must be created and then pass revalidation, or
# every refusal below proves nothing.
cleanup
if egress >/dev/null && egress >/dev/null; then
  echo "accepted  (the gateway's own egress, revalidated)"
else
  echo "REFUSED   (the gateway's own egress): the matrix proves nothing"
  exit 1
fi
# On Podman the creation record alone refuses any hand-made container; this
# one has no weakening, so its refusal shows that layer is in force.
if [[ "$engine" == podman ]]; then
  start ""
  if egress >/dev/null 2>&1; then
    echo "ACCEPTED  (hand-made, unweakened): the creation record was not checked"
    failures=$((failures + 1))
  else
    echo "refused   (hand-made, unweakened): creation record differs"
  fi
fi
for weakening in "${cases[@]}"; do
  # A later flag overrides the baseline's (--memory).
  if ! start "$weakening" 2>/dev/null; then
    echo "skipped   $weakening (the engine refused to create it)"
    continue
  fi
  tried=$((tried + 1))
  if egress >/dev/null 2>&1; then
    echo "ACCEPTED  $weakening"
    failures=$((failures + 1))
  else
    echo "refused   $weakening"
  fi
done
if ((tried == 0)); then
  echo "every weakening was skipped: the matrix proves nothing"
  exit 1
fi
exit "$failures"
