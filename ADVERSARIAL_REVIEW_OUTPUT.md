# Adversarial Review: Agent Connect Hackathon Plan

## 1. Verdict

**Proceed only after changes.** The product insight is strong: an application should be able to lend temporary, scoped capabilities to a user-owned Codex without requiring the application developer to host a model or the user to preinstall an application-specific MCP server. The committed architecture is not yet the smallest credible way to prove that insight.

The current plan joins four individually plausible but uncomposed pieces: an experimental browser ACP WebSocket transport, draft MCP-over-ACP, a new upstream ACP facade over OmniGENT's HTTP/SSE session model, and OmniGENT's downstream generic ACP/MCP relay into the maintained Codex adapter. The repository proves only the innermost browser-side MCP request handler. It contains no conductor, no ACP client wiring, no OmniGENT or Codex adapter dependency, no browser test, and no end-to-end trace. The riskiest join is accurately called an inference in the research, yet the target architecture already treats it as the main path.

Stop expanding the ACP edge and SDK wire surface until a short, transport-free composition experiment proves that OmniGENT can carry one unguessable request-supplied tool result through its generic ACP harness and back into the same Codex turn. Even if it passes, do not build an upstream ACP facade for the hackathon unless that facade is necessary to demonstrate the product. Use OmniGENT's existing HTTP/SSE surface behind a harness-neutral SDK adapter. If the experiment fails or requires invasive changes, use a single-provider Codex app-server gateway with dynamic tools. In either case, expose a small application API and keep draft ACP types behind an experimental adapter.

## 2. Critical findings

### P0 — The central OmniGENT/Codex composition is conjecture, not an implementation dependency that has been retired

**Claim under challenge.** OmniGENT's request-supplied client tools, generic ACP harness, ordinary MCP relay, and the maintained Codex ACP adapter will compose into one continuous turn.

**Repository evidence.**

- The research says explicitly that the exact composition has not been proven live (`docs/research/2026-07-13-landscape.md:21-27`).
- ADR 0002 makes adoption conditional on a live call becoming `action_required`, accepting its result, and resuming the same turn (`docs/decisions/0002-omnigent-conductor.md:23-30`).
- The architecture nevertheless specifies that flow as steps 4-10 (`docs/architecture/target-architecture.md:50-63`).
- Neither `package.json` nor the workspace contains OmniGENT, `@agentclientprotocol/codex-acp`, a pinned fork/commit, a fixture, or a captured trace. The only implemented package is `packages/web-sdk` (`package.json:7-24`).

There are two separate tool systems to reconcile. The browser declares an ACP-transport MCP server. The edge is expected to discover its schemas and convert them into OmniGENT request-supplied client tools. OmniGENT then exposes those tools to Codex through a different, ordinary stdio MCP relay. A Codex call must retain call identity through that relay, become `action_required`, be converted back into a nested browser `tools/call`, and accept a result while the original Codex prompt remains resumable. Evidence that each half exists is not evidence that identifiers, lifecycle, error handling, and same-turn continuation meet at the seam.

**Why it matters.** This is the project-killing risk. Every upstream ACP, reconnect, SDK, and spreadsheet investment is wasted if the downstream turn cannot be suspended and resumed across this exact chain.

**Corrective action.** Before any more architecture work, pin an exact OmniGENT commit and exact Codex adapter version and run the existing OmniGENT client-tool path without the browser SDK or upstream ACP. Use one `runtime: client` tool returning a fresh unguessable nonce. Capture session creation, tool schema injection, downstream MCP discovery, Codex call ID, `action_required`, result submission, and the same turn's final text. Time-box this to four hours. A patch is “narrow” only if it touches an isolated adapter seam, has a focused test, and does not duplicate runner/session lifecycle. Otherwise record a no-go.

### P0 — OmniGENT currently adds more hackathon work than it removes

**Claim under challenge.** Forking OmniGENT avoids rebuilding enough orchestration to justify making it both the upstream agent surface and downstream ACP client.

