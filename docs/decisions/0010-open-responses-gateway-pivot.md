# 0010: Use Open Responses at the application boundary

- Status: proposed; pending vertical-slice evidence
- Date: 2026-08-26
- Revised: 2026-08-28

## Context

Agent Connect exists so an application can use an AI runtime controlled by its
user. The application should not need to pay for inference, collect a provider
API key, or know whether that runtime is implemented by Codex, Claude Code,
another harness, a local model, or a future provider endpoint with delegated
subscription access.

The current proof uses a provider-neutral browser API over Omnigent HTTP/SSE.
It demonstrated the central behavior: an application can send work to a
user-owned Codex runtime, supply a fixed set of typed application functions,
execute requested functions locally, and return their results to the same
agentic execution.

It also accumulated overlapping vocabularies. Agent Connect normalizes
Omnigent events into its own task model while separately considering AG-UI,
ACP, and MCP-over-ACP. These layers describe many of the same prompt,
streaming, function-call, function-output, continuation, and completion
semantics. Maintaining another public agent protocol was never the product.

[Open Responses](https://www.openresponses.org/specification) provides a
provider-neutral request, response, streaming, function-call, function-output,
and continuation vocabulary close to the original Agent Connect intent. It is
not a perfect description of a coding harness's internal process, but the
application does not need that process model. It needs a stable way to submit
input, observe meaningful output, service application function calls, cancel
work, and determine completion.

## Decision

Agent Connect will target a deliberately bounded Open Responses profile as its
public application-to-gateway protocol.

An Agent Connect deployment is a user-owned, OAuth-protected inference gateway.
Its first useful backends are subscription-authenticated coding harnesses, but
the public contract does not depend on subscription billing or on any one
harness. Applications integrate once; the gateway packages the user's selected
runtime behind the supported Open Responses profile.

```text
application
  Open Responses requests, streams, functions, and function outputs
  OAuth authorization
        |
        v
user-owned Agent Connect gateway
  authorization and exact tool-snapshot consent
  response state, durability, recovery, and cancellation
  bundled harness backend
        |
        v
Codex / Claude Code / another user-controlled runtime
```

This is one public interaction protocol. AG-UI, ACP, MCP, WebMCP, Omnigent,
Codex app-server, and harness-specific events remain optional implementation
techniques behind or beside this boundary.

### Open Responses is the public wire, not the internal ontology

Use standard Open Responses shapes at the HTTP boundary and reuse selected
item and event types internally where they are the natural abstraction. Do not
create a parallel public task/event protocol that merely renames Responses.

Do not, however, pass an unrestricted public request object through every
internal module. The response engine accepts only the supported profile and
owns protocol semantics. A harness backend receives the smaller information it
needs to perform the work. Authorization policy, persistence, transport
options, and unsupported provider features must not leak into every adapter.

The gateway may retain a richer internal durable-run record for responsibilities
that are not supplied by an HTTP schema:

- ownership of a harness process or session;
- mapping a response chain to one logical application run;
- persistence of application calls before publication;
- stable call identifiers and idempotent result submission;
- unresolved-call redelivery and recovery;
- cancellation propagation; and
- authorization and revocation checks.

This internal state is not a second application protocol.

### Bounded version 0 profile

Version 0 supports only the portion required for the first real vertical slice:

- `POST /v1/responses` over HTTP;
- SSE streaming;
- text input and output;
- application-defined function tools;
- sequential application function calls;
- `previous_response_id` continuation;
- persisted response and unresolved-call state;
- cancellation through a clearly labeled Agent Connect control operation; and
- a stable, documented error taxonomy.

The Open Responses specification, pinned at commit `92c12d96` (OpenAPI 3.1.0,
`info.version` 2026-04-24), defines response creation and continuation but does
not define general HTTP retrieval, unresolved-call recovery, or cancellation
endpoints. The vertical slice must therefore document which behavior is
standard Open Responses and which narrowly scoped Agent Connect control
operations provide recovery and cancellation. Unsupported fields or
combinations fail explicitly rather than being silently ignored.

An earlier revision of this ADR cited an "Open Responses 2.3 specification".
No such version exists at the pinned revision; the citation has been corrected
to the commit and the document's own `info.version`.

Compatibility here is a **compatible façade with a documented constant
profile**. The specification standardizes the OpenAI Responses parameter
surface and makes sampling and service fields — `temperature`, `top_p`,
`presence_penalty`, `frequency_penalty`, `top_logprobs`, `service_tier` —
required and non-nullable on the returned resource. A harness-backed gateway
does not control any of them. Version 0 renders them as documented inert
constants rather than pretending they describe a decision the gateway makes.
The plan holds the exact table.

Version 0 does not claim support for:

- WebSocket transport;
- `store: false`;
- parallel application function calls;
- background mode;
- arbitrary provider model routing;
- provider-hosted tools;
- service tiers; or
- arbitrary extension payloads.

Compatibility means that an ordinary Open Responses client can use this
documented profile. It does not mean that Agent Connect implements every
optional feature exposed by every provider.

### `model` names an execution profile

For Agent Connect, the request `model` field identifies a logical execution
profile, not necessarily the single physical foundation model responsible for
every token or decision.

Version 0 exposes only:

```text
agent-connect/default
```

The gateway echoes this identifier in responses. The profile may use several
model calls, runtime-owned tools, or internal subagents, but it must preserve
its documented application-visible behavior. Internal implementation changes
must not turn the identifier into a meaningless routing alias.

Additional profiles such as `agent-connect/fast` or `agent-connect/deep` may
be introduced only when they represent useful, testable product promises. The
first version does not expose arbitrary backend configuration as model names.

### A logical run may span several Responses

One Open Responses `response.completed` event ends one response-generation
segment. It does not necessarily end the higher-level application run.

```text
response.create(input + approved tools)
  -> text and application function_call
application executes the call
response.create(previous_response_id + function_call_output)
  -> another call or final text
```

The SDK may offer a convenience `run()` operation that performs this standard
response chain. It remains active while approved application calls are
outstanding and completes when the chain has no unresolved application call.
The gateway's internal durable run binds the chain to one harness session or
equivalent continuity mechanism.

Internal model calls, runtime-tool activity, and subagent messages remain
private by default. If detailed tracing later becomes a concrete product need,
it may use an optional extension or edge adapter without changing the basic
Responses contract.

### Keep the response engine and bundled backends as deep modules

The shared response engine owns:

- validation of the supported profile;
- public response and event ordering;
- response IDs and continuation;
- durable unresolved application-call state;
- stable call IDs and duplicate-result behavior;
- recovery and redelivery;
- cancellation state; and
- stable public error mapping.

Each bundled harness backend owns everything needed to turn one harness into
that capability, including launch or attachment, credentials, workspace,
session continuity, runtime-owned tools, application-tool injection, health,
cancellation, and translation of harness behavior into the selected standard
items and events.

The response engine and backend remain source-level boundaries within one
deployable gateway. Splitting them into services would require another private
protocol and create a distributed failure mode without helping the MVP.

Do not design a broad common harness framework before two real backends expose
a stable shared seam. Codex is the first implementation. A later second
backend should teach us which backend interface is genuinely general.

### Preserve the two tool planes

The gateway and backend must distinguish:

1. **Runtime-owned tools** such as shell, filesystem, code editing, repository
   search, and harness-native capabilities. They execute within the user's
   runtime and are not application functions.
2. **Application-owned functions** supplied for the application interaction.
   Their calls cross the gateway and execute in the connected application.

A harness may perform many runtime-owned actions without exposing them to the
application. Only calls from the explicitly approved application-function
snapshot may be emitted for client execution.

### The approved application-function snapshot is fixed

The user authorizes an exact snapshot of application function definitions
together with the application identity, origin, scopes, redirect policy, and
expiry. The gateway binds the logical run and downstream harness session to
that approved snapshot.

The snapshot is immutable for the run or response chain. A changed function
name, description, or input schema produces a different snapshot and requires
the normal authorization/session transition. A function disappearing at
execution time fails explicitly; it is never silently replaced by another
function with the same name.

This decision intentionally favors a simple, auditable MVP over dynamic tool
mutation. Dynamic application tools are not a current product requirement.

### WebMCP is an optional source of candidate tools

WebMCP may later replace or augment the browser SDK's explicit tool-declaration
API. It is not part of the gateway protocol and does not weaken the fixed
snapshot rule.

If implemented, the browser SDK may use a small internal
`ApplicationToolSource` boundary:

```text
explicit declarations ---\
WebMCP page tools ---------+-> candidate definitions -> user-approved snapshot
deterministic test source -/
```

An adapter may discover WebMCP tools, map their schemas to Open Responses
function definitions, retain stable local implementation handles, and execute
approved calls in the page. Discovery occurs before authorization or before a
new logical run is established. Later `toolchange` events do not mutate an
active snapshot.

Explicit registration remains the version 0 implementation and fallback.
Agent Connect does not need WebMCP to prove the Open Responses architecture.

### Authorization remains an Agent Connect responsibility

Open Responses bearer authorization does not define user-owned gateway
enrollment, first-contact trust, gateway-owner authentication, application
consent, or exact application-function approval.

The OAuth audit should determine how much existing machinery can be expressed
using established standards such as Authorization Code with PKCE, OAuth
Protected Resource Metadata, Authorization Server Metadata, Resource
Indicators, and suitable authorization-details mechanisms. Established OAuth
libraries should implement protocol and cryptographic mechanics.

Regardless of the OAuth profile, Agent Connect policy continues to own:

- gateway identity and first-contact verification;
- gateway-owner authentication;
- application identity, origin, redirect, scope, and expiry policy;
- explicit approval of the exact application-function snapshot;
- revocation; and
- authorization checks when creating, continuing, recovering, or cancelling
  work.

Browser permission prompts or WebMCP invocation UX may add protection, but do
not replace the gateway's approved snapshot.

### Reachability remains orthogonal

Open Responses and OAuth do not make a private runtime reachable. Tailscale,
Codespaces forwarding, an existing tunnel, localhost, or another ingress
profile remains a separate deployment choice. Reachability must not silently
become runtime identity or application authorization.

## Responsibility map

| Concern                                                                         | Owner                                |
| ------------------------------------------------------------------------------- | ------------------------------------ |
| Public request, response, stream, function call, and function output vocabulary | bounded Open Responses profile       |
| Logical multi-response `run()` convenience                                      | application SDK                      |
| Supported-profile validation, ordering, response state, and errors              | response engine                      |
| Pending application-call durability, stable IDs, and recovery                   | response engine persistence boundary |
| Gateway identity, application consent, exact tool snapshot, and revocation      | Agent Connect authorization policy   |
| OAuth redirects, tokens, and standard metadata                                  | OAuth implementation/profile         |
| Harness launch, login, workspace, session, health, and cancellation             | bundled harness backend              |
| Harness translation and application-tool injection                              | bundled harness backend              |
| Model loop, internal subagents, context, and runtime-owned tools                | selected harness/runtime             |
| Optional page-tool discovery and local execution                                | browser SDK, possibly using WebMCP   |
| Network reachability                                                            | deployment/ingress profile           |

## Migration and deletion point

1. Keep the proven Omnigent path as the behavioral baseline.
2. Build one narrow Open Responses-to-Codex vertical slice.
3. Preserve exact tool authorization and the unresolved-call durability work.
4. Compare the slice with the existing multi-call application behavior.
5. After the compatibility, authorization, and durability gates pass, remove
   the custom browser task/event protocol and browser-visible Omnigent path.

Do not preserve two public protocols indefinitely. AG-UI remains an optional
future edge adapter only if a concrete application needs its additional UI
semantics. ACP, MCP, native dynamic tools, a generated MCP server, or Omnigent
may be used behind a backend; none is required by applications.

## Validation gates before acceptance

This ADR remains proposed until a time-boxed vertical slice demonstrates:

Gate status as of 2026-08-28, after the deterministic and real-Omnigent slice:
gates 3, 4, 5, 6, 8, 9, and 10 are met and covered by
[VAL-RESP-001](../../contract/VAL-RESP-001.md),
[VAL-RESP-002](../../contract/VAL-RESP-002.md),
[VAL-RESP-005](../../contract/VAL-RESP-005.md),
[VAL-RESP-006](../../contract/VAL-RESP-006.md), and
[VAL-RESP-007](../../contract/VAL-RESP-007.md). Gate 7 is met for gateway
restart and for the `interrupted` outcome, but cancellation is proven only
against a deterministic backend. Gate 1 is met against a deterministic
backend: the real `openai` 7.8.0 client completes two sequential calls, final
text, and streaming with no Agent Connect-specific field
([VAL-RESP-003](../../contract/VAL-RESP-003.md)). Gate 2 is the outstanding one: multiple sequential calls are proven end to end against
real Omnigent, but not yet against a real browser and a
subscription-authenticated Codex run. Gates 11, 12, and 13 wait on that.

1. An ordinary Open Responses client can use the documented profile without
   Agent Connect-specific response payloads. This gate depends on the
   non-browser ingress profile decided in
   [ADR 0009](0009-separate-ingress-owner-authentication-and-application-authorization.md);
   an ordinary server-side client sends no `Origin` header and is otherwise
   rejected before routing.
2. A live Codex execution can make multiple sequential application function
   calls, receive their outputs through response continuation, and return final
   text without losing harness continuity. This must be proven through the
   actual browser application, gateway authorization/session path, Omnigent,
   and the operator's subscription-authenticated Codex runtime—not only a
   deterministic backend or direct API client.
3. The only public model profile is stable and honestly documented.
4. Application functions require no permanently preinstalled
   application-specific MCP server.
5. Every application call is persisted before it is published.
6. Stable call IDs survive reconnect, redelivery, and duplicate result
   submission without claiming generic exactly-once execution.
7. Cancellation propagates through response, durable run, and harness layers,
   and a gateway restart resolves every chain to one of the four declared
   recovery outcomes. Loss of the harness process is a declared `interrupted`
   terminal state, not a recoverable one: the parked application call is an
   in-process awaiter inside Omnigent and does not survive it.
8. Runtime-owned and application-owned tool paths remain distinct.
9. A run can invoke only the exact function snapshot the user approved.
10. Unsupported Open Responses features fail explicitly.
11. The OAuth audit identifies which existing enrollment and grant mechanisms
    are kept, replaced, or narrowed.
12. The resulting public surface is materially smaller than the current custom
    task/event API plus the proposed AG-UI adapter.
13. The Omnigent baseline remains available until replacement evidence is
    sufficient, then the superseded public path is deleted.

WebMCP compatibility is deliberately not an acceptance gate.

## Consequences

- Agent Connect stops inventing a public protocol while keeping the internal
  state needed to make remote application calls durable.
- Applications remain independent of Codex, Claude Code, Omnigent, ACP, MCP,
  and the backend's model or subagent topology.
- The initial implementation and testing surface becomes deliberately small.
- Exact tool-snapshot consent remains stricter and less dynamic than generic
  model APIs, matching the current personal-gateway threat model.
- A second backend and compelling real applications, rather than speculative
  abstractions, will drive later generalization.
- Open Responses conformance tests plus Agent Connect authorization and
  recovery tests are more authoritative than a large internal adapter
  hierarchy.

## Non-goals

- defining a new agent protocol;
- claiming full Open Responses compatibility;
- standardizing every coding-harness lifecycle;
- supporting dynamic mutation of an approved tool snapshot;
- requiring WebMCP, AG-UI, ACP, MCP, or Omnigent in applications;
- surfacing internal subagents or execution graphs;
- implementing arbitrary model routing or multi-agent orchestration;
- reimplementing the model/tool loop already owned by a harness;
- splitting facade and supervisor into separately deployed services;
- claiming generic exactly-once execution;
- solving general public reachability, multi-tenancy, or billing; or
- designing speculative end-user features before the scaffold works.

## Relationship to earlier decisions

This proposal does not invalidate the behavior proven by ADR 0002 or the
current Omnigent reference deployment. If accepted after its gates pass, it
supersedes ADR 0006's AG-UI exploration as the leading application-facing
direction and narrows ADR 0001 to optional downstream ACP use. It also
triggers a focused review of ADRs 0004, 0007, and 0009 to distinguish reusable
OAuth machinery from Agent Connect-specific authorization policy.

The design review at
[An Ousterhout review of the Open Responses gateway pivot](../reviews/2026-08-26-ousterhout-open-responses-design-review.md)
remains supporting analysis rather than a competing source of truth.
