# Testing strategy

Tests should fail when the dependency we operate changes, not stay green because
an imitation agrees with an old assumption.

> If changing OpenClaw could invalidate the assertion, exercise OpenClaw.

## Evidence layers

1. **Agent Connect invariants.** Focused tests cover grants, OAuth, request
   bounds, exact tools, continuation ownership, history projection, revocation,
   lifecycle cleanup, and deliberate fault handling. Controlled doubles prove
   only Agent Connect-owned behavior.
2. **Packed Agent Connect plugin composition.** Build the public tarball, install it
   through the pinned OpenClaw package with isolated state, and exercise the real CLI,
   plugin lifecycle, HTTP routes, OAuth flow, native Responses boundary, and
   configuration enforcement. Only inference is deterministic.
3. **Selected live composition.** Separately demonstrate the configured
   subscription model, real browser/HTTPS ingress, meaningful tool-result use,
   and follow-up. This spends model allowance and requires explicit owner
   coordination, so it is not an ordinary repository gate.

## Commands

Use Node 24 LTS `>=24.15.0` and `<25` plus the pin in
`config/openclaw-test-compat.json`. CI installs OpenClaw into a disposable
dedicated prefix with `scripts/openclaw-install.mjs` and sets
`OPENCLAW_TEST_BIN`.

```sh
# Active Agent Connect plugin for OpenClaw boundary
npm run test:openclaw:plugin-host

# Repository verification, including the active Agent Connect plugin for OpenClaw boundary
npm run verify

# Release, native WebMCP, and browser gates
npm run verify:full
```

The fixture is disposable, loopback-only, and model-free. Missing or mismatched
pins fail rather than skip in CI. Never use a modified OpenClaw checkout as
compatibility evidence.

## Interpreting failures

Name evidence precisely: an Agent Connect invariant, packed Agent Connect plugin for OpenClaw
composition, or selected live composition. None substitutes for the others. A
disconnect prevents further local publication/admission; it does not prove every
upstream effect stopped. Deterministic inference is not subscription-runtime
evidence. When OpenClaw behavior contradicts a double, correct the implementation
or claim rather than teaching the double to mimic an assumption.