**Repository evidence.** OmniGENT is not an upstream ACP agent and exposes HTTP/SSE today (`docs/decisions/0002-omnigent-conductor.md:9-12`). To use it as planned, the project must add an authenticated ACP WebSocket endpoint, map ACP lifecycle to Sessions, translate live-tail SSE into ACP updates, terminate nested MCP, map tool schemas and calls, persist pending actions, and clean up cancellation (`docs/scope-inventory.md:18-29`). The edge is assigned connection/session mapping, authorization, nested routing, and durability (`docs/architecture/target-architecture.md:38-44`). The initial scope is only one connection, session, server, and agent (`AGENTS.md:9-13`), so most of OmniGENT's multi-harness UI, policy, sandbox, and lifecycle breadth is not visible in the demo.

**Why it matters.** The plan does not consume OmniGENT as a component; it builds a second protocol server and reliability system in front of it, then depends on a separate adapter behind it. For a one-session Codex demo, this creates three translation boundaries and two session models to debug.

**Corrective action.** Reduce OmniGENT from “target architecture” to “candidate provider experiment.” If its existing HTTP/SSE plus client-tool API passes the composition spike with no or one isolated patch, use those existing surfaces behind the web SDK and defer upstream ACP. If not, remove OmniGENT from the critical path and implement the one-session gateway directly over Codex app-server dynamic tools. Compare providers on measured integration work, not feature inventory.

### P0 — The milestone order spent implementation effort before testing the cheapest fatal assumption

**Claim under challenge.** Milestone 0 is the right foundation before the composition spike.

**Repository evidence.** The original handoff recommends proving the existing OmniGENT path first and using HTTP/SSE for the MVP (`USER_OWNED_AGENT_RUNTIME_HACKATHON_HANDOFF.md:227-233`). The committed plan instead implements the draft browser MCP-over-ACP server first and waits until Milestone 1 to test composition (`docs/plan/hackathon.md:7-39`). The web package README concedes that registering its handlers on an ACP client is still “the next integration step” (`packages/web-sdk/README.md:33-37`). Thus even Milestone 0's claimed ACP session-registration outcome is not present.

**Why it matters.** Draft wire work is disposable if OmniGENT fails, if direct app-server is chosen, or if hackathon time requires the existing HTTP/SSE API. It also creates commitment bias toward ACP before the product flow exists.

**Corrective action.** Make the unguessable-tool composition test Milestone 0. Make the second milestone an explicit conductor decision. Only then build the minimum browser adapter required by the selected provider. Preserve `defineTool` if useful, but treat `SingleMcpServer` as an experimental protocol prototype, not completed foundation.

### P0 — Remote security and ownership are assertions without a minimum design

**Claim under challenge.** An “authenticated WebSocket” and application pairing are enough specification for a browser to operate a user-owned agent safely.

**Repository evidence.** The plan names an authenticated endpoint but supplies no credential issuance, pairing, revocation, origin, or session-ownership contract (`docs/plan/hackathon.md:41-48`). The scope inventory merely states that the conductor authenticates and pairs applications (`docs/scope-inventory.md:31-38`). The browser transport says cookies or subprotocols may be used (`packages/web-sdk/src/transport.ts:6-24`), but there is no origin validation, CSRF defense, token binding, or test. The mission promises arbitrary applications, local tool execution, session loading, and mutation recovery (`docs/mission.md:9-19`), all of which amplify confused-deputy risk.

**Why it matters.** A malicious web origin could attempt to connect to a reachable personal runtime, load another application's session, register deceptive tools, or use ambient cookies. Tool descriptions, arguments, and results are untrusted content. A compromised page already has its own origin privileges; the bridge must not grant it another app's agent session or broader runtime authority.

**Corrective action.** Before any remotely reachable demo, specify and test a minimum threat model: explicit one-time pairing; short-lived bearer capability bound to user, application ID, allowed origin, session, and tool-server ID; strict WebSocket `Origin` checking; no cookie-only cross-origin authentication; revocation; per-session tool allowlist/hash; write approval in the originating page; session-load authorization; maximum schema/message/result sizes; tool timeout and concurrency limit; sanitized logs; and no raw Codex/OmniGENT endpoint exposed to the network. Run the first spike on loopback or an authenticated tunnel until these rules exist.

### P1 — Reconnect and “no duplicate write” semantics are not defined tightly enough

**Claim under challenge.** Persisting a pending action and adding a stable action ID is sufficient to recover mutations safely.

