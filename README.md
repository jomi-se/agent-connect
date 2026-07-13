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

The [`browser-nonce` demo](apps/browser-nonce/README.md) proves that a normal web
application can lend a fresh tool to the user's Codex-backed OmniGENT session
without preinstalling an application MCP server.

See [the documentation index](docs/README.md) and [the hackathon plan](docs/plan/hackathon.md).

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
