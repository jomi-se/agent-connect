# Changelog

## 0.0.1

- First release of the Agent Connect gateway and `agent-connect` CLI.
- Host owner passphrase sign-in, optional TOTP, exact-origin OAuth consent for
  fixed tools, rotating grants, session inspection and revocation.
- Run pinned ACP adapters and harness CLIs in Docker sessions with dedicated
  harness homes, restricted owned egress and cleanup before releasing capacity.
- Provide setup, owner-run login, doctor, systemd/launchd user service management,
  offline TOTP recovery, upgrade and explicit headless configuration.
- Package native executables for Apple Silicon macOS, Linux x64 and Linux ARM64
  through optional npm platform dependencies, with no runtime binary download.
- Keep ACP, MCP-over-ACP and transport resumption experimental. ADR 0016 remains
  proposed; publication is an owner gate.

See the [install guide](https://github.com/jomi-se/agent-connect/blob/main/docs/install/README.md).
