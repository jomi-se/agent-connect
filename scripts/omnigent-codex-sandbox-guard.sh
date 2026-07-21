#!/bin/sh
set -eu

fail() {
  if test -n "${CODEX_HOME:-}" && test -d "$CODEX_HOME"; then
    printf '%s\n' "$1" >>"$CODEX_HOME/sandbox-guard.log" 2>/dev/null || true
  fi
  echo "Agent Connect sandbox guard: $1" >&2
  exit 78
}

test -n "${AGENT_CONNECT_HOST_SENTINEL:-}" || fail "host sentinel is not configured"
test ! -e "$AGENT_CONNECT_HOST_SENTINEL" || fail "host sentinel is visible; refusing unsandboxed launch"

probe="$PWD/.agent-connect-write-probe-$$"
if (umask 077 && : >"$probe") 2>/dev/null; then
  rm -f "$probe"
  fail "workspace is writable; expected a read-only mount"
fi

grep -Eq '^NoNewPrivs:[[:space:]]+1$' /proc/self/status || fail "no_new_privs is not active"
grep -Eq '^Seccomp:[[:space:]]+2$' /proc/self/status || fail "seccomp filtering is not active"

test -n "${CODEX_HOME:-}" || fail "CODEX_HOME is not configured"
test -d "$CODEX_HOME" || fail "CODEX_HOME does not exist"
test -w "$CODEX_HOME" || fail "CODEX_HOME is not writable"

# Codex's own Linux sandbox uses another bubblewrap namespace. Nested user
# namespaces are unavailable inside Omnigent's outer bwrap, which also prevents
# the per-session MCP relay from starting. The outer sandbox is the enforcement
# boundary, so run Codex in full-access mode *inside that boundary*.
export INITIAL_AGENT_MODE="agent-full-access"
export NO_BROWSER="${NO_BROWSER:-1}"
export APP_SERVER_LOGS="$CODEX_HOME/logs"
export CODEX_PATH="/home/dev/agent-connect/node_modules/@openai/codex-linux-arm64/vendor/aarch64-unknown-linux-musl/bin/codex"

exec /usr/bin/node /home/dev/agent-connect/node_modules/@agentclientprotocol/codex-acp/dist/index.js