**Repository evidence.** The profile says requests will be persisted and redispatched or listed (`docs/architecture/narrow-protocol-profile.md:37-39`), and the plan names state transitions without defining them (`docs/plan/hackathon.md:56-70`). In the SDK, `actionId` is optional (`packages/web-sdk/src/types.ts:31-36`) and is extracted from an unversioned metadata key (`packages/web-sdk/src/single-mcp-server.ts:20,201-207,253-257`). There is no persistence, claim/lease protocol, cancellation propagation, handler abort signal, completion deduplication, or test for concurrent old/new clients.

**Why it matters.** A disconnect after a side effect but before acknowledgement is fundamentally ambiguous. Redispatch can duplicate a write; a permanent claim can strand it; cancellation can race execution. The conductor cannot promise at-most-once external effects without an application journal or idempotency key.

**Corrective action.** Define a small state machine and its ownership before implementing it: `pending -> claimed(lease) -> executing -> completed|failed|rejected|expired`, with an immutable action ID, attempt IDs, atomic claim, lease expiry, idempotent result submission, and recorded final result. Consequential handlers must reject calls without an action ID and the demo spreadsheet must journal that ID atomically with the mutation. Define cancellation as best-effort: stop undispatched work, signal active handlers, but never infer rollback. For the hackathon, explicitly defer multi-client claims, crash recovery during a non-idempotent external operation, generic exactly-once claims, token replay, and arbitrary resumable handlers. Demonstrate only the idempotent spreadsheet invariant the repository can prove.

### P1 — The public SDK leaks the exact unstable protocol it claims to isolate

**Claim under challenge.** Draft-specific code and types are isolated so the public tool-registration API can survive protocol drift.

**Repository evidence.** The repository guidance requires that isolation (`AGENTS.md:3-8`), but the package publicly exports `SingleMcpServer`; its public `descriptor` is the ACP SDK's `McpServer`, and its public handlers accept draft `ConnectMcpRequest`, `MessageMcpRequest`, and `DisconnectMcpRequest` (`packages/web-sdk/src/index.ts:1-17`; `packages/web-sdk/src/single-mcp-server.ts:1-9,56-58,94-120`). It also publicly exports the experimental WebSocket stream directly (`packages/web-sdk/src/transport.ts:1-24`). The protocol profile has no profile identifier, version negotiation, capability flag, or compatibility matrix (`docs/architecture/narrow-protocol-profile.md:1-52`).

**Why it matters.** A change in ACP's draft MCP descriptor, message framing, or WebSocket package path becomes an application-facing breaking change. Pinning SDK `1.2.1` protects today's build, not interoperability with a conductor using another draft.

**Corrective action.** Make the stable surface application-shaped: `defineTool`, `connectRuntime`, `startSession`, event subscription, `approve/reject`, and an application-owned idempotency hook. Put ACP transport classes under an explicitly experimental export such as `@agent-connect/web/experimental/acp-1_2`, or keep them internal. Add a wire/profile identifier and capability negotiation at the gateway boundary. Fail closed on a mismatch. Supersede ADR 0001 so ACP remains the desired provider/session protocol, not a premature promise that every application must speak today's draft wire format.

### P1 — The SDK evidence does not meet its own foundation claims

**Claim under challenge.** The browser SDK foundation registers an MCP server in `session/new`, provides typed/schema-safe handlers, and has public behavior adequately tested.

**Repository evidence.** `createBrowserAcpStream` only creates a stream, and `SingleMcpServer` only exposes callbacks; no ACP `ClientSideConnection` or equivalent wires them together or sends `session/new` (`packages/web-sdk/src/transport.ts:13-25`; `packages/web-sdk/README.md:33-37`). The scope inventory nevertheless assigns “`session/new` carries one ACP MCP descriptor” to Foundation (`docs/scope-inventory.md:3-11`). Incoming arguments are checked only to be a non-array object and are cast into the generic handler type; `inputSchema` is never evaluated (`packages/web-sdk/src/single-mcp-server.ts:176-207`). Any handler exception message is sent to the agent (`packages/web-sdk/src/single-mcp-server.ts:209-219`), which avoids a stack but can still disclose sensitive details. All six tests call the server methods directly under Node (`packages/web-sdk/test/single-mcp-server.test.ts:31-198`).

