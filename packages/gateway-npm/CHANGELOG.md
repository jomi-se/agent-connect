# Changelog

## 0.1.0-alpha.1

- First ACP prerelease: grant-scoped WebSocket gateway, resumable transport and
  container-per-session isolation.
- Dedicated harness-home login, private configuration and operator-issued grants.
- Platform launcher for Apple Silicon, Linux x64 and Linux ARM64. Adapters and
  unmodified harness CLIs are pinned inside the matching session image.
- ACP, MCP-over-ACP and resume APIs remain unstable. ADR 0016 remains proposed.
- Add `agent-connect login` with a harness selector and dedicated platform-default homes shared by login, setup and serve; preserve explicit options and existing config homes. Keep `agent-connect-gateway` as a compatibility command.
