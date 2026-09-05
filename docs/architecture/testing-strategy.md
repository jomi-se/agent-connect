# Testing strategy

Tests should fail when the dependency we ship changes, not stay green because
our imitation agrees with yesterday's assumptions.

> If changing OpenClaw could invalidate the assertion, exercise real OpenClaw.

## Three evidence layers

1. **Agent Connect-owned invariants.** Narrow tests cover profile parsing,
   authorization, snapshot binding, durable ownership, no-redrive rules and
   exact races. Fault injectors may delay writes, sever streams or deliberately
   corrupt data. They are not provider compatibility evidence.
2. **Real dependency compatibility.** Start pinned published OpenClaw in an
   isolated profile. Only inference is deterministic. Exercise actual HTTP/SSE,
   client calls, continuation, tool isolation and cancellation; do not simulate
   OpenClaw or replay recorded events. Gateway process-death cases also use the
   real dependency. See the [test inventory](../../packages/gateway/test/README.md).
3. **Selected subscription-runtime composition.** A final real browser flow
   proves authorization, SDK, actual model, tool execution and meaningful use of
   its result, followed by a second turn. Run for release or a consequential
   default switch, not every edit: this spends model allowance.

The deterministic fixture uses the **built-in OpenClaw loop**. It does not prove
native Codex compatibility or subscription authentication. The pinned native
Codex adapter drops client tools; the built-in loop projects client output as
user text. Final acceptance remains open until the selected composition is
demonstrated and accepted. See [research](../research/2026-09-05-openclaw-replacement.md).

## Commands and evidence

Use Node 24 LTS >=24.15 and <25 and the dependency pinned in
`config/openclaw-test-compat.json`. The [setup guide](../../deploy/openclaw-gateway/README.md)
documents the integrity-checked installer and `OPENCLAW_TEST_BIN` override.

```sh
./scripts/quiet-run.sh --detach "verify" npm run verify
# Or just the provider boundary, including process-crash cases:
./scripts/quiet-run.sh --detach "OpenClaw compatibility" npm run test:integration:openclaw
```

Default verification includes real dependency and process-crash tests. Missing
or wrong dependencies fail, never silently skip. `verify:full` additionally runs
installed-package, WebMCP and Canvas browser checks.

Amortize service startup and control inference to keep checks fast and free of
model usage. Cancellation evidence observes actual inference connection closure
before the independent fixture timeout; a local terminal event proves nothing
about upstream termination.

Name evidence precisely: ownership invariant, real OpenClaw integration, or live
subscription-runtime composition. None replaces the others. When the real
dependency contradicts a fixture, correct the implementation and remove the
false assumption rather than teaching both sides the same fiction.