**Why it matters.** “Typed tool” currently means ergonomic compile-time authoring, not validation of hostile wire input. The tests cannot detect incorrect ACP registration, serialization, browser globals, origin/cookie behavior, or a broken package export.

**Corrective action.** Rename the present result “single-server MCP handler prototype.” Validate arguments against a real JSON Schema implementation or clearly require each tool to provide a runtime parser. Add an ACP connection integration test using the official connection layer, a real-browser smoke test, a built-package consumer test, protocol-version tests, handler timeout/cancellation tests, and redacted public errors with internal diagnostics. Do not mark Foundation complete until `session/new` and inbound client handlers work through a serialized connection.

### P1 — The fallback is an alternative architecture, not schedule protection

**Claim under challenge.** The downstream half can simply be replaced with Codex app-server while the application-facing surface remains unchanged.

**Repository evidence.** The fallback is one paragraph mapping listed tools to experimental `dynamicTools` and callbacks to the pending broker (`docs/architecture/target-architecture.md:65-67`). No provider interface, broker, app-server dependency, authentication test, or dynamic-tool spike exists. The research itself labels app-server WebSocket and dynamic tools experimental (`docs/research/2026-07-13-landscape.md:5-9`).

**Why it matters.** Maintaining OmniGENT and app-server paths in parallel doubles the hardest code: session semantics, event normalization, approvals, cancellation, tool-call continuation, authentication, and tests. Discovering late that the fallback also has incompatible turn behavior is not protection.

**Corrective action.** Run the direct Codex dynamic-tool nonce spike immediately after or alongside the four-hour OmniGENT spike, using the same trace contract. Choose one provider before building the browser edge. Keep only a small internal provider interface based on observed events; do not implement the losing provider during the hackathon.

### P1 — Permission UX conflates agent permissions with application mutation authorization

**Claim under challenge.** Mapping ACP `session/request_permission` and adding approval hooks is sufficient to authorize application-owned mutations.

**Repository evidence.** The profile lists `session/request_permission` (`docs/architecture/narrow-protocol-profile.md:14-25`), while the architecture assigns application approval hooks to the SDK (`docs/architecture/target-architecture.md:34-36`), but no policy says which actor requests approval, what is shown, how approval binds to exact arguments/action ID, or whether a changed retry needs new consent. No approval API exists in the package.

**Why it matters.** A Codex permission request normally governs Codex-side actions. It is not automatically authorization for a spreadsheet write executed in a browser. Reusing the same UI event without binding approval to the actual application operation creates a confused-deputy hole.

**Corrective action.** Define application mutation approval as a separate browser-owned decision. Show tool, normalized arguments/diff, application identity, session, and immutable action ID; bind the approval record to a digest of those values; reject altered retries. Read-only tools may be session-allowlisted. Treat downstream ACP permission events as a separate event class.

### P2 — Research provenance is insufficient for a fast-moving dependency decision

**Claim under challenge.** The time-stamped landscape is enough evidence to accept the ADRs.

**Repository evidence.** The research names behavior but gives no inspected commit, source file, test path, or permalink for OmniGENT, Codex ACP, or ACP SDK (`docs/research/2026-07-13-landscape.md:1-27`). The older handoff records an OmniGENT commit (`USER_OWNED_AGENT_RUNTIME_HACKATHON_HANDOFF.md:84-124`) but also warns that sources must be refreshed (`USER_OWNED_AGENT_RUNTIME_HACKATHON_HANDOFF.md:307-316`).

**Why it matters.** The plan depends on alpha and explicitly experimental surfaces. Without exact versions and traceable source evidence, “narrow patch” and protocol compatibility cannot be reproduced.

**Corrective action.** Pin exact commits/versions in the spike record; cite source and test permalinks for each external assertion; save a sanitized trace and setup script; record what was observed versus inferred. Promote an assumption to architecture only after the local trace proves it.

### P2 — Verification configuration proves a library unit, not the next phase's contracts

**Claim under challenge.** The workspace and evidence contracts are adequate for implementation expansion.

