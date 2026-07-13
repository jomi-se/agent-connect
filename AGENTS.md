# Repository guidance

## Product boundary

Agent Connect is an application-to-user-owned-agent bridge. Keep the application-facing API agent- and harness-neutral. Codex, OmniGENT, ACP adapters, and transport bridges belong behind internal adapter boundaries.

ACP is the primary session protocol. MCP-over-ACP is currently unstable; isolate draft-specific code and types so they can be replaced without changing the public tool-registration API.

## Current scope

The first implementation target is `packages/web-sdk`. Until the first end-to-end spike passes, assume exactly one upstream ACP connection, one session, one application-owned MCP server, one active MCP connection, and one downstream Codex agent.

Do not add generalized multi-agent orchestration, arbitrary MCP features, Android automation, or a second proprietary session protocol without recording a decision under `docs/decisions/`.

## Commands

Use npm workspaces from the repository root:

```sh
npm install
npm run format:check
npm run typecheck
npm test
npm run build
npm run verify
```

Add or update tests for public SDK behavior. Keep browser packages free of Node-only runtime imports.

## Protocol and reliability rules

- Persist an application tool request before notifying the application.
- Do not claim generic exactly-once execution. Use stable action IDs and require idempotent application operations or application-owned deduplication.
- Conversation resumption and delivery of unresolved tool requests are separate concerns.
- Clearly label unstable ACP and MCP-over-ACP behavior in public APIs and documentation.
- Do not describe a custom bridge as a stable ACP or MCP standard implementation.

## Documentation

- Current mission and boundaries: `docs/mission.md`
- System architecture: `docs/architecture/`
- Accepted decisions: `docs/decisions/`
- Execution plans: `docs/plan/`
- Time-stamped external research: `docs/research/`

Update the earliest source of truth that changed; do not leave contradictory plans in different documents.
