# ADR 0012: Delegate runtime execution and Responses to OpenClaw

Implementation prescription superseded on 2026-09-06 by
[ADR 0013](0013-native-provider-delegation-and-ai-sdk.md). Retain this document
as the earlier policy-gateway decision and evidence boundary, not a requirement
to preserve that server or its custom SDK loop.

Status: accepted, 2026-09-05. José selected the built-in OpenClaw loop using his
AI subscription. Release/cutover remains gated on the
[implementation contract](../plan/openclaw-replacement.md).

Reconsideration, later 2026-09-05: José requested investigating direct OpenClaw
application delegation instead of assuming a separate gateway survives. The
desired agent retains its normal owner-approved capabilities; deny-all tools is
the current isolated demo profile, not the desired final product boundary.
See [the delegation research](../research/2026-09-05-openclaw-app-delegation.md).
This records the open decision without silently changing the deployed policy.

Product framing, 2026-09-06: the accepted [Connect your AI north star](../vision.md)
makes OpenClaw a provider implementation of a portable authorization/discovery
profile around Open Responses, not a dependency imposed on every app/provider.
The separate gateway and prototype ingress arrangement are implementation choices,
not universal protocol requirements. Native capabilities remain owner-policy
choices; the isolated demo's deny-all-host-tools configuration is not the endgame.
This clarification does not change live configuration or close release gates.

## Decision

Agent Connect is the application-delegation boundary, not another agent platform.
Use OpenClaw's public Responses endpoint for agent execution and event generation.
Retain the browser SDK, enrolled runtime identity, owner consent, PKCE, narrowly
bound application grants and revocation. Keep only local state needed to enforce
session/response/call ownership and durable application-tool publication.

Replace rather than wrap the existing retained-run engine. Remove Omnigent
provisioning, provider-event vocabulary, synthetic response segment construction
and their obsolete tests once replacement evidence passes. Preserve relevant
public behavioral tests; do not carry an internal abstraction just to make tests
unchanged. This supersedes ADR 0010's bundled custom runtime/response-translation
implementation choice, not its Open Responses application boundary.

## Trust and ownership

OpenClaw's operator credential remains internal to the gateway. Construct a small
allowlisted upstream request and fresh headers: pinned operator agent, private
session routing and approved tool definitions. No app chooses OpenClaw routing,
profiles, credentials, models or built-in tools. The operator runtime profile
must disable host tools by default; declaring browser tools alone is not a sandbox.

An upstream response ID is not an authorization token. Locally verify its owning
application session and latest checkpoint before continuation/cancel/recovery.
Explicit capabilities select sessions; grants create independent sessions.

Record tool calls before exposing them and record output attempts before sending
them upstream. Refuse conflicts and automatic redelivery after ambiguous upstream
acceptance. Recovery reports known state, including interrupted/unrecoverable;
it does not promise exactly once or silently reconstruct a different conversation.

## Why not just an OpenAI SDK and owner token?

That works for an operator-controlled client. It does not safely delegate a
subscription to an independently authored website. Agent Connect's useful code is
the consent/authority boundary and browser integration, not function calling itself.
The ordinary OpenAI client remains a compatibility surface for our bounded API.

## Evidence limits and runtime choice

Pin OpenClaw 2026.9.1. Native Codex is separately packaged as @openclaw/codex;
pinning only the gateway does not pin that adapter. Executed tests showed this
release's native Codex adapter receives no client tool definitions, while the
built-in OpenClaw loop completes the client-tool round trip. Do not claim native
Codex support based on a built-in-loop test. José selected the built-in
subscription loop: using his subscription is the requirement, not retaining the
Codex executable. Native Codex repair is not a prerequisite or current work.

The built-in loop projects returned client output as user text after a synthetic
delegated result, rather than restoring the native tool-role result. Disclose that
semantic difference and prove useful consumption with the actual selected model.

OpenClaw's response/session cache is memory-only, capped at 500 and 30 minutes;
explicit private session routing and local authority checks are therefore needed.
Its HTTP disconnect abort path must be exercised with the chosen runtime before
claiming generation stops. Local cancellation/revocation blocks further app tool
publication even if an upstream stop cannot be confirmed.

## Operations and migration

Develop in a separate checkout on work/openclaw-gateway. Do not disturb the working
personal gateway or auto-import/rotate credentials. Keep existing auth state and
runtime identity. Mark old backend conversations unavailable explicitly; never
reinterpret an Omnigent session ID as an OpenClaw session. New sessions use the
replacement after validated setup. Document rollback and require an explicit live
cutover. No public exposure or push is implicit in this decision.

The success measure is fewer custom responsibilities and easier application use,
not a second permanent backend. See the [dated evidence](../research/2026-09-05-openclaw-replacement.md)
for executable probes and remaining gates.
