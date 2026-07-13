# Agent Connect

Agent Connect is an experimental bridge between applications and agents that run in a user's own environment.

An application connects as an ACP client, sends work to a selected agent, and exposes a small MCP tool surface that remains implemented inside the application. The first target is a browser SDK. The initial conductor candidate is an OmniGENT fork driving Codex through its generic ACP harness.

## Repository status

This repository is at the hackathon-foundation stage. The first implemented package is `@agent-connect/web`, a browser-oriented helper for a deliberately narrow, unstable MCP-over-ACP subset:

- one application-provided MCP server;
- one active logical MCP connection;
- `initialize`, `ping`, `tools/list`, and `tools/call`;
- fixed tools for the lifetime of an agent session.

See [the documentation index](docs/README.md) and [the hackathon plan](docs/plan/hackathon.md).

## Development

Requirements:

- Node.js 22 or newer
- npm 10 or newer

```sh
npm install
npm run verify
```

Packages are managed with npm workspaces under `packages/`. Demo applications will live under `apps/` when implementation reaches that milestone.

## Research provenance

The original investigation is preserved in [`USER_OWNED_AGENT_RUNTIME_HACKATHON_HANDOFF.md`](USER_OWNED_AGENT_RUNTIME_HACKATHON_HANDOFF.md). Current decisions live under [`docs/decisions`](docs/decisions), so the handoff should not be treated as the final architecture.
