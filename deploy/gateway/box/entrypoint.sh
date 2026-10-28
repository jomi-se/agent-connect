#!/bin/sh
set -eu
umask 077
export HOME=/home/node
export CODEX_HOME="$HOME/codex-home" CLAUDE_CONFIG_DIR="$HOME/claude-config"
# Credentials and transcripts stay together in the shared mounted home.
mkdir -p "$CODEX_HOME" "$CLAUDE_CONFIG_DIR"
if [ ! -f "$CODEX_HOME/config.toml" ]; then
  printf '%s\n' 'cli_auth_credentials_store = "file"' > "$CODEX_HOME/config.toml"
fi
# No API-key environment is ever supplied by the gateway or login helper.
unset ANTHROPIC_API_KEY OPENAI_API_KEY AZURE_OPENAI_API_KEY GEMINI_API_KEY GOOGLE_API_KEY
if [ "${1:-}" = "--harness" ]; then
  exec session-runner "$@"
fi
exec "$@"
