# Disposable in-process delegation fixture

This is feasibility code, not an installable production authorization product.
It runs inside a disposable published OpenClaw gateway, reusing native Responses
JSON/SSE without manufacturing response events or running an agent loop.

Public paths are exactly `/ac-probe/request`, `/ac-probe/decision`, and
`/ac-probe/responses`. An existing deployment ingress must expose ONLY those
paths, preserving them upstream. Do not expose the OpenClaw root. In particular,
`/_ac-private/create-session` and `/v1/responses` must stay private. Loopback
trusted-proxy headers are privileged identity assertions; a public root forwarded
by a trusted local reverse proxy can make caller-supplied headers authoritative.
Presence of `x-forwarded-for` is not a secret or a defense against that bypass.
The executable probe includes an exact-path test proxy as a model of this ingress
restriction, not a proposed additional production gateway or live Serve change.

The plugin public handler authenticates a disposable app credential and forwards
fresh app-principal, agent, scope and canonical-session headers. A separate
gateway-authenticated route dispatches only native `sessions.create`, with the
manifest's public `authenticated-request` entitlement. This stamps native creator
authority before Responses continues the session. The canonical key is never
returned to the application; the harness reads native SQLite to verify provenance.

The request name is self-reported and explicitly unverified. Origin is optional.
Only a separate disposable owner secret can approve, deny or revoke a grant.
Credentials and decisions are memory-only; there is no consent UI, persistence,
expiry, polling protocol, publisher verification, rate limit, or production token
storage. The fixture also does not implement fixed approved tool snapshots,
durable tool delivery, overlapping-turn admission, or complete hostile-input
hardening. It does not claim any of those properties.

Run `docs/research/support/openclaw-plugin-delegation-probe.mjs` using Node 24.15
and `OPENCLAW_TEST_BIN` pointing at the pinned published OpenClaw. All model
inference uses the local deterministic fixture, with no subscription/model charge.
The separate sandbox probe covers required-sandbox enforcement.
