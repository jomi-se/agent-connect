# Repository guidance

## Product boundary

Agent Connect is an application-to-user-owned-agent bridge. Keep the application-facing API agent- and harness-neutral. Codex, Omnigent, ACP adapters, and transport bridges belong behind internal adapter boundaries.

The public task/tool API is provider-neutral. Omnigent HTTP/SSE is the first
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
assume one online Omnigent host, one active task per application session, one
fixed tool snapshot per logical/downstream session, and one downstream agent
until durability and approval behavior are implemented. Browser APIs must use
opaque Agent Connect sessions, never raw Omnigent ids.

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
npm run analyze
```

`npm run analyze` is initially report-first. Treat its metrics as investigation
inputs, not automatic refactoring instructions; dependency boundary violations
remain hard failures.

Add or update tests for public SDK behavior. Keep browser packages free of Node-only runtime imports.

### Low-output command execution

For routine non-interactive commands whose successful output carries no useful
information beyond the exit code—builds, typechecks, tests, lint, and similar
checks—use `scripts/quiet-run.sh` by default:

```sh
./scripts/quiet-run.sh "gateway tests" npm test --workspace @agent-connect/gateway
./scripts/quiet-run.sh "build" npm run build
```

On success, the wrapper prints one short line. On failure, it prints a bounded
tail and preserves the complete log under `/tmp` for focused follow-up. This
keeps repetitive success logs out of the agent context: they consume tokens
and displace useful evidence without improving a decision, while the full
failure detail remains available when it is actually needed.

Do not use the wrapper when a command needs interactive input, live progress is
operationally important, or its normal output is itself the requested evidence.
During implementation, prefer the narrowest relevant check. Run the formatter
once after the code has stabilized and immediately before final verification,
diff review, and commit; do not interleave repeated formatting passes with
ordinary edit/test iterations.

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
