# Changelog

## 0.0.3

- Keep the Codex code-mode host in the box. Codex runs MCP tools through code
  mode, so without it boxed Codex sessions had no application tools.
- First setup accepts directories writable only by the owner's own private
  group, the Ubuntu and Debian default for the systemd user unit directory.

## 0.0.2

- First-time setup and init ask for the owner passphrase at a terminal prompt
  only; `--owner-passphrase-file` is removed.
- Add `agent-connect reset-passphrase` for offline passphrase recovery.
- First release built with the mise-declared toolchain.
- Tests can select an isolated `agent-connect-box-test:` image, so test builds
  never replace an installed box tag.

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
- Keep ACP, MCP-over-ACP and transport resumption experimental. ADR 0016 was
  accepted on 2026-10-04; publication remains an owner gate.

See the [install guide](https://github.com/jomi-se/agent-connect/blob/main/docs/install/README.md).
