# Testing strategy

## Purpose

Tests should fail when the system we ship stops working. They should not stay
green because a local imitation of a dependency still agrees with assumptions
that the dependency no longer satisfies.

Agent Connect currently ships one concrete provider boundary: Omnigent
HTTP/SSE. That makes the central rule simple:

> If changing Omnigent could invalidate the assertion, exercise real Omnigent.

This is not a preference for large end-to-end tests everywhere. It is a rule
about where truth comes from.

## Three evidence layers

### 1. Pure Agent Connect tests

Use in-process tests for behavior Agent Connect owns completely:

- request-profile parsing and error mapping;
- chain, response, and function-call state transitions;
- authorization and fixed-snapshot enforcement;
- persistence-before-publication and retry rules;
- file-store recovery from deliberate I/O failure;
- queue capacity and HTTP timeout behavior; and
- exact race schedules and process crash points.

The backend fixture in these tests is a controllable source of abstract
`BackendEvent` values. It is not an Omnigent simulator and must not be cited as
evidence about what Omnigent sends. In particular, cancellation tests must not
pass only because the fixture helpfully invents a terminal event.

### 2. Real Omnigent compatibility tests

Use a disposable real Omnigent service whenever an assertion depends on its:

- HTTP routes, status codes, or request acceptance;
- SSE event shapes and ordering;
- completion suppression around application function calls;
- interrupt and cancellation behavior;
- session retention, liveness, or process-death behavior; or
- ACP/MCP bridging and sequential function-output continuation.

Place a deterministic ACP agent behind Omnigent. It supplies a controlled plan
and application-function sequence while preserving the real Omnigent server,
runner, HTTP, SSE, and bridge behavior. This gives deterministic tests without
model usage. Do not replace it with captured event fixtures: recordings prove
only what an old version did once and cannot detect a changed dependency.

The normal gate is:

```sh
./scripts/quiet-run.sh "real Omnigent compatibility suite" \
  npm run test:integration:omnigent --workspace @agent-connect/gateway
```

When adding a new Omnigent-sensitive behavior, first try to extend the existing
isolated integration fixture. Keep scenarios deterministic and amortize service
startup where practical so this suite remains cheap enough to run routinely.

### 3. Real Codex composition smoke

A small browser-to-gateway-to-Omnigent-to-Codex run proves that credentials,
the actual harness, application functions, and the user experience compose.
It is intentionally not the routine regression suite: it consumes user model
allowance, depends on credentials, is slower, and includes model variance.

Run it before a release or a consequential default switch, not after every
internal edit. It supplements the deterministic real-Omnigent gate; it does
not replace it.

## Choosing the layer

Ask one counterfactual question:

> If Omnigent subtly changed tomorrow, should this test fail?

- If **yes**, the compatibility assertion belongs in the real Omnigent suite.
- If **no**, and the behavior is wholly ours, use a narrow pure test.
- If the assertion is that the actual Codex composition works, use the final
  smoke test.

A fault injector may stand in for a failed disk, severed stream, or wedged
socket because those tests validate our response to a controlled failure. It
must not stand in for the normal semantics of an external provider.

## Review and evidence language

Name the evidence precisely:

- “engine invariant test” means the abstract state machine behaved as declared;
- “real Omnigent integration” means the current installed Omnigent behavior was
  exercised through its actual boundary;
- “real Codex composition” means a live model-backed user flow completed.

Never describe a fake-backend test as an Omnigent integration. Never infer
provider compatibility from a recorded transcript. When a real dependency
test reveals behavior that differs from a fixture, fix the implementation and
delete the false assumption from the fixture rather than teaching both sides a
new shared fiction.
