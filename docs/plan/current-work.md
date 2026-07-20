# Current work and experiment backlog

Date: 2026-07-18

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
- private Tailscale Serve HTTPS transport with requester allowlisting and
  connector-owned enrollment for previously unknown HTTPS app Origins;
- durable connector identity, first-device enrollment, connector-owned consent,
  PKCE exchange, revocable scoped grant, and post-revocation rejection through
  the deployed phone flow;
- gateway restart with byte-identical persisted connector state, followed by a
  successful deployed Codex/dynamic-tool turn using the existing app grant;
- fail-closed `upstream_unavailable` behavior when the OmniGENT host is offline,
  followed by successful recovery after the host reconnects;
- reboot-resistant public judge profile with a frozen Firebase application and
  tool authority, deterministic ACP runtime, containerized gateway stack, and
  Tailscale Funnel exposure;
- a ten-tool public Canvas snapshot covering a shared live-state read,
  project-board edits, document review, and recorded product research, with one
  connection step separated from repeatable task execution and three
  Codex-authored deterministic plans;
- an isolated rebuild of the judge appliance completed the real
  authorization, OmniGENT, ACP, request-scoped MCP, live app-state retrieval,
  three-tool project-board plan, result-return, revocation, and rejected-reuse
  smoke on 2026-07-18. A separate loopback-only rebuild repeated that proof on
  2026-07-20 with `get_current_app_state` followed by the three write tools. The
  live Funnel profile has not yet been replaced with this new snapshot.
- a source-installable real connector supervisor now starts isolated OmniGENT
  server/host state, the gateway, a narrow compatibility wrapper around the
  pinned `codex-acp`, and real Codex from a dedicated login; on 2026-07-20 a
  previously unknown HTTPS Origin completed signed connector proof, consent,
  PKCE, opaque session creation, one unpredictable application tool call,
  result return, and the same real Codex turn;
- the real connector now derives Codex MCP policy from the authorized tool
  snapshot: a fresh `read-only` Codex turn received exactly the ten Canvas
  tools through `enabled_tools`, preapproved only those tools, read the live
  project board twice, and completed three browser-owned mutations without
  `auto_review` or a downstream approval pause;
- `@agent-connect/web` now packs into a normal npm tarball and passes a clean
  external-consumer install/import check; it is not yet published to npm.

Testing strategy accepted for the connector/provider boundary:

1. fast connector behavior tests use real HTTP requests with an injected
   provider and exhaust Agent Connect's authentication, authorization, session,
   and event-policy branches;
2. an opt-in local integration layer starts disposable real OmniGENT services
   with a deterministic ACP agent, proving the provider contract and isolated
   files without Codex credentials or model usage;
3. real OmniGENT + real Codex + deployed browser remains a manual milestone
   smoke test.

Do not build permanent tailnet runner infrastructure for this phase. Connector
tests cover how Agent Connect consumes trusted-proxy identity headers; they do
not attempt to retest Tailscale's implementation.

Implemented on 2026-07-16:

- fast requester-boundary cases accept the exact configured identity and reject
  missing, unexpected, and ambiguous identities before provider traffic;
- `npm run test:integration:omnigent` pins OmniGENT `0.5.1`, isolates all
  service state, and completes the real gateway/ACP/MCP action-result loop with
  an application-generated nonce and no model credentials;
- the integration harness proves process, port, and temporary-root cleanup on
  both its normal path and a deliberate post-start failure.

Not implemented:

- connector-card/passphrase recovery, export, and key rotation commands;
- durable pending authorization requests, codes, provider mappings, or
  unresolved application tool calls;
- cleanup/expiry for successfully created per-session workspaces and replaced
  provider sessions (failed launches are cleaned immediately);
- provider-owned namespacing for application tools; the reference profile pins
  OmniGENT 0.5.1 until names can no longer collide with moving built-ins;
