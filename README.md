# Agent Connect

Agent Connect is an experimental bridge between applications and agents that run in a user's own environment.

An application connects to a runtime owned by its user, sends work through a
neutral session API, and lends temporary tools whose implementations remain
inside the application. The first provider uses OmniGENT's existing HTTP/SSE
Sessions API and drives Codex through its generic ACP harness; no OmniGENT fork
is currently required.

## Repository status

The first end-to-end browser slice now passes. `@agent-connect/web` provides:

- a provider-neutral `AgentSession` task and event API;
- browser-owned tools snapshotted per task and validated with JSON Schema;
- an OmniGENT HTTP/SSE adapter with correlated client-tool results;
- in-memory duplicate action suppression; and
- isolated experimental ACP/WebSocket and MCP-over-ACP helpers.

The gateway now owns runtime enrollment and application authorization. On first
start it creates a durable connector key and one high-entropy enrollment
passphrase. The browser verifies that key before disclosing tool schemas, then
uses a connector-owned consent page and PKCE to obtain a revocable grant. The
gateway provisions or heals the matching OmniGENT/Codex runner behind an opaque
Agent Connect session; applications never receive an OmniGENT session id.

The [`browser-nonce` demo](apps/browser-nonce/README.md) proves that a normal web
application can lend a fresh tool to the user's Codex-backed OmniGENT session
without preinstalling an application MCP server.

See [the documentation index](docs/README.md) and [the hackathon plan](docs/plan/hackathon.md).

The VM-local OmniGENT sandbox profile is experimental. Its outer bubblewrap
boundary passes live mount/seccomp/sentinel checks, but its downstream MCP
relay currently fails to initialize under that boundary, and the
network-capable agent can see the copied Codex login in its dedicated home. It
is not a malicious-app security boundary. The normal live demo
must use the proven profile until that compatibility issue is closed; see the
[sandbox spike](docs/research/2026-07-14-omnigent-vm-sandbox-spike.md).

## Development

Requirements:

- Node.js 22 or newer
- npm 10 or newer

```sh
npm install
npm run verify
```

Packages and demo applications are managed with npm workspaces under
`packages/` and `apps/`.

## Research provenance

The original investigation is preserved in [`USER_OWNED_AGENT_RUNTIME_HACKATHON_HANDOFF.md`](USER_OWNED_AGENT_RUNTIME_HACKATHON_HANDOFF.md). Current decisions live under [`docs/decisions`](docs/decisions), so the handoff should not be treated as the final architecture.