**Repository evidence.** `npm run verify` runs formatting, TypeScript, six Node/Vitest unit tests, and TypeScript build (`package.json:13-24`). It passes, but there is no lint rule, browser runner, consumer install/import test, protocol trace assertion, gateway package, persistence test, or end-to-end project. The plan's claimed public-import exit criterion is not represented by a script (`docs/plan/hackathon.md:18-22`).

**Why it matters.** A green root command can be mistaken for evidence of browser or protocol readiness. The current package boundaries also provide no obvious home for provider adapters, pending-action storage, or the demo.

**Corrective action.** Add packages only after provider selection: `packages/web-sdk` for application API, `packages/gateway` for auth/broker/session mapping, one internal provider adapter, and `apps/spreadsheet-demo`. Add explicit gates for built-package import, browser smoke, provider nonce trace, permission binding, and persistence/idempotency. Keep Node-only provider code out of the browser package.

### P2 — The current demo can look like generic protocol plumbing unless the Codex value is made visible

**Claim under challenge.** A spreadsheet cleanup plus reconnect is sufficient differentiation for a Build with Codex hackathon.

**Repository evidence.** The planned visible workflow emphasizes spreadsheet changes and reconnect (`docs/plan/hackathon.md:3-5,72-96`). The unique relationship—an app temporarily lends tools to the user's existing Codex without an app-owned model key or preinstalled MCP server—is mostly documentation framing (`docs/mission.md:11-19`).

**Why it matters.** Judges may see a spreadsheet agent, a protocol tunnel, or an OmniGENT integration rather than a new Codex application primitive. Reliability is valuable but visually secondary and expensive to demonstrate cleanly.

**Corrective action.** Make temporary capability lending the hero: show the app's concise tool definitions; pair to the user's Codex-backed runtime; visibly show “no application model key / no MCP install”; show Codex discovering only the session-scoped tools; preview and approve a live mutation; revoke the tools when the session ends. Show one short reconnect/idempotency proof in an inspector or audit panel after the core value is already obvious.

## 3. Assumption ledger

| Link or claim                                                                                | Classification                                          | Evidence and consequence                                                                                                                                                |
| -------------------------------------------------------------------------------------------- | ------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Workspace installs, typechecks, tests, and builds                                            | Proven in this repo                                     | `npm run verify` passes; this covers six direct Node unit tests and TypeScript build only (`package.json:13-24`).                                                       |
| Browser-safe wrapper can construct the official SDK's WebSocket stream                       | Proven at unit/build level only                         | Wrapper exists (`packages/web-sdk/src/transport.ts:1-25`); no real-browser or server handshake evidence.                                                                |
| One in-memory MCP handler can connect, initialize, list, call, and disconnect                | Proven in this repo                                     | Direct unit tests cover the happy path and several errors (`packages/web-sdk/test/single-mcp-server.test.ts:31-198`).                                                   |
| Tool arguments satisfy the declared schema                                                   | Disproven                                               | Only object shape is checked; schema is not evaluated (`packages/web-sdk/src/single-mcp-server.ts:181-207`).                                                            |
| Browser SDK registers client handlers and supplies the descriptor in `session/new`           | Conjectural/unimplemented                               | README calls this the next integration step (`packages/web-sdk/README.md:33-37`).                                                                                       |
| Official ACP SDK contains experimental WebSocket and MCP-over-ACP types                      | Externally supported, locally consumed                  | Exact SDK `1.2.1` is pinned (`packages/web-sdk/package.json:23-25`); no interoperability trace exists.                                                                  |
| Maintained Codex ACP accepts ordinary stdio/HTTP MCP servers but not ACP-transport MCP       | Externally supported, unproven here                     | Research assertion only (`docs/research/2026-07-13-landscape.md:11-19`); adapter is not installed or pinned here.                                                       |
| OmniGENT can run a downstream generic ACP agent and expose its tools through ordinary MCP    | Externally supported, unproven here                     | Research and handoff source inspection (`docs/research/2026-07-13-landscape.md:21-27`; `USER_OWNED_AGENT_RUNTIME_HACKATHON_HANDOFF.md:84-124`).                         |
| OmniGENT request-supplied client tools become `action_required`                              | Externally supported, unproven here                     | No exact version, fixture, or live trace in this repository.                                                                                                            |
| Request-supplied tools compose through OmniGENT's generic ACP relay and maintained Codex ACP | Conjectural                                             | Explicitly called unproven (`docs/research/2026-07-13-landscape.md:23-25`).                                                                                             |
| The tool result resumes the same Codex turn to completion                                    | Conjectural                                             | It is a go criterion, not evidence (`docs/decisions/0002-omnigent-conductor.md:25-30`).                                                                                 |
| OmniGENT can act as an upstream ACP/WebSocket agent                                          | Unimplemented and contrary to current external behavior | Plan requires a new edge because OmniGENT currently exposes HTTP/SSE (`docs/decisions/0002-omnigent-conductor.md:9-21`).                                                |
| ACP session semantics map cleanly to OmniGENT session/SSE semantics                          | Conjectural                                             | Semantic mismatch and live-tail gaps are listed risks (`docs/scope-inventory.md:22-24`).                                                                                |
| Pending application calls are durable/recoverable                                            | Disproven for current OmniGENT path; unimplemented here | Research says `action_required` is not persisted (`docs/research/2026-07-13-landscape.md:27`).                                                                          |
| Stable action IDs prevent duplicate mutations                                                | Conjectural as a system property                        | SDK extracts an optional metadata value, but no broker or app journal exists (`packages/web-sdk/src/types.ts:31-36`).                                                   |
| Authenticated pairing, origin binding, and session ownership work                            | Conjectural                                             | They appear as requirements only (`docs/scope-inventory.md:31-38`).                                                                                                     |
| Direct app-server dynamic tools are a drop-in fallback                                       | Externally plausible, unproven here                     | The fallback and dynamic tools are both experimental and have no spike (`docs/architecture/target-architecture.md:65-67`; `docs/research/2026-07-13-landscape.md:5-9`). |

