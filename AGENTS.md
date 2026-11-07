# Repository guidance

This file holds durable rules only. Release status lives in
`docs/plan/current-work.md`, accepted work in `docs/plan/`, defects in
`docs/issues/`, unaccepted proposals in `docs/ideas/` and decisions in
`docs/decisions/`. `docs/agents/issue-tracker.md` says how they work.

## Product boundary

Agent Connect lets web applications use an agent the user already owns. It is one product with two components:

- the Rust gateway in `crates/gateway` (CLI `agent-connect`), packaged as
  `@open-agent-connect/gateway` with a locally built Docker box;
- the browser SDK `@open-agent-connect/web`, exported from its package root.

Each user runs their own gateway at an origin applications cannot know in
advance. Each gateway serves whichever application origins its owner approves.
Preserve both choices: never require applications to list gateway origins
(including in CSP `connect-src`) or gateways to preregister applications.

Keep the application-facing API agent- and harness-neutral. Codex, Claude Code
and their ACP adapters stay behind internal adapter boundaries; harness-specific
types never appear in shared application contracts. Use **gateway** for the
component applications reach and users operate, never "connector".

Keep independent app conversations, one active request per conversation, a fixed
approved tool snapshot and an operator-selected restricted profile. Record a
decision under `docs/decisions/` before adding multi-agent orchestration,
arbitrary MCP features, device automation or a second session protocol.

Remove superseded code instead of keeping compatibility layers: no deprecated
re-exports, aliases or shims. Old versions remain available in npm and git
history. Until 1.0 this covers everything an owner has installed too: commands,
flags, config fields, service definitions and state files. Nobody runs the alpha
in production, so a change does not migrate earlier installs, accept their
config or keep a command they call; an owner reruns setup. Delete the tests of
removed behavior with it. A second way into the same thing is debt, not
caution.

## Security invariants

- Production sessions run boxed, with a dedicated harness home and an owned
  egress proxy. Owner authentication and grant state stay outside the harness
  home.
- Browser APIs never accept harness session keys or operator credentials.
- Never forward API-key environment variables into boxes.
- Never change personal harness logins or services. Harness logins are run by
  the owner through `agent-connect login`; tests never invoke a real login. The
  accepted shared-home risks are in `docs/plan/credentials.md`.
- The owner types the owner passphrase at a terminal prompt; the gateway stores
  only its hash. Never add file, argument or environment input for it, or write
  one down.
- Never automatically replay an uncertain prompt or application effect.
- Release boxed capacity only after owned resources are cleaned up. Never remove
  shared peers or prune unrelated Docker resources unless the owner asks.
- Agents never push, publish, run the release workflow or `npm deprecate`
  without explicit owner authorization.

## Protocol and reliability rules

- Persist an application tool request before notifying the application.
- Do not claim generic exactly-once execution. Use stable action IDs and require
  idempotent application operations or application-owned deduplication.
- Conversation resumption and delivery of unresolved tool requests are separate
  concerns.
- Clearly label unstable ACP and MCP-over-ACP behavior in public APIs and
  documentation, and do not describe a custom bridge as a stable ACP or MCP
  standard implementation.

## Commands

Use npm workspaces from the repository root with Node 26 LTS (>=26.13, <27):

```sh
npm install
npm run format:check
npm run typecheck
npm test
npm run build
cargo test --locked   # Rust workspace
node scripts/release.mjs check
npm run analyze       # report-first metrics; boundary violations are hard failures
```

`npm run check` runs the fast gates above (except analyze) plus `cargo test`; run
it after every change. Then run only the box-backed gates your change touches;
`npm run verify -- <step>...` builds this checkout's test box and runs them:

| Change                       | Steps                                                                 |
| ---------------------------- | --------------------------------------------------------------------- |
| Owner pages                  | `test:ui:owner`                                                       |
| Gateway sessions or protocol | `test:integration:gateway`                                            |
| Box, sandbox or egress       | `test:integration:gateway:boxed`, `test:integration:gateway:teardown` |
| SDK exports                  | `npm run test:package:web`                                            |
| WebMCP                       | `npm run test:webmcp`                                                 |
| Packaging or setup           | `test:integration:gateway:clean-room`                                 |

CI runs everything (release build, every `verify:full` gate with real adapters
and the clean-room sample) on every PR and push to `main`, as parallel jobs that
are reused when a green run already verified their exact inputs
(`scripts/ci-inputs.mjs`; see `docs/guides/repository-maintenance.md`). A
release publishes only after it passes. Run the full set locally only to reproduce a CI failure;
see `docs/install/release.md`. CI is read-only.

Those gates use a mock model that the box reaches without the egress, so none
of them sees the path out to a real provider. After anything that can change
it (container engine or OS upgrade, box image, egress, harness bump), also run
`npm run verify -- test:live` with `ACP_LIVE_HARNESS_HOME` naming a signed-in
codex harness home: a few short real turns through a scratch boxed gateway and
its egress, on this checkout's test box. It spends tokens and needs
credentials, so CI never runs it.

Run routine checks through `quiet-run` (on PATH; `scripts/quiet-run.sh` is the
fallback), which prints one line on success and a bounded tail on failure. Use
`--detach` for slow runs, then collect with `--status`.
Run the formatter once, just before final verification and commit.

## Testing

- Add or update tests for public SDK behavior. Keep browser packages free of
  Node-only runtime imports.
- Test against the dependency you ship. If an assertion could become meaningless
  when a pinned ACP adapter or harness changes, run it against that real
  dependency. Routine gates use deterministic inference behind real adapters;
  real-model application runs prove useful behavior. Stubbed inference is never
  evidence of real harness or model behavior.
- Controlled doubles are fine for Agent Connect-owned invariants and hard-to-cause
  faults (failed writes, wedged requests, exact races); they must not invent
  harness behavior. See `docs/architecture/testing-strategy.md`.
- Tests isolate HOME and XDG state, use service-manager fixtures rather than the
  owner's services, and clean up their own installs and caches on success and
  failure.

## Documentation

- Mission and boundaries: `docs/mission.md`
- Architecture: `docs/architecture/`
- Decisions: `docs/decisions/`
- Install, configuration and release: `docs/install/`
- Current work: `docs/plan/current-work.md`; plans `docs/plan/`, defects
  `docs/issues/`, ideas `docs/ideas/` (`docs/agents/issue-tracker.md`)
- Dated research: `docs/research/`; superseded material: `docs/archive/`

Update the earliest source of truth that changed; do not leave contradictory
plans in different documents.
