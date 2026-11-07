# Qualify the release beyond what CI can prove

Status: ready-for-human

CI proves composition with real pinned adapters and deterministic inference,
on Linux, without real logins. These limits remain, and the tickets below are
the owner-run checks that close them:

- Native systemd and launchd operations have isolated service-manager contract
  coverage and offline unit validation; macOS execution awaits platform
  validation.
- Codex read-only mode is configured correctly and approved app tools succeed,
  but the tested container refuses nested namespace creation before native
  tool execution. A prevented write is fail-closed evidence, not independent
  filesystem-policy qualification; it needs a host that supports that sandbox.
- No gate uses a real subscription. Default gates use deterministic inference;
  opt-in real-model acceptance needs owner-prepared dedicated harness homes.

Tickets:

- [01 Dedicated credential qualification](issues/01-dedicated-credentials.md)
- [02 Native platform matrix](issues/02-native-platform-matrix.md)

Out of scope for now: per-app box isolation, Windows, mobile approval and
mobile recovery codes. Owner TOTP and offline recovery exist.
