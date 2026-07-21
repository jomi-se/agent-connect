#!/bin/sh

set -eu

repo_root=$(CDPATH= cd -- "$(dirname -- "$0")/../.." && pwd)
env_file=${AGENT_CONNECT_REAL_CONNECTOR_ENV:-"$repo_root/deploy/real-gateway/.env"}

if test ! -f "$env_file"; then
  echo "Agent Connect: missing $env_file" >&2
  echo "Copy deploy/real-gateway/.env.example to deploy/real-gateway/.env and edit it." >&2
  exit 78
fi

set -a
# This is an operator-owned configuration file and is intentionally sourced.
# shellcheck disable=SC1090
. "$env_file"
set +a

require_env() {
  name=$1
  eval "value=\${$name:-}"
  if test -z "$value"; then
    echo "Agent Connect: $name is required in $env_file" >&2
    exit 78
  fi
}

require_command() {
  if ! command -v "$1" >/dev/null 2>&1; then
    echo "Agent Connect: required command not found: $1" >&2
    exit 78
  fi
}

require_absolute_directory() {
  name=$1
  eval "value=\${$name}"
  case "$value" in
    /*) ;;
    *)
      echo "Agent Connect: $name must be an absolute path" >&2
      exit 78
      ;;
  esac
  mkdir -p "$value"
}

require_env AGENT_CONNECT_PUBLIC_ENDPOINT
require_env AGENT_CONNECT_ALLOWED_TAILSCALE_USERS
require_env CODEX_HOME
require_env AGENT_CONNECT_WORKSPACE

INITIAL_AGENT_MODE=${INITIAL_AGENT_MODE:-read-only}
case "$INITIAL_AGENT_MODE" in
  read-only | agent | agent-full-access) ;;
  *)
    echo "Agent Connect: INITIAL_AGENT_MODE must be read-only, agent, or agent-full-access" >&2
    exit 78
    ;;
esac

CODEX_CONFIG=${CODEX_CONFIG:-'{"approvals_reviewer":"user"}'}
if ! node -e '
  const value = JSON.parse(process.argv[1]);
  if (!value || typeof value !== "object" || Array.isArray(value)) process.exit(1);
' "$CODEX_CONFIG" 2>/dev/null; then
  echo "Agent Connect: CODEX_CONFIG must be a valid JSON object" >&2
  exit 78
fi

for command_name in node npm curl omnigent codex tailscale; do
  require_command "$command_name"
done

omnigent_version=$(omnigent --version 2>&1 || true)
case "$omnigent_version" in
  "omnigent 0.5.1 "*) ;;
  *)
    echo "Agent Connect: this reference profile requires Omnigent 0.5.1." >&2
    echo "Detected: ${omnigent_version:-unknown}" >&2
    exit 78
    ;;
esac

require_absolute_directory CODEX_HOME
require_absolute_directory AGENT_CONNECT_WORKSPACE

if test ! -f "$CODEX_HOME/auth.json"; then
  echo "Agent Connect: $CODEX_HOME/auth.json is missing." >&2
  echo "Authenticate this dedicated runtime first:" >&2
  echo "  CODEX_HOME='$CODEX_HOME' codex login" >&2
  exit 78
fi

state_dir=${AGENT_CONNECT_STATE_DIR:-"$repo_root/.agent-connect/real-connector"}
gateway_port=${AGENT_CONNECT_GATEWAY_PORT:-8787}
omnigent_port=${OMNIGENT_PORT:-6767}

case "$state_dir" in
  /*) ;;
  *) state_dir="$repo_root/$state_dir" ;;
esac

config_dir="$state_dir/omnigent-config"
data_dir="$state_dir/omnigent-data"
log_dir="$state_dir/logs"
operator_home="$state_dir/operator-home"
connector_state="$state_dir/connector.json"
omnigent_url="http://127.0.0.1:$omnigent_port"

mkdir -p "$config_dir" "$data_dir/artifacts" "$log_dir" "$operator_home"
chmod 700 \
  "$state_dir" \
  "$config_dir" \
  "$data_dir" \
  "$log_dir" \
  "$operator_home" \
  "$CODEX_HOME"
chmod 600 "$CODEX_HOME/auth.json"

launcher="$repo_root/scripts/omnigent-codex-private-demo.sh"
adapter="$repo_root/node_modules/@agentclientprotocol/codex-acp/dist/index.js"
prepared_adapter="$state_dir/codex-acp-agent-connect.mjs"
gateway="$repo_root/packages/gateway/dist/main.js"

if test ! -f "$adapter"; then
  echo "Agent Connect: dependencies are missing; run npm install at $repo_root" >&2
  exit 78
fi

node "$repo_root/scripts/prepare-codex-acp-adapter.mjs" \
  "$adapter" \
  "$prepared_adapter"

if test ! -f "$gateway"; then
  echo "Agent Connect: building the gateway..."
  npm run build --workspace @agent-connect/gateway --prefix "$repo_root"
fi

node -e '
  const fs = require("node:fs");
  const [path, command] = process.argv.slice(1);
  fs.writeFileSync(path, JSON.stringify({
    telemetry: false,
    acp: { agents: [{ name: "Codex ACP", command }] }
  }, null, 2) + "\n", { mode: 0o600 });
' "$config_dir/config.yaml" "$launcher"

export OMNIGENT_CONFIG_HOME="$config_dir"
export OMNIGENT_DATA_DIR="$data_dir"
export INITIAL_AGENT_MODE
export CODEX_CONFIG
export AGENT_CONNECT_CODEX_ACP_ADAPTER="$prepared_adapter"
export OMNIGENT_RUNNER_ENV_PASSTHROUGH=CODEX_HOME,INITIAL_AGENT_MODE,CODEX_CONFIG,AGENT_CONNECT_CODEX_ACP_ADAPTER
export HOME="$operator_home"
export OMNIGENT_URL="$omnigent_url"
export AGENT_CONNECT_HOST=127.0.0.1
export AGENT_CONNECT_PORT="$gateway_port"
export AGENT_CONNECT_STATE_PATH="$connector_state"
export AGENT_CONNECT_TRANSPORT_PROFILE=tailscale-serve
export AGENT_CONNECT_DYNAMIC_APP_ENROLLMENT=${AGENT_CONNECT_DYNAMIC_APP_ENROLLMENT:-1}

server_pid=
host_pid=
gateway_pid=

cleanup() {
  status=$?
  trap - EXIT INT TERM
  omnigent host stop \
    --server "$omnigent_url" \
    --daemon-only \
    --force \
    >/dev/null 2>&1 || true
  if test -n "$gateway_pid"; then kill "$gateway_pid" 2>/dev/null || true; fi
  if test -n "$host_pid"; then kill "$host_pid" 2>/dev/null || true; fi
  if test -n "$server_pid"; then kill "$server_pid" 2>/dev/null || true; fi
  wait "$gateway_pid" 2>/dev/null || true
  wait "$host_pid" 2>/dev/null || true
  wait "$server_pid" 2>/dev/null || true
  exit "$status"
}
trap cleanup EXIT INT TERM

# Omnigent's host command owns a daemon process beyond its launcher process.
# Clear a stale daemon for this profile-owned endpoint before starting a new
# stack, such as after a killed terminal or an older launcher version.
omnigent host stop \
  --server "$omnigent_url" \
  --daemon-only \
  --force \
  >/dev/null 2>&1 || true

echo "Agent Connect: starting Omnigent at $omnigent_url"
omnigent server \
  --host 127.0.0.1 \
  --port "$omnigent_port" \
  --database-uri "sqlite:///$data_dir/chat.db" \
  --artifact-location "$data_dir/artifacts" \
  --no-open \
  >"$log_dir/omnigent-server.log" 2>&1 &
server_pid=$!

attempt=0
until curl -fsS "$omnigent_url/v1/hosts" >/dev/null 2>&1; do
  attempt=$((attempt + 1))
  if ! kill -0 "$server_pid" 2>/dev/null; then
    echo "Agent Connect: Omnigent server exited; inspect $log_dir/omnigent-server.log" >&2
    exit 1
  fi
  if test "$attempt" -ge 60; then
    echo "Agent Connect: Omnigent server did not become healthy; inspect $log_dir/omnigent-server.log" >&2
    exit 1
  fi
  sleep 1
done

echo "Agent Connect: starting the Omnigent execution host"
omnigent host --non-interactive "$omnigent_url" \
  >"$log_dir/omnigent-host.log" 2>&1 &
host_pid=$!

attempt=0
until OMNIGENT_URL="$omnigent_url" node -e '
  fetch(`${process.env.OMNIGENT_URL}/v1/hosts`)
    .then((response) => response.json())
    .then((value) => {
      if (!Array.isArray(value.hosts) ||
          !value.hosts.some((host) => host.status === "online")) process.exit(1);
    })
    .catch(() => process.exit(1));
' >/dev/null 2>&1; do
  attempt=$((attempt + 1))
  if ! kill -0 "$host_pid" 2>/dev/null; then
    echo "Agent Connect: Omnigent host exited; inspect $log_dir/omnigent-host.log" >&2
    exit 1
  fi
  if test "$attempt" -ge 60; then
    echo "Agent Connect: Omnigent host did not become ready; inspect $log_dir/omnigent-host.log" >&2
    exit 1
  fi
  sleep 1
done

echo "Agent Connect: starting the real Codex gateway on 127.0.0.1:$gateway_port"
echo "Agent Connect: Codex mode is $INITIAL_AGENT_MODE; workspace is $AGENT_CONNECT_WORKSPACE"
echo "Agent Connect: server and host logs are under $log_dir"
echo "Agent Connect: keep this process running; Ctrl-C stops the complete stack"
node "$gateway" &
gateway_pid=$!

while
  kill -0 "$server_pid" 2>/dev/null &&
    kill -0 "$host_pid" 2>/dev/null &&
    kill -0 "$gateway_pid" 2>/dev/null
do
  sleep 2
done

if ! kill -0 "$server_pid" 2>/dev/null; then
  echo "Agent Connect: Omnigent server exited; inspect $log_dir/omnigent-server.log" >&2
elif ! kill -0 "$host_pid" 2>/dev/null; then
  echo "Agent Connect: Omnigent host exited; inspect $log_dir/omnigent-host.log" >&2
else
  echo "Agent Connect: gateway exited" >&2
fi
exit 1
