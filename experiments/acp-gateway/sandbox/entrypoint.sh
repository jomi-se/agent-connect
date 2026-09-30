#!/bin/sh
# Per-session container entrypoint: fresh harness state on tmpfs, then the
# ACP session runner on stdio. Anything else (probes) runs as given.
set -eu
export HOME=/home/node
mkdir -p "$HOME/codex-home" "$HOME/claude-config"
cp /opt/spike/codex-config.toml "$HOME/codex-home/config.toml"
export CODEX_HOME="$HOME/codex-home" CLAUDE_CONFIG_DIR="$HOME/claude-config"
if [ "${1:-}" = "--harness" ]; then
  exec session_runner "$@"
fi
exec "$@"
