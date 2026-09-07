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
platform. On `work/openclaw-scoped-proxy`, the implemented reference path uses a
trusted authorization proxy in front of stock OpenClaw's Responses endpoint.
Agent Connect retains consent, application authority, browser integration and a
bounded grant-to-conversation map; stock OpenClaw owns execution, native events,
context, tools and sandboxing. See
[ADR 0014](decisions/0014-stock-openclaw-scoped-proxy.md).

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

The following describes the scoped-proxy child-branch implementation. The
native-patch experiment remains preserved but is no longer mandatory. Any changed
reliability or consent guarantees must be made explicit.

- Keep the bounded Open Responses profile as the sole application wire:
  `POST /v1/responses`, with the SDK coordinating function outputs and linear
  follow-up through `previous_response_id`.
- Delegate inference, model history, compaction, runtime credentials and
  process behavior to OpenClaw. Do not retain a parallel Omnigent backend,
  custom retained-run protocol or agent event vocabulary.
- Construct upstream requests from the approved tool snapshot and operator
  configuration. Applications cannot choose upstream credentials, agent,
  model, session routing or host tools.
- Re-inject the immutable approved tools on every response segment. Inspect
  native output before publishing a client call, and reject unapproved names.
- Keep a bounded current-checkpoint map independent of OpenClaw's response cache.
  It is intentionally process-local: restart/expiry interrupts continuation,
  and an admitted failure is never automatically replayed.
- Keep transport ingress, owner authentication, gateway identity, application
  grants and session authority separate. Tailscale Serve may supply private HTTPS
  reachability, but owner consent requires the explicit enrollment-secret-backed
  owner session; no forwarding header or tailnet membership is identity.
- Initialize gateway identity once through the trusted operator channel.
  Subsequent application approval happens on the gateway's OAuth/PKCE page,
  without per-application SSH, terminal use or restart.
- Treat applications as adversarial principals. Dedicated static policies can
  expose only app tools, public web search, or sandboxed code execution; the
  app-only default disables native tools.
  The north star permits owner-approved native capabilities alongside app tools,
  with explicit data/execution restrictions. Agent Connect's request allowlist
  does not itself establish an OS sandbox or prevent prompt injection.
- Keep native WebMCP and headless conversation controls harness-neutral.
  Their contracts are [WebMCP](plan/webmcp-tool-source.md) and
  [headless chat](plan/headless-chat.md). Images/files remain deferred.

## Current implementation and acceptance boundary

The stock scoped proxy is implemented on `work/openclaw-scoped-proxy`. It reuses
delegated OAuth/PAR/PKCE, rotating refresh, revocation and the public AI SDK
contract. It constrains requests, selects a dedicated agent/private session,
streams observed native events, and binds one current response checkpoint to an
application grant. Parent-branch native-patch and replacement-engine artifacts
remain for review but are outside this path's required build/start/test surface.

Real published OpenClaw tests using deterministic inference exercise stock
deny-all/sandbox enforcement and the complete owner-login -> OAuth -> two-tool ->
refresh -> follow-up -> revoke composition. They are transport and policy
evidence, not proof that the selected subscription-backed runtime usefully
consumes an actual browser tool result. Final acceptance remains governed by the
[scoped proxy plan](plan/openclaw-scoped-proxy.md).

José selected the built-in OpenClaw subscription loop. The final live
subscription/browser gate remains open.
Published OpenClaw 2026.9.1's built-in loop supports the tested client-tool
round trip; the separately packaged native Codex adapter drops client tools.
Do not call built-in-loop evidence native Codex evidence. The built-in loop
projects returned tool output as user text following a synthetic delegated
result, rather than restoring native tool-role continuation. The actual
selected runtime must prove useful consumption of that result. See the
[dated investigation](research/2026-09-05-openclaw-replacement.md).

Cancellation aborts the active upstream request and prevents continuation, but
generation stopping and already-started effects remain separate runtime-specific
claims. The scoped proxy does not offer restart recovery, usage accounting or an
owner session console; it reports interruptions without replay.

No live cutover is implied by these source changes. The historical private
Tailscale Serve + Omnigent + Codex browser demonstration remains baseline
evidence, not replacement acceptance. [ADR 0010](decisions/0010-open-responses-gateway-pivot.md)
records the earlier bundled-runtime strategy; ADR 0014 supersedes its custom
engine/ledger prescription while retaining the public Open Responses boundary.
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
