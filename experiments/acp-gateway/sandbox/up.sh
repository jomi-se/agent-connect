#!/usr/bin/env bash
# Build the session image and start the internal network, mock model and
# egress proxy. Idempotent. Run from experiments/acp-gateway.
set -euo pipefail
docker network inspect acp-internal >/dev/null 2>&1 || docker network create --internal acp-internal >/dev/null
docker network inspect acp-egress >/dev/null 2>&1 || docker network create acp-egress >/dev/null
../../deploy/acp-gateway/session/build-local.sh
docker tag agent-connect-session:0.1.0 acp-spike-session:dev
docker rm -f acp-mock acp-egress-proxy >/dev/null 2>&1 || true
mkdir -p .run/box
docker run -d --name acp-mock --network acp-internal --network-alias mock --user "$(id -u):$(id -g)" \
  -v "$PWD/mock-model:/app:ro" -v "$PWD/.run/box:/log" \
  -e MOCK_HOST=0.0.0.0 -e MOCK_PORT=18931 -e MOCK_LOG=/log/mock-requests.jsonl \
  node:24-bookworm-slim node /app/server.mjs >/dev/null
docker run -d --name acp-egress-proxy --network acp-egress --user node \
  -v "$PWD/../../deploy/acp-gateway/egress-proxy.mjs:/app/egress-proxy.mjs:ro" \
  node:24-bookworm-slim node /app/egress-proxy.mjs >/dev/null
docker network connect --alias egress acp-internal acp-egress-proxy
echo "sandbox up"
