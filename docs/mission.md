# Mission: application-owned tools for user-owned agents

## Objective

Make **Connect your AI** a portable application capability: users choose their AI
provider, approve scoped access on its trusted surface, and return to the app with
an authorized Open Responses connection backed by their account/allowance.
The [accepted north star](vision.md), recorded 2026-09-06, defines the long-term
app/provider boundary and proposed interoperability direction. It is not a claim
of an already published standard or completed implementation.

Build a web-first SDK and a provider reference implementation to prove that
contract. A separate Agent Connect gateway, OpenClaw, Tailscale, or a specific
harness is not a requirement for every future provider. Normal application use
must not require installing an MCP server, copying provider conversation IDs,
or opening a terminal.

Agent Connect is the application-delegation boundary, not another agent
platform. The implemented replacement uses OpenClaw's Responses endpoint for
execution and event generation. Agent Connect retains consent, application
authority, browser integration and the durable bookkeeping needed to publish
application calls safely. See [ADR 0012](decisions/0012-openclaw-policy-gateway.md).

## Product promise

The list below describes the current browser implementation contract, not the
complete future interoperability profile. In particular, Origin-bound enrollment
and our session capabilities must not silently become universal requirements.

An application can:

1. verify a gateway enrolled by its user before disclosing tools;
2. obtain a revocable, Origin-bound grant through gateway-owned consent and PKCE;
3. create an independent opaque session or reconnect using its explicit capability;
4. send a prompt and consume streamed text and application function calls;
5. execute application operations locally and return correlated results;
6. follow up using the latest explicit response checkpoint;
7. stop local delivery, inspect recoverable state, or revoke its grant.

Stable call IDs and persistence before publication support application-owned
idempotency. They do not guarantee exactly-once external side effects. An
ambiguous output submission is never automatically replayed.

## Current strategy

The following describes the existing replacement implementation. New work
follows the [accepted OpenClaw-first plan](plan/connect-your-ai-openclaw.md):
provider-owned app grants, shared token enforcement across owner-authentication
flavors, AI SDK execution and Bookhand integration. Do not preserve the custom
SDK loop or gateway bookkeeping solely because they appear in this baseline.
Any changed reliability or consent guarantees must be made explicit.

- Keep the bounded Open Responses profile as the sole application wire:
  `POST /v1/responses`, with the SDK coordinating function outputs and linear
  follow-up through `previous_response_id`.
- Delegate inference, model history, compaction, runtime credentials and
  process behavior to OpenClaw. Do not retain a parallel Omnigent backend,
  custom retained-run protocol or agent event vocabulary.
- Construct upstream requests from the approved tool snapshot and operator
  configuration. Applications cannot choose upstream credentials, agent,
  model, session routing or host tools.
- Re-inject the immutable approved tools on every response segment. Persist
  calls before publication and output attempts before upstream submission.
- Keep local response/call ownership independent of OpenClaw's response cache.
  A grant creates a session; only an explicit capability selects one. Never
  repair a conversation by silently substituting a new upstream session.
- Keep transport ingress, owner authentication, gateway identity, application
  grants and session authority separate. Tailscale Serve remains the supported
  private remote trust profile; hostname recognition alone is not identity.
- Initialize gateway identity once through the trusted operator channel.
  Subsequent application approval happens on the gateway's OAuth/PKCE page,
  without per-application SSH, terminal use or restart.
- Treat applications as adversarial principals. The isolated replacement demo
  disables host tools; this is not the final product's capability ceiling.
  The north star permits owner-approved native capabilities alongside app tools,
  with explicit data/execution restrictions. Agent Connect's request allowlist
  does not itself establish an OS sandbox or prevent prompt injection.
- Keep native WebMCP and headless conversation controls harness-neutral.
  Their contracts are [WebMCP](plan/webmcp-tool-source.md) and
  [headless chat](plan/headless-chat.md). Images/files remain deferred.

## Current implementation and acceptance boundary

The OpenClaw replacement is implemented in the separate
`work/openclaw-gateway` checkout. It preserves gateway identity/grant state,
enrollment, consent, PKCE, explicit session capabilities, streaming and
non-streaming Responses, cancellation/recovery controls and the owner session
console. Old-provider conversations are explicitly interrupted; they are not
reinterpreted as OpenClaw conversations.

Real OpenClaw tests using deterministic inference exercise client-tool
continuation, public routes and process-crash boundaries. They are transport
and policy evidence, not proof that the selected subscription-backed runtime
usefully consumes an actual browser tool result. Final acceptance remains
governed by the [replacement contract](plan/openclaw-replacement.md).

José selected the built-in OpenClaw subscription loop. The final live
subscription/browser gate remains open.
Published OpenClaw 2026.9.1's built-in loop supports the tested client-tool
round trip; the separately packaged native Codex adapter drops client tools.
Do not call built-in-loop evidence native Codex evidence. The built-in loop
projects returned tool output as user text following a synthetic delegated
result, rather than restoring native tool-role continuation. The actual
selected runtime must prove useful consumption of that result. See the
[dated investigation](research/2026-09-05-openclaw-replacement.md).

Cancellation immediately restricts local publication/admission; upstream
generation stopping is a separate runtime-specific claim. Recovery and the
owner console report interruptions and unknown usage honestly. OpenClaw
resource lifetime must be bounded by operator policy and tested with the
selected runtime.

No live cutover is implied by these source changes. The historical private
Tailscale Serve + Omnigent + Codex browser demonstration remains baseline
evidence, not replacement acceptance. [ADR 0010](decisions/0010-open-responses-gateway-pivot.md)
records the earlier bundled-runtime strategy; ADR 0012 supersedes that
implementation choice while retaining its public Open Responses boundary.
App-instance sender binding and recovery/key rotation remain future hardening.

## Explicit non-goals

- a finalized universal protocol or full MCP feature coverage;
- multiple users, hosts or downstream agents, or concurrent tasks within one session;
- arbitrary device/Android control, production multi-tenancy or billing;
- importing or replaying ordinary Codex CLI history or every streamed token;
- generic exactly-once side effects or automatic ambiguous-output redelivery;
- production identity federation, account recovery or a public relay;
- treating arbitrary custom URLs as verified user-owned runtimes;
- silently choosing a replacement harness or model before runtime selection.
