# Repository guidance

## Product boundary

Agent Connect is an application-to-user-owned-agent bridge. Keep the application-facing API agent- and harness-neutral. Codex, OmniGENT, ACP adapters, and transport bridges belong behind internal adapter boundaries.

The public task/tool API is provider-neutral. OmniGENT HTTP/SSE is the first
working provider transport. ACP remains the preferred future standardized
adapter; MCP-over-ACP is unstable, so keep draft-specific code and types out of
the default application API.

## Terminology

Use **gateway** for the Agent Connect component that applications reach and
users operate. Public documentation, UI copy, deployment paths, and new APIs
must not call it a connector. Older internal compatibility names may remain
until a dedicated migration, including `ConnectorAuth`, `connectorPublicKey`,
`connector.json`, and `AGENT_CONNECT_REAL_CONNECTOR_ENV`.

## Current scope

The browser-to-Codex spike and gateway-owned provisioning pass. Continue to
assume one online OmniGENT host, one active task per application session, one
fixed tool snapshot per logical/downstream session, and one downstream agent
until durability and approval behavior are implemented. Browser APIs must use
opaque Agent Connect sessions, never raw OmniGENT ids.

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