## 4. Recommended architecture

For the hackathon, **remove OmniGENT from the committed target architecture and retain it only as a provider experiment until the nonce trace passes**. Also stop requiring draft ACP on the browser-facing wire. The smallest credible architecture is:

```text
browser application
  stable app API: defineTools, runTask, events, approve, reconnect
             |
             | versioned authenticated gateway channel
             v
Agent Connect gateway
  origin/session authorization
  tool registry snapshot
  pending-action broker + audit
  one internal AgentProvider interface
             |
             | selected hackathon provider
             v
Codex app-server dynamic tools
             |
             v
user-authenticated Codex
```

This has one session model and one tool-call translation. The gateway is the only Node/server package. The web SDK contains no Node imports and no Codex, OmniGENT, or draft ACP types. The internal provider interface should be derived after the direct nonce spike and cover only `create/load session`, `prompt`, normalized events, `cancel`, and application tool request/result. Do not generalize it for multiple simultaneous providers.

If the OmniGENT experiment passes essentially unmodified and its session/policy/UI value is genuinely useful to the demo, substitute an `OmniGentProvider` that uses existing HTTP/SSE and client-tool APIs. Do **not** add the upstream ACP facade for the hackathon. That facade contributes standards alignment but no visible product proof, and it forces translation of lifecycle and live-tail behavior.

ACP remains a sound long-term candidate for the provider/session boundary, especially once remote transport and MCP-over-ACP stabilize. It should be an internal experimental adapter now. A future `AcpProvider` can implement the same observed gateway interface, and the high-level web API will survive wire drift. If exposing ACP interoperability itself is a judging requirement, publish it as a named, versioned experimental profile rather than the default stable SDK contract.

## 5. Revised execution plan

1. **Kill experiment: OmniGENT composition (maximum four hours).** Pin exact sources. Use the existing OmniGENT client path, one `runtime: client` tool, the maintained Codex ACP adapter, and a nonce Codex cannot guess. Exit only on a sanitized trace proving discovery, call, `action_required`, result correlation, and same-turn completion. No upstream ACP, browser, or persistence work. Fail closed on timeout or invasive patch requirements.

2. **Control experiment: direct Codex dynamic tool (maximum four hours).** Run the same nonce contract against Codex app-server. Record authentication setup, call/result IDs, cancellation behavior, and same-turn completion. Exit with a comparable trace, not a verbal conclusion.

