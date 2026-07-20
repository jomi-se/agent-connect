#!/bin/sh
set -eu

repo_root=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
adapter="${AGENT_CONNECT_CODEX_ACP_ADAPTER:-$repo_root/node_modules/@agentclientprotocol/codex-acp/dist/index.js}"

if test -z "${CODEX_HOME:-}"; then
  echo "Agent Connect private demo: CODEX_HOME is not configured" >&2
  exit 78
fi
if test ! -d "$CODEX_HOME" || test ! -w "$CODEX_HOME"; then
  echo "Agent Connect private demo: CODEX_HOME must be a writable directory" >&2
  exit 78
fi
if test ! -f "$CODEX_HOME/auth.json"; then
  echo "Agent Connect private demo: CODEX_HOME/auth.json is missing" >&2
  exit 78
fi
if test ! -f "$adapter"; then
  echo "Agent Connect private demo: run npm install from the repository root" >&2
  exit 78
fi

mkdir -p "$CODEX_HOME/logs"
export APP_SERVER_LOGS="$CODEX_HOME/logs"
export INITIAL_AGENT_MODE="${INITIAL_AGENT_MODE:-read-only}"
if test -z "${CODEX_CONFIG:-}"; then
  CODEX_CONFIG='{"approvals_reviewer":"user"}'
fi
export CODEX_CONFIG
export CODEX_PATH="${CODEX_PATH:-$repo_root/node_modules/@openai/codex/bin/codex.js}"
export NO_BROWSER="${NO_BROWSER:-1}"

exec node "$adapter"
