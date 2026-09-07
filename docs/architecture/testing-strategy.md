# Testing strategy

Tests should fail when the dependency we operate changes, not stay green because
an imitation agrees with an old assumption.

> If changing OpenClaw could invalidate the assertion, exercise stock OpenClaw.

## Evidence layers

1. **Agent Connect-owned invariants.** Focused Vitest cases cover request/header
   allowlists, exact consented tools, origin/grant/policy binding, bounded
   continuations, expiry/restart/disconnect, revocation, SSE inspection and
   redaction. A controlled Fetch double creates deliberate malformed, delayed or
   conflicting responses; it is not OpenClaw compatibility evidence.
2. **Published-package policy proof.** Start the version/tarball/integrity-pinned
   unpatched OpenClaw package with isolated state and deterministic inference.
   Exercise operator-origin `/exec`, elevation and unoffered native-call attempts
   against a dedicated deny-all agent. Exercise required container-sandbox startup
   with an unavailable backend and require failure before inference.
3. **Stock composition.** Use the real web SDK, OAuth/PAR/PKCE, explicit owner
   login and native stock Responses endpoint. Complete two app function calls and
   outputs, final text, a contextual follow-up, refresh and revoke. Only inference
   is deterministic; the test does not synthesize OpenClaw events.
4. **Selected live composition.** Separately demonstrate the configured
   subscription model, real browser/HTTPS ingress, meaningful result use and a
   follow-up. This spends model allowance and requires explicit operator
   coordination, so it is never an ordinary repository gate.

## Commands

Use Node 24 LTS `>=24.15.0` and `<25` plus the pin in
`config/openclaw-test-compat.json`. Install it into a disposable dedicated prefix
with `node scripts/openclaw-install.mjs /absolute/new/prefix`, then set
`OPENCLAW_TEST_BIN` and ensure the matching Node is on `PATH`.

```sh
./scripts/quiet-run.sh --detach "scoped proxy verification" npm run verify:scoped-proxy

# Individual stock boundaries:
npm run test:openclaw:fixture
npm run test:integration:openclaw
```

`verify:scoped-proxy` formats/checks the repository, builds only the standalone
proxy and its imported OAuth/grant adapters, runs focused authority tests, and
runs the published stock proofs/composition. Missing or mismatched dependencies
fail rather than skip. The repository-wide `npm run verify` additionally compiles
and tests preserved historical implementations; it is useful regression evidence
but not a scoped-proxy deployment prerequisite.

The fixture is disposable, loopback-only and model-free. It must report the
published package provenance and absence of the patch-only application-principal
export. Never use an expanded local OpenClaw checkout as stock evidence.

## Interpreting failures

Name evidence precisely: an Agent Connect invariant, published-package policy
proof, stock composition or selected live composition. None substitutes for the
others. A local disconnect proves proxy admission is no longer replayable; it
does not prove all upstream effects stopped. A static config hash proves the file
did not change; it is not an atomic attestation of an independently managed
process. When stock behavior contradicts a double, correct the implementation or
the claim instead of teaching the double to mimic an assumption.
