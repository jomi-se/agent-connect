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
# Retained Agent Connect plugin for OpenClaw boundary
npm run test:openclaw:plugin-host

# ACP gateway and retained OpenClaw plugin verification
npm run verify

# Release, native WebMCP, and browser gates
npm run verify:full
```

The fixture is disposable, loopback-only, and model-free. Missing or mismatched
pins fail rather than skip in CI. Never use a modified OpenClaw checkout as
compatibility evidence.

## Fixture storage

Each runtime uses a private temporary home. After owned services stop, ACP
scenario, clean-room and OpenClaw fixtures prune their dependency trees and
per-run npm/transformation caches on both success and failure. Logs, reports,
screenshots and synthetic runtime state remain for focused diagnosis; cleanup
never follows symlinks into shared caches or a checkout. Regression tests cover
evidence preservation, nested installs, repeated cleanup and external links.

Set `AGENT_CONNECT_KEEP_TEST_INSTALLS=1` only when diagnosing an installation
problem that requires the dependencies themselves. Repeated opt-in runs retain
large trees. Abrupt process termination such as SIGKILL can also leave fixtures;
check ownership and active processes before removing leftovers. Do not rely on
reboots or a host's temporary-directory retention policy for normal test cleanup.

## Interpreting failures

Name evidence precisely: an Agent Connect invariant, packed Agent Connect plugin for OpenClaw
composition, or selected live composition. None substitutes for the others. A
disconnect prevents further local publication/admission; it does not prove every
upstream effect stopped. Deterministic inference is not subscription-runtime
evidence. When OpenClaw behavior contradicts a double, correct the implementation
or claim rather than teaching the double to mimic an assumption.
