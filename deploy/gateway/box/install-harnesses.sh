#!/bin/sh
# Install both ACP adapters and the harnesses they drive into /opt/adapters.
# Setup passes the exact versions it resolved as one JSON object, e.g.
#   {"@agentclientprotocol/codex-acp":"2.1.0","@openai/codex":"0.164.0",...}
# so the box tag identifies its contents. With no argument (checkout tests),
# everything installs at npm's latest. Codex is the release codex-acp runs, so
# a pinned Codex is forced with an override rather than installed beside it.
set -eu
mkdir -p /opt/adapters
cd /opt/adapters
node -e '
const versions = JSON.parse(process.argv[1] || "{}");
const latest = (name) => versions[name] ?? "latest";
const codex = versions["@openai/codex"];
const manifest = {
  private: true,
  dependencies: {
    "@agentclientprotocol/codex-acp": latest("@agentclientprotocol/codex-acp"),
    "@agentclientprotocol/claude-agent-acp": latest("@agentclientprotocol/claude-agent-acp"),
    "@anthropic-ai/claude-code": latest("@anthropic-ai/claude-code"),
  },
  ...(codex && { overrides: { "@openai/codex": codex } }),
};
require("node:fs").writeFileSync("package.json", JSON.stringify(manifest, null, 2));
' "${1:-}"
npm install --omit=dev --ignore-scripts --no-audit --no-fund
# Install scripts are skipped, so link the native Claude binary the CLI
# package would have selected, and drop the SDK's own copy: the adapter runs
# CLAUDE_CODE_EXECUTABLE instead.
cpu=$(node -p process.arch)
ln -sf "../../claude-code-linux-$cpu/claude" node_modules/@anthropic-ai/claude-code/bin/claude.exe
chmod 755 "node_modules/@anthropic-ai/claude-code-linux-$cpu/claude"
ln -sf ../@anthropic-ai/claude-code/bin/claude.exe node_modules/.bin/claude
rm -rf node_modules/@anthropic-ai/claude-agent-sdk-linux-*
find node_modules/@openai -name codex-voice-host -delete
npm cache clean --force