3. **Select exactly one provider.** Choose on working trace, patch size, deterministic setup time, and number of translation/session boundaries. Write a short ADR that names the losing path as deferred. If neither path passes, stop the broad architecture and demo a local SDK/tool-call prototype honestly rather than claiming an end-to-end runtime.

4. **Build a loopback gateway slice.** Implement one session, prompt/events, fixed tool snapshot, and one read-only tool. Use the selected provider's existing transport. Exit when a real browser returns a nonce through Codex and the same turn finishes. Capture a protocol/application trace.

5. **Add the minimum remote security envelope.** Implement explicit pairing, origin validation, scoped short-lived capability token, session ownership, limits/timeouts, revocation, and sanitized audit. Exit when wrong-origin, wrong-session, expired-token, oversized-schema, and timeout tests fail closed. Until then, keep the demo loopback/tunnel-only.

6. **Add application approval and one idempotent mutation.** Bind approval to action ID plus argument digest. Journal the action ID atomically with the spreadsheet mutation. Exit when changed arguments require new approval and replay returns the recorded result without a second write.

7. **Add narrow reconnect recovery.** Persist before notification. Demonstrate disconnect before execution and disconnect after execution/before acknowledgement for the idempotent spreadsheet operation. Exit on database/audit evidence and one final Codex completion. Do not claim generic exactly-once behavior.

8. **Polish the judging slice.** Show temporary tool lending, existing user Codex authentication, no app model key, no MCP installation, preview/approval, revocation, and a compact recovery audit. Exit on a fresh-machine documented run and recorded backup demo.

9. **Only after the demo, evaluate ACP exposure.** If time remains, implement a named experimental ACP adapter/profile behind the same application API. It is not a prerequisite for the product proof.

## 6. Delete/defer list

- Delete upstream ACP-over-WebSocket implementation from the hackathon critical path unless interoperability itself is the chosen demo.
- Defer MCP-over-ACP as a public default; retain the current handler only as an experimental prototype or internal adapter.
- Defer the OmniGENT fork unless the composition spike passes and the patch is demonstrably isolated.
- Delete the promise that the direct app-server provider is a drop-in fallback; make provider selection an early fork.
- Defer multiple providers, agents, sessions, applications, logical MCP servers, and dynamic tool-list changes.
- Defer generalized durable claims/leases, failover across multiple browsers, and recovery of arbitrary non-idempotent side effects.
- Defer token-delta replay, generic exactly-once language, Android/device automation, normal Codex history import, billing, marketplace, and production multi-tenancy, consistent with the existing non-goals (`docs/mission.md:33-42`).
- Defer full MCP resources, prompts, sampling, elicitation, pagination, and subscriptions.
- Remove “typed” as a runtime-safety claim until wire arguments are actually validated.
- Rename the current `SingleMcpServer` result in status documents from “web SDK foundation” to “experimental single-server MCP handler prototype.”
- Avoid “ACP-first public boundary” in the hackathon pitch. Prefer “application capability bridge with an experimental ACP profile” until interoperability exists.

## 7. Demo and judging strategy

The demo should answer one question visually: **What can an ordinary application do with the user's existing Codex that it could not do before?**

1. Open the spreadsheet app and show that it has no OpenAI API key and that no spreadsheet MCP server is installed in Codex.
2. Show a small, readable `defineTool` block in the app and pair it to the user's runtime.
3. Start a Codex-backed session and show the exact temporary, session-scoped tools Codex receives.
4. Ask Codex to diagnose the table and propose a mutation. Stream enough reasoning/progress to establish that Codex is doing the work.
5. Display an application-owned diff/approval card bound to the tool name, arguments, and action ID. Approve it and apply the live change.
6. End the session and visibly revoke the tool surface.
7. In a short reliability coda, interrupt one pending idempotent write, reconnect, and show the audit record proving one mutation and same-turn completion.

The pitch is: “Apps usually bring a model key, and agents require preconfigured integrations. Agent Connect lets the user bring Codex; the app lends it temporary capabilities for one session.” Codex authentication, planning, tool choice, continuation after a tool result, and user ownership must be visible. OmniGENT branding, ACP framing, and gateway internals should be an architecture slide, not the narrative center.

## 8. Strongest alternative: no OmniGENT

Build a small local gateway directly over Codex app-server's authenticated session/turn API and experimental dynamic tools:

