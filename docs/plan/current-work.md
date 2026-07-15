# Current work and experiment backlog

Date: 2026-07-15

This is the canonical ordering of unfinished work. Detailed design remains in
the linked plans; when priorities conflict, this document controls execution
order through the Build Week submission deadline.

## Current state

Implemented and proven on a real remote browser:

- provider-neutral browser task/tool API backed by an internal OmniGENT
  adapter;
- fixed per-session application tool snapshots and opaque Agent Connect ids;
- gateway-owned OmniGENT session provisioning and unhealthy-runner healing;
- Firebase Canvas calling a dynamically supplied `set_page_message` tool
  through Codex;
- private Tailscale Serve HTTPS transport with Origin and requester
  allowlists.

Implemented with automated coverage, but not yet proven on the deployed phone
surface:

- durable connector identity and signed fresh challenge;
- generated enrollment passphrase and enrolled-device cookie;
- connector-owned consent with S256 PKCE and single-use code;
- durable origin/app/scope/tool-snapshot-bound grants and immediate revocation.

Not implemented:

- public judge transport/profile and isolated judge credentials;
- connector-card/passphrase recovery, export, and key rotation commands;
- durable pending authorization requests, codes, provider mappings, or
  unresolved application tool calls;
- a production confinement boundary for a malicious authorized application;
- container appliance, AG-UI adapter, stable ACP browser adapter, second
  provider, or published SDK package.

The VM bubblewrap experiment is evidence, not a usable security profile. Its
outer probes passed, but the dynamic MCP path failed during startup and the
exact missing mount/runtime dependency remains unconfirmed. Do not put it on
the submission critical path.

## P0 — prove the new auth flow now

Follow the [private demo auth runbook](private-demo-auth-validation.md).

Required evidence:

1. runtime-card import and signed connector proof;
2. first-device enrollment on the connector origin;
3. consent bound to the real Firebase origin, callback, scopes, and tool
   schema;
4. PKCE return, Codex stream, dynamic tool request/result, and visible page
   mutation;
5. grant listing and revocation;
6. rejection of both a new request and an already issued session capability;
7. gateway restart preserving connector identity and revoked state.

Operator and UX gaps found during the plan audit:

- the explicit malicious-app warning is now present, but its legibility and
  comprehension still need phone validation: authorization proves user intent,
  not application trust;
- first-start enrollment output has no safe re-export/rotation operator path;
- the generic gateway README describes port `8787`, while this VM's established
  private demo route uses `8788`;
- the public page to private-tailnet request can trigger Chrome's local-network
  permission prompt, which needs to be documented in demo UX.

Exit: one sanitized mobile evidence bundle and an issue list grounded in the
real run. Fix only failures that block the coherent auth/tool/revoke story.

## P1 — freeze the submission story

Deadline: `2026-07-22T00:00:00Z` (July 21 at 5:00 PM Pacific).

Use Firebase Canvas as the only promised product demonstration. Freeze the
working behavior after P0; do not add spreadsheet durability, a second agent,
or a new upstream wire protocol before recording.

Complete:

- submission-oriented root README and clean installation/test instructions;
- supported-platform and security-posture table;
- license and third-party attribution review;
- visible documentation of Codex/GPT-5.6's downstream role;
- sanitized architecture diagram and evidence;
- `/feedback` from primary session
  `019f5c47-a462-73d0-a329-39013786bae4`;
- public narrated video under three minutes;
- final live Devpost rules/announcement refresh and submitted-state check.

The [submission guide](openai-build-week-submission.md) remains the source of
truth for fields, judging strategy, and the storyboard.

## P1 — give judges an isolated path

Implement the [judge demo environment](judge-demo-environment.md) independently
of the personal connector:

- separate connector state, enrollment secret, grants, Codex credential, and
  OmniGENT data;
- strict origin, concurrency, turn, time, and rate limits;
- public Tailscale Funnel endpoint on the reserved judge port;
- a `public-demo` transport profile that does not pretend a Funnel request has
  the private `tailscale-user-login` guarantee;
- automatic expiry and teardown no later than the end of judging at
  `2026-08-06T00:00:00Z`.

The first judge flow may use a pre-enrolled/restricted demo application if that
is the only safe way to meet the deadline. It must still be isolated from the
personal connector and must not silently weaken the private Tailscale profile.

Exit: a clean-context judge can follow one short instruction set, mutate the
Canvas through Codex, and cannot exceed the documented demo limits.

## P2 — time-box the container appliance

Spend at most 24–36 hours on Phase A of the
[container plan](containerized-connector-appliance.md), with a hard fallback to
the already working VM-local stack if it threatens the demo or judge path.

Questions to answer:

- can one reproducible image contain the gateway, OmniGENT, Codex ACP, and
  Codex without mounting the host home or Docker socket?
- can connector state persist while each logical session receives a fresh
  scratch workspace?
- can a Codex credential be injected deliberately, kept out of the image, and
  revoked after judging?
- can the live Firebase auth/tool/revoke loop pass unchanged through the image?

Phase A is valuable even if the answer is “not before submission.” Do not call
the image a malicious-app sandbox until filesystem, process, credential, and
network probes pass through the actual Codex/ACP path.

## Post-submission reliability work

In order:

1. persist unresolved application tool requests before notification and expose
   recovery separately from conversation resume;
2. persist logical-to-provider session mappings and pending auth/code state;
3. add operator export, device management, connector-key rotation, recovery,
   and audit history;
4. add app-instance proof/DPoP and incremental consent if threat evidence
   justifies them;
5. enforce per-app budgets and terminate active downstream work on revocation;
6. package and publish `@agent-connect/web` only after its compatibility and
   security claims match the implementation.

Keep stable action IDs and require idempotent application operations or
application-owned deduplication. Do not claim generic exactly-once execution.

## Bounded experiments after the coherent demo

Run each as a decision experiment with an exit criterion, not as parallel
product rewrites:

1. **AG-UI compatibility:** determine whether its run/event/tool vocabulary can
   replace the custom application event language while Agent Connect retains
   enrollment, authorization, runtime ownership, and provider lifecycle.
2. **ACP browser adapter:** revisit WebSocket transport and MCP-over-ACP only
   when the unstable feature is supported end to end; keep draft types out of
   the default API.
3. **Second provider/OpenClaw:** prove the provider boundary with one adapter
   only after the public contract and recovery semantics stabilize. Record an
   ADR before adding another proprietary session protocol.
4. **OmniGENT upstream work:** propose request-scoped tool support in its public
   client, dynamic-tool session rotation/healing, and durable unresolved-action
   discovery rather than carrying a private fork by default.
5. **Confinement:** prefer the container boundary. Return to bubblewrap only if
   the exact dynamic-MCP launch dependency can be isolated cheaply.
6. **Managed deployment profiles:** evaluate Fly/Cloud Run/other container
   targets only after the image contract, credential injection, and connector
   identity lifecycle are reproducible locally.

## Explicitly deferred

- generalized multi-agent orchestration;
- arbitrary MCP server support;
- Android automation;
- spreadsheet mutation and exactly-once-style reconnect demo;
- hardware-attestation claims or verification of a self-reported downstream
  sandbox;
- replacing OmniGENT merely to make the architecture look more neutral.

The product boundary is already harness-neutral where applications touch it.
OmniGENT remains an internal implementation and can be replaced only when a
second adapter demonstrates a concrete advantage.