- coarse public-endpoint rate limiting beyond bounded transient authorization
  state, per-request enrollment lockout, and two concurrent asynchronous
  passphrase verifications;
- a production confinement boundary for a malicious authorized application;
- a first-class session/developer-context field distinct from the user's task
  prompt; the Canvas currently composes its stable instructions into each task
  envelope;
- AG-UI adapter, stable ACP browser adapter, second provider, or published npm
  SDK package. The source-installable connector, public judge appliance, and
  clean packed-SDK consumer smoke are implemented.

The VM bubblewrap experiment is evidence, not a usable security profile. Its
outer probes passed, but the dynamic MCP path failed during startup and the
exact missing mount/runtime dependency remains unconfirmed. Do not put it on
the submission critical path.

## P0 — prove the new auth flow (functional pass)

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

All seven behaviors passed by 2026-07-17. The final post-restart turn reused
the authorized Firebase app, streamed Codex output, completed
`set_page_message`, and visibly updated the page. Sanitized submission
screenshots/video and a polished evidence bundle remain P1 presentation work,
not an auth implementation blocker.

Operator and UX gaps found during the plan audit:

- the explicit malicious-app warning is now present, but its legibility and
  comprehension still need phone validation: authorization proves user intent,
  not application trust;
- first-start enrollment output has no safe re-export/rotation operator path;
- the generic gateway README describes port `8787`, while this VM's established
  private demo route uses `8788`;
- the public page to private-tailnet request can trigger Chrome's local-network
  permission prompt, which needs to be documented in demo UX.

Exit: the coherent auth/tool/revoke/restart story is functionally proven. Carry
the sanitized mobile evidence bundle and issue-list presentation into P1.

## P0.5 — make the connector/provider boundary repeatable (complete)

Implemented [VAL-TEST-001](../../contract/VAL-TEST-001.md) and
[VAL-TEST-002](../../contract/VAL-TEST-002.md):

- cover allowed, missing, unexpected, and ambiguous Tailscale requester values
  with zero provider calls on rejection;
- add a deterministic standards-valid ACP test agent that connects to the
  advertised MCP server and performs a real tools/list and tools/call;
- add an explicit local integration command that launches isolated real
  OmniGENT server/host processes, provisions through `OmnigentRuntime`, drives
  one real gateway HTTP/SSE action-required/result turn, and verifies ACP/MCP
  transcript plus filesystem state;
- keep the real-service layer opt-in and make cleanup reliable on success or
  failure;
- keep Codex credentials, model calls, Tailscale, Firebase, and paid runner
  infrastructure out of this automated layer.

Exit: both fast tests and the real OmniGENT/deterministic-ACP command pass from
documented repository commands. The existing real Codex mobile proof remains
the layer-three composition evidence.

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

- separate connector state, enrollment secret, grants, OmniGENT data, and a
  deterministic ACP agent with no Codex/model credential;
- strict Origin, enrolled-device protection for grant management, and fixed
  app/tool authority;
- one disposable appliance container with no host home, repository, Docker
  socket, or model credential, published only on host loopback;
- public Tailscale Funnel endpoint on the reserved judge port;
- a `public-demo` transport profile that does not pretend a Funnel request has
  the private `tailscale-user-login` guarantee;
- automatic expiry and teardown no later than the end of judging at
  `2026-08-06T00:00:00Z`.

The first judge flow may use a pre-enrolled/restricted demo application if that
is the only safe way to meet the deadline. It must still be isolated from the
personal connector and must not silently weaken the private Tailscale profile.

Exit: a clean-context judge can follow one short instruction set and mutate the
Canvas through the honestly labeled deterministic ACP fixture. The recorded
private composition remains the real Codex/GPT-5.6 proof. A coherent usage
policy, device-scoped grants, and deeper container/operations testing are
security polish after this path is stable.

After implementing the public-demo authorization changes, complete the
[grant-route security retrospective](grant-route-security-retrospective.md),
including the exact source trace, final fix, regression tests, and review
provenance.

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
