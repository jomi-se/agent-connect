# Changelog

## 0.0.10

- Replace the entire plugin-era API with the experimental ACP API exported from
  `@open-agent-connect/web` at the package root. This is a breaking replacement.
- Remove the `./acp` subpath and the former authorization/model clients,
  `openclaw-connection`, `openclaw-conversations`, `responses-provider`,
  `ai-sdk`, `agent-session` and `agent-chat` modules.
  No compatibility exports or aliases remain.
- Provide owner-hosted pairing, resumable ACP delivery, fixed WebMCP snapshots,
  CSP-safe tool validation and `createAcpChatTransport` for AI SDK `useChat`.
- Execute approved application tools inside the ACP transport with stable action
  IDs, cooperative cancellation and explicit recovery without replay.
- Version independently from the gateway. ACP, MCP-over-ACP and the resume API
  remain unstable; versions stay on 0.0.x until the shape is final.

Use the [install guide](https://github.com/jomi-se/agent-connect/blob/main/docs/install/README.md)
to install the gateway and pair the new SDK. Applications must migrate to the
root ACP API before upgrading.
