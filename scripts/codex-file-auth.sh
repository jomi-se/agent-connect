#!/bin/sh
set -eu

if test -z "${AGENT_CONNECT_CODEX_BINARY:-}"; then
  echo "Agent Connect: AGENT_CONNECT_CODEX_BINARY is required" >&2
  exit 78
fi

# Auth storage is read during app-server initialization, before session config.
exec "$AGENT_CONNECT_CODEX_BINARY" -c 'cli_auth_credentials_store="file"' "$@"