- The browser pairs with the gateway and registers a fixed tool snapshot through the high-level Agent Connect API.
- The gateway creates a Codex thread/turn with those dynamic tools.
- On a Codex dynamic-tool call, the gateway persists a pending action, requests browser execution, and returns the result to the same Codex turn.
- The gateway normalizes Codex updates into the few app events the demo needs.
- A SQLite table owns session mappings, action state, approval digest, and recorded result.
- Raw app-server remains loopback-only; the gateway is the sole remotely reachable surface.

**What this gains:** one fewer session model, no SSE-to-ACP translation, no downstream ACP process/stdio MCP relay, direct access to Codex call IDs, a smaller debugging surface, and a clearer Build with Codex story.

**What this loses:** OmniGENT's multi-harness support, existing normalized conversation store, policies, sandbox/runner lifecycle, web UI, and a shorter route to non-Codex providers. It also depends directly on experimental app-server dynamic tools and requires the project to own minimal session persistence/event normalization.

For the stated one-session, one-Codex hackathon scope, those losses are acceptable. The gateway must not pretend to be a general conductor, and its Codex types must stay inside `CodexProvider`. OmniGENT becomes attractive again after the demo if multi-harness lifecycle is the next product requirement or if its composition spike proves it eliminates more code than this direct provider.

## 9. Proposed documentation edits

- **`README.md`** — Change repository status to “experimental MCP handler prototype”; state that no end-to-end conductor path is proven; make temporary capability lending the lead; avoid implying OmniGENT is selected.
- **`AGENTS.md`** — Keep the product boundary, but require draft protocol exports to live under an experimental subpath and require a provider trace before adding another adapter. Clarify that the current one-provider restriction does not authorize an OmniGENT plus fallback dual implementation.
- **`USER_OWNED_AGENT_RUNTIME_HACKATHON_HANDOFF.md`** — Leave as historical research, but add a prominent supersession pointer rather than silently contradicting its “prove first/use HTTP-SSE” recommendation.
- **`docs/mission.md`** — Separate the product promise from hackathon proof. Make generic reconnect durability and ACP compatibility staged goals; phrase the acceptance boundary around one idempotent demonstrated mutation.
- **`docs/scope-inventory.md`** — Correct Foundation evidence: `session/new` and browser connection are not implemented. Add columns for status (`proven`, `external`, `conjectural`) and exact evidence artifact. Add security ownership and runtime validation rows.
- **`docs/architecture/target-architecture.md`** — Replace the unconditional OmniGENT diagram with the selected one-provider gateway after the spikes. Until then, label both candidates as experiments. Remove the upstream ACP edge from the critical path and define the pending-action/application-approval boundary precisely.
- **`docs/architecture/narrow-protocol-profile.md`** — Move to an experimental/future section or add an explicit profile identifier, SDK version, negotiation, action-ID extension, message limits, timeout/cancellation behavior, and mismatch failure rules.
- **`docs/decisions/0001-acp-first-application-boundary.md`** — Supersede rather than edit history. The replacement ADR should choose a stable application API with ACP as an experimental provider/wire adapter until remote and MCP-over-ACP behavior are proven.
- **`docs/decisions/0002-omnigent-conductor.md`** — Change accepted status to proposed/time-boxed experiment until its go criteria have trace evidence. Define “narrow patch” objectively and link the exact pinned commit.
- **`docs/plan/hackathon.md`** — Put the two nonce spikes first, require an explicit single-provider decision, then order browser, security, approval/idempotency, reconnect, and polish. Add time limits and artifact-based exit criteria.
- **`docs/research/2026-07-13-landscape.md`** — Add exact versions/commits, source/test permalinks, inspection date, and a clear observation-versus-inference table. Link the captured spike traces when available.
- **`packages/web-sdk/README.md`** — Mark `SingleMcpServer` and ACP WebSocket exports experimental; do not imply runtime argument safety from TypeScript schemas; document authentication limitations and the absence of reconnect/approval.
- **Root workspace configuration** — Add named scripts for built-package consumer smoke, browser smoke, provider composition trace, and gateway integration. Keep `verify` honest by distinguishing unit verification from live/provider verification until both environments exist.
