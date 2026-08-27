# An Ousterhout review of the Open Responses gateway pivot

- Review date: 2026-08-26
- Primary target: [ADR 0010](../decisions/0010-open-responses-gateway-pivot.md)
- Design lens: John Ousterhout, _A Philosophy of Software Design_, second
  edition
- Repository state reviewed: the proposed pivot plus the current Omnigent
  gateway, web SDK, authorization, mission, target architecture, scope
  inventory, and ADRs 0002, 0006, 0007, 0008, and 0009

## Resolution status

Resolved into the 2026-08-27 revision of
[ADR 0010](../decisions/0010-open-responses-gateway-pivot.md). The ADR now
defines a bounded version 0 profile, limits the propagation of public request
types, gives the response engine ownership of the durable unresolved-call
ledger, distinguishes source boundaries from deployment boundaries, and keeps
an exact user-approved application-function snapshot. Its vertical-slice gates
remain open, so the architecture is still proposed rather than accepted.

This review remains a dated analysis record. ADR 0010 is the source of truth
for the current decision.

## Executive verdict

The pivot is strategically correct, but ADR 0010 should be revised before it
is accepted.

Adopting Open Responses at the application boundary removes a real and costly
duplication. The current code receives events whose names are already close to
Responses (`response.output_text.delta`, `response.output_item.done`,
`response.completed`), translates them to `AgentProviderEvent`, then translates
those again to `AgentTaskEvent`. The gateway separately proxies Omnigent's
stream and event routes. This produces change amplification, forces developers
to learn several nearly equivalent vocabularies, and creates uncertainty about
which layer owns completion, cancellation, tool correlation, and recovery.
Replacing that public task/event ontology with a supported Open Responses
profile is an unusually direct reduction in all three symptoms of complexity
from Chapter 2: change amplification, cognitive load, and unknown unknowns.

However, two claims in ADR 0010 are too broad:

1. **“Use Open Responses types directly” is safe at the public boundary, but
   not automatically at every internal boundary.** Passing a complete external
   request object through the gateway core, backend, supervisor, and harness
   adapter would leak decisions belonging to transport, authorization,
   persistence, and protocol evolution. It would replace a duplicated ontology
   with a duplicated dependency.
2. **“Bundle translation and supervision” is a sound deployment decision, not
   a sufficient module design.** Translation and process supervision share
   harness knowledge and should ship together, but source code should still
   concentrate distinct secrets: Open Responses state and durability in one
   deep module; harness launch/session/tool-injection knowledge in a bundled
   backend; application grant policy in another. “One process” must not become
   “one class” or one route handler.

The best formulation is:

> Agent Connect is a user-owned, OAuth-protected implementation of a deliberately
> bounded Open Responses profile. Its shared response engine owns protocol and
> durability semantics. Each bundled harness backend owns the complete means of
> turning one harness into that semantic capability, including supervision and
> translation. Internal seams reuse selected Open Responses item types where
> they are the natural abstraction, but do not pass unrelated public options or
> invent a second response ontology.

This is narrower than the present architecture and deeper than a transparent
proxy. It preserves the product's differentiated work: trusted first contact,
application-specific consent, durable client-function delivery, and packaging
coding harnesses as user-owned services.

## The design reconstructed

The proposal can be reconstructed as four responsibilities in one deployable
gateway:

```text
browser application
  standard Open Responses client or a high-level Agent Connect run helper
  application-owned function implementations
              |
              | Open Responses HTTP/SSE or WebSocket
              | OAuth bearer authorization
              v
+------------------------------------------------------------------+
| user-owned Agent Connect gateway                                 |
|                                                                  |
|  authorization edge                                             |
|    OAuth protocol mechanics + Agent Connect consent policy       |
|                         |                                        |
|  response engine                                                 |
|    supported profile, IDs, continuation, ordering, persistence,  |
|    unresolved client-function ledger, recovery, cancellation     |
|                         |                                        |
|  bundled harness backend                                         |
|    harness event translation + launch/session/workspace/tool     |
|    injection/health/restart mechanics                             |
+-------------------------|----------------------------------------+
                          v
               Codex / Claude Code / another harness
                  model loop and runtime-owned tools
```

“Bundled” means that the response facade and selected backend are installed and
operated together. It avoids introducing a private network protocol and a new
distributed failure boundary. It does not imply that their knowledge should be
intermixed.

The design also preserves two different tool planes:

- runtime-owned tools execute inside the harness environment;
- application-owned functions are authorized as a fixed snapshot, emitted to
  the browser, executed there, and correlated back to the same logical work.

That distinction is more fundamental than whether Codex receives application
functions through dynamic tools, a generated MCP server, ACP, or another
mechanism. Those are backend secrets.

## How the Ousterhout lens is being applied

Ousterhout defines complexity in terms of what makes a system hard to
understand or modify. In Chapter 2 he identifies dependencies and obscurity as
causes, and change amplification, cognitive load, and unknown unknowns as
symptoms. His modular design test in Chapters 4 and 5 is not “how many packages
exist?” but how much complexity is hidden behind each interface and which
design decisions leak across modules. Chapter 7 adds that adjacent layers
should offer different abstractions; layers that merely repeat one another are
a warning sign. Chapter 8 argues for pulling complexity downward into modules
so their many callers do not each bear it.

This review distinguishes those claims from project-specific inferences. For
example, the book does not say to adopt Open Responses, OAuth, or a modular
monolith. The inference here is that these choices are good only insofar as
they reduce the complexity experienced by application authors, backend
authors, and maintainers. Ousterhout's official course material summarizes the
same core ideas as minimizing dependencies, making behavior obvious, using
deep modules, avoiding temporal decomposition, pulling complexity downward,
and designing strategically. The second edition notably strengthens Chapter
6's argument that somewhat general-purpose modules often hide more information
([Ousterhout's book page](https://web.stanford.edu/~ouster/cgi-bin/book.php),
[course review topics](https://web.stanford.edu/~ouster/cgi-bin/cs190-winter21/lecture.php?topic=bookReview)).

## Complexity inventory

| Design area         | Present symptom                                                                                                                                                | Cause                                                        | Effect of ADR 0010                                            | Residual risk                                                                                           |
| ------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------ | ------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| Browser task stream | Changes cross Omnigent event mapping, provider events, task events, SDK accumulation, and tests                                                                | Three overlapping semantic vocabularies                      | Large reduction if the standard profile becomes authoritative | A high-level `run()` can recreate a shadow task protocol                                                |
| Tool calls          | `requestToken`, `actionId`, Omnigent `call_id`, tool hash, and browser context all represent related identity                                                  | Correlation knowledge is spread across layers                | Standard call items provide a common vocabulary               | Durable delivery and idempotency are not supplied by naming alone                                       |
| Completion          | Provider completion, response completion, and logical run completion differ                                                                                    | One term is used at different semantic levels                | Response chains make the distinction expressible              | SDK and gateway may disagree about when a run has ended                                                 |
| Harness lifecycle   | Session creation, workspace policy, host selection, health repair, and event translation are split across `gateway.ts`, `OmnigentRuntime`, and browser code    | Omnigent was both runtime and browser-facing transport       | Bundled backends can concentrate harness knowledge            | A generic lifecycle framework may expose every backend quirk                                            |
| Gateway routes      | One large request handler knows CORS, transport principal, owner pages, OAuth-like endpoints, grants, session provisioning, capabilities, proxying, and errors | Temporal decomposition around HTTP request order             | Pivot creates a chance to form deeper domain modules          | Adding `/v1/responses` to the same handler merely adds another branch                                   |
| Authorization       | Runtime identity, owner authentication, app consent, grants, session capability, Origin, tools, and transport evidence interact                                | Genuine security distinctions plus custom protocol mechanics | OAuth can remove commodity mechanics                          | “OAuth support” can become a shallow wrapper around dozens of parameters                                |
| Recovery            | Provider mapping and unresolved calls are memory-only                                                                                                          | Persistence invariants are not encapsulated                  | ADR correctly keeps recovery in the core                      | Conformance tests may obscure that Open Responses does not implement Agent Connect's delivery guarantee |
| Configuration       | Transport, runtime, sandbox, identity, origin, public-demo, TTL, and host details are environment-level knobs                                                  | Operational choices leak to startup configuration            | Profiles could hide common configurations                     | Backend proliferation can multiply parameters and invalid combinations                                  |
| Standards portfolio | ACP, AG-UI, MCP, Omnigent, custom task events, and Open Responses overlap                                                                                      | Each exploration left terminology and paths behind           | One public interaction standard sharply reduces load          | Optional integrations can remain mentally “active” unless explicitly demoted                            |

The largest current unknown unknown is not the event schema. It is where the
transaction boundary lies when a harness asks the application to mutate
something and the browser disconnects. ADR 0010 recognizes this, but it should
make that boundary the organizing center of the response engine rather than
one validation bullet near the end.

## Module-by-module critique

### 1. The public Open Responses profile

#### What is strong

This is the deepest proposed module. A standard client gets prompting,
streaming, function calls, results, continuation, cancellation, and terminal
states through an interface it may already understand. The implementation may
hide a coding harness, process supervisor, MCP relay, workspace policy,
provider session, recovery ledger, and multiple underlying model turns. That
is a high functionality-to-interface-complexity ratio, the test for a deep
module in Chapter 4.

It is also appropriately general-purpose in the Chapter 6 sense. The public
model describes inputs, outputs, and functions rather than “start Codex through
Omnigent.” The same common operations plausibly cover Codex, Claude Code, a
plain model loop, and future harnesses without pre-designing their process
lifecycle.

The pivot also follows Chapter 21's “decide what matters” principle. For an
application author, what matters is submitting work and servicing authorized
function calls. ACP session mechanics, MCP server installation, and Omnigent
host selection do not.

#### What must change

“Open Responses-compatible” is too unbounded as an interface promise. Large
standards contain optional inputs and behavior that a coding harness cannot
necessarily honor: provider selection, storage behavior, parallel tools,
background execution, truncation, reasoning controls, response retrieval,
transport variants, extension objects, and future fields. If every field is
accepted and passed downward, callers must understand backend-dependent
behavior and backend authors must understand the entire standard. This is
**overexposure**, a red flag associated with shallow interfaces.

Define a versioned **Agent Connect Open Responses profile** that says:

- which endpoint and protocol version are supported;
- the accepted input items and function-tool shape;
- whether calls may be parallel;
- continuation and storage semantics;
- cancellation and disconnect behavior;
- the precise meaning of each terminal status;
- which standard fields are rejected, ignored, or forwarded;
- extension and capability discovery rules.

This is not a fork if standard objects remain unchanged. It is the normal act
of making an implementation's contract obvious. Unsupported fields should fail
early with stable standard errors rather than appear to work differently by
backend.

Do not expose a `provider: "codex"`, MCP configuration, workspace path,
Omnigent session, or harness approval mode in this profile. Each would leak a
backend design decision through the deepest public abstraction.

### 2. The web SDK and `run()` convenience

The SDK can become a deep module if `run()` absorbs the ugly common case:

- initiate and stream a response;
- recognize calls to the fixed application-function snapshot;
- validate arguments;
- execute handlers;
- submit correlated outputs;
- continue the chain;
- deduplicate redelivery by stable call identity;
- surface progress and one final result;
- apply cancellation consistently.

The present `AgentSession` already does much of this, but it is built over two
custom event vocabularies. Rebuilding the same class with renamed Open
Responses events would be a tactical migration, not a strategic redesign.

The interface should make the common operation close to:

```ts
const result = await target.run({ input, functions, signal });
```

and offer a lower-level standard Responses client for callers that need raw
items. The high-level API must not require the caller to pass
`previous_response_id`, loop over function calls, choose between SSE and
WebSocket, or understand gateway recovery markers. Chapter 8's advice is to
pull that complexity downward, even if the SDK implementation becomes harder.

There is one crucial semantic decision to document: a standard response can
complete while the SDK-level logical run continues through function output and
a successor response. `run()` must therefore be described as an operation over
a response chain, not as an alias for `responses.create`. Otherwise it becomes
a layer with the same name but a subtly different abstraction—the dangerous
kind of interface duplication discussed in Chapter 7.

Avoid a second public tree of `AgentTaskEvent` wrappers. If convenience events
are necessary, make them a deliberately higher abstraction such as progress,
application action requiring user confirmation, and final outcome. Do not
rename every Open Responses delta one for one.

### 3. The shared response engine

ADR 0010 currently lists “HTTP/SSE/WebSocket correctness and response state”
as shared-core work. That description risks temporal decomposition: one module
parses, another authorizes, another maps a session, another stores, another
streams, because those steps happen in that order. Chapter 5's objection to
temporal decomposition is that code is grouped by execution time rather than
by the knowledge it hides.

The response engine should instead hide the design decisions that must stay
consistent:

- supported-profile validation;
- allocation and meaning of response, item, and call identifiers;
- response-chain-to-harness-conversation binding;
- event ordering and replay cursor rules;
- atomic persistence before publication of an application function call;
- redelivery and acknowledgement transitions;
- terminal state transitions;
- cancellation races and restart recovery.

These are one body of knowledge: the externally observable lifecycle of a
response. Put them behind operations that preserve invariants rather than
exposing storage steps:

```ts
responses.create(authorizedRequest);
responses.continue(authorizedFunctionOutputs);
responses.cancel(responseId);
responses.stream(responseId, cursor);
```

The exact code need not use these method names. The design test is that a route
handler cannot notify the client before persistence because there is no public
sequence of `saveCall()` followed by `publishCall()` to misuse. A deeper action
ledger operation should perform both under one invariant. This applies the
Chapter 10 strategy of defining invalid states or error cases out of existence,
rather than relying on every caller to remember the order.

The core should own public response IDs. A backend should return an opaque
conversation binding, not a provider ID that routes and authorization code can
interpret. The repository already states this principle, but the current
in-memory maps and proxy routes still make provider health and application
session behavior adjacent. The pivot is the opportunity to enforce it in the
module interface.

### 4. Bundled harness backends

ADR 0010 is right not to split the facade and supervisor into separately
deployed services. Such a split would add a network contract, authentication,
serialization, version skew, retry behavior, and partial failure without
removing the underlying dependency. This would increase complexity for an
organizationally neat diagram.

It is also right to place translation and supervision in the same backend
package. Codex launch configuration, session identity, dynamic tool injection,
approval behavior, event interpretation, health checks, and restart behavior
share harness-specific information. Chapter 9, “Better Together Or Better
Apart?”, argues for bringing code together when it shares information or
serves one closely related task. In the current implementation, knowledge of
the Omnigent session protocol appears in the gateway proxy, the browser
`OmnigentProvider`, the runtime launcher, tool-envelope validation, and a pinned
ACP compatibility path. A bundled backend can reduce that leakage.

But “bundled” should not justify a backend that receives the entire HTTP
request and writes directly to the client stream. That would make it a shallow
pass-through layer and give every backend responsibility for authorization,
protocol storage, CORS, transport termination, and recovery.

The backend should hide the complete answer to:

> How does this installed harness provide a conversation that accepts supported
> input items and application-function definitions, emits supported output
> items, accepts correlated function outputs, and can be cancelled?

It should also hide:

- executable discovery and launch arguments;
- login and credential expectations;
- workspaces and runtime policy manifests;
- native session identifiers;
- MCP, ACP, app-server, SDK, or stdio transport selection;
- health determination and safe replacement;
- harness-specific event noise and approval mechanics.

Those details may be internally split into supervisor and translator
components if doing so hides distinct bodies of information. They should not
be separate merely because “launch happens before translate.”

### 5. Whether to define a common harness interface

The ADR's refusal to design a large universal harness framework before two real
backends exist is good strategic restraint. Current evidence establishes one
Omnigent/Codex composition and a possible direct Codex path; it does not
establish that Claude Code shares launch, resume, approval, or tool-injection
semantics. A lifecycle interface with `start`, `attach`, `resume`, `health`,
`restart`, `injectTools`, and `close` would likely be a shallow inventory of
implementation details. Every backend would implement many operations
differently or throw “unsupported.”

However, **no source-level seam at all** would be equally tactical. It would
entangle standard protocol state with Codex process management and make the
second backend a rewrite of the gateway.

The compromise should be a small capability interface driven by what the
response engine needs, not by a union of anticipated harness features. A
candidate, to be designed twice before implementation, is:

```ts
interface HarnessBackend {
  acquire(binding: ConversationBinding): Promise<HarnessConversation>;
}

interface HarnessConversation {
  respond(
    input: readonly SupportedInputItem[],
    functions: readonly SupportedFunctionTool[],
    output: ResponseOutput,
    signal: AbortSignal,
  ): Promise<HarnessTurnOutcome>;
}

interface ResponseOutput {
  append(item: SupportedOutputItem): Promise<void>;
  appendDelta(event: SupportedSemanticDelta): Promise<void>;
}
```

This sketch is intentionally not an accepted API. Its important properties
are:

- it uses selected standard semantic types where those are genuinely shared;
- it does not expose HTTP, OAuth claims, Origin, SSE frames, public response
  IDs, persistence transactions, workspace paths, or provider session IDs;
- the response engine, not the backend, controls durable publication;
- the backend can implement `respond` with Omnigent, Codex app-server, ACP, or
  another mechanism;
- harness-specific state hangs from an opaque conversation binding.

`SupportedInputItem` should preferably be a type selection or validation view
over the Open Responses schema, not a renamed independent ontology. Yet passing
the complete `CreateResponseRequest` would be worse: most of it has no meaning
to process supervision, and its future evolution would amplify changes into
every backend.

Ousterhout's Chapter 11 advice to “design it twice” is particularly applicable.
Sketch at least two credible interfaces and exercise both against (a) the
current Omnigent path and (b) a thin direct-Codex or deterministic fake backend.
This is cheaper and more informative than either designing a grand framework or
waiting until a production Claude backend exists.

### 6. Authorization protocol and consent policy

The proposed OAuth audit is directionally sound because it can turn commodity
protocol complexity into a deep imported module. PKCE, token endpoint rules,
authorization-server metadata, protected-resource metadata, resource
indicators, redirect validation, and standard error responses should be
implemented by mature libraries wherever possible.

Yet adopting standards does not necessarily hide complexity. If gateway code
must coordinate six OAuth specifications, browser Origin policy, a runtime
card, gateway-key proof, Tailscale identity, owner authentication, client
metadata, tool hashes, grants, session capabilities, and DPoP, the application
may see a standard wire while maintainers inherit a shallow “OAuth” facade.

The current `ConnectorAuth` is evidence of both genuine domain knowledge and
over-concentration. It owns gateway keys, enrollment secrets, device state,
pending authorization, codes, grants, signing secrets, persistence, and
validation. ADR 0009 correctly distinguishes gateway authentication, gateway-
owner authentication, application authorization, and session authorization.
That separation is valuable only if callers ask semantic questions instead of
passing every piece of evidence through every layer.

Recommended division:

1. **OAuth protocol adapter:** standards-compliant parsing, PKCE, metadata,
   token issuance format, and protocol errors. Prefer a library.
2. **Owner authenticator:** returns an owner principal based on a selected
   deployment profile. It hides whether evidence came from Tailscale, an
   enrolled browser, OIDC, or a passkey.
3. **Application grant policy:** decides and records whether a specific
   application identity has prompt/result authority and an exact canonical
   function snapshot. It owns consent, expiry, incremental authority, and
   revocation.
4. **Gateway identity:** proves continuity with the runtime card independently
   of bearer authorization.

The OAuth adapter should call the grant policy; the grant policy should not
know PKCE challenge syntax or HTTP parameter names. Route handlers should ask
for an `AuthorizedApplication` rather than receive and forward Origin, app ID,
tool hash, scopes, grant ID, and token claims separately. Those are classic
pass-through variables from Chapter 7: once repeated across many signatures,
they create dependencies and make it unclear which layer actually validates
them.

Rich Authorization Requests may encode application-function consent on the
wire, but the grant policy—not the OAuth extension object—must remain the source
of truth. Otherwise an active draft or profile revision will leak into storage,
runtime manifests, SDK types, and consent UI.

Do not expose numerous choices to operators simply because OAuth supports
them. Chapter 8 uses configuration parameters as an example of pushing
complexity upward: asking a user to select token TTLs, metadata modes, client
registration strategies, sender binding, and owner authenticators makes the
least-informed person choose. Provide a few validated deployment profiles with
secure defaults. Keep individual knobs for expert overrides, not the normal
installation path.

### 7. The unresolved application-call ledger

This should become one of the deepest Agent Connect modules, not an appendix to
Open Responses conformance.

The product requires that an application function request be persisted before
the application is notified, that redelivery preserve a stable action identity,
and that Agent Connect not claim exactly-once execution. These facts must be
known together. If persistence is placed in the response store, delivery in
the SSE layer, acknowledgement in the SDK, and deduplication in an application
helper, the same state-machine knowledge leaks into four modules.

Model the ledger around durable state transitions and operations that make
illegal orderings unavailable. For example:

```text
requested -> durably pending -> delivered -> result recorded -> acknowledged
```

The exact states require an implementation experiment; notably, “application
side effect happened” cannot be inferred from network acknowledgement. The
module should preserve a stable Open Responses `call_id` or a documented
stable identifier mapped to it, and should return the recorded result on
duplicate submission. Application-owned idempotency remains necessary.

This is an application of Chapter 10's “define errors out of existence” and
Chapter 8's “pull complexity downward”: make the ledger perform a safe retry or
return existing state rather than making each transport path catch a duplicate
and guess.

### 8. Reachability and deployment profiles

Keeping reachability orthogonal is correct information hiding. Tailscale Serve,
Codespaces forwarding, localhost, and a future tunnel answer how bytes arrive;
OAuth grants answer what an application may do; the runtime card answers which
gateway the user selected. Collapsing these into “the URL is trusted” would
leak transport assumptions into identity and authorization.

Still, a deployment profile should be deep. A user choosing
`tailscale-personal` should not also configure a host binding, trusted proxy
header names, Funnel prohibition, dynamic-Origin behavior, owner-auth strategy,
and public endpoint independently. The profile should validate prerequisites
and choose a coherent set. The existing environment surface illustrates the
configuration multiplication to avoid.

### 9. Errors, comments, and obviousness

Open Responses standard errors should be used where they describe public
request failures. They should not erase domain distinctions needed for safe
recovery. At minimum, the system must distinguish:

- unsupported standard feature;
- invalid or unauthorized application function;
- lost/replaced harness conversation;
- retryable backend unavailability;
- response-chain conflict;
- duplicate or stale function output;
- terminal harness failure;
- owner or grant revocation during an open stream.

Do not turn every backend exception into `502 upstream_unavailable`, as the
current gateway does for its catch-all path. That makes the API superficially
small but behavior obscure. Conversely, do not expose raw Omnigent, Node,
Codex, or OAuth-library errors. Define a small stable taxonomy and handle
recoverable conditions within the owning module. Ousterhout's Chapter 10 does
not argue for hiding all errors; it argues for reducing the number callers
must handle by designing normal behavior to absorb conditions safely.

Comments should record the non-obvious contracts: why a request is durable
before publication, which entity owns each ID, why one response completion may
not end `run()`, why app function results cannot satisfy harness approvals, and
which OAuth claims were already validated. They should not narrate standard
field names or route steps. This follows Chapters 12 through 15: interface
comments should state information callers cannot infer from code, and writing
those comments before implementation is a design test. If the backend contract
cannot be documented simply without enumerating Codex and Omnigent mechanics,
it is not yet deep enough.

## Where “use Open Responses everywhere” helps—and where it does not

### It genuinely removes complexity when

- applications, the SDK's low-level client, wire validation, stored response
  items, and conformance tests share the standard meaning of inputs, function
  calls, outputs, stream events, and terminal states;
- a harness adapter can emit a standard output item directly without an
  intermediate one-for-one renamed event;
- the response engine can store and replay standard semantic events without
  translating them again;
- new standard clients interoperate without an Agent Connect-specific task
  schema;
- optional AG-UI and ACP integrations remain edge or backend adapters rather
  than alternate core ontologies.

### It merely relocates or hides complexity badly when

- the complete public request is passed through modules that only need three
  fields;
- backend-dependent behavior is disguised as universal standard behavior;
- Open Responses IDs are assumed to provide durable application-side-effect
  semantics automatically;
- a `run()` API repeats every standard event under new names;
- extensions become a dumping ground for workspace, MCP, approval, or
  supervisor controls;
- conformance tests substitute for security, authorization, crash recovery,
  and real-harness composition tests;
- standard types make developers overlook the semantic mismatch between a
  stateless model response and a long-lived coding-harness conversation.

The standard should be a strong boundary, not a solvent poured through every
module.

## Strongest arguments for the proposal

1. **It removes an accidental product surface.** Maintaining a custom event
   protocol was never the value proposition.
2. **It makes the application boundary deep.** A simple standard API hides a
   substantial user-owned runtime and client-function loop.
3. **It isolates volatile harness mechanisms.** Dynamic MCP, ACP, app-server,
   and Omnigent can change behind backend packages.
4. **It reduces ecosystem burden.** Standard clients, schemas, and conformance
   tools replace bespoke SDK-only integration.
5. **It aligns decomposition with information.** Response semantics,
   application authorization, and harness mechanics are genuinely different
   bodies of knowledge.
6. **It supports strategic deletion.** The pivot can remove browser Omnigent
   types, custom provider/task event duplication, and an unnecessary AG-UI core
   path instead of adding another adapter beside them.
7. **It preserves implementation freedom.** One backend may use Omnigent and
   MCP while another directly drives Codex, without changing the application.

## Strongest arguments against the proposal

1. **Open Responses may model model-provider turns better than durable coding-
   harness tasks.** Continuation, storage, cancellation, background execution,
   and tool-result injection must be proven rather than inferred from similar
   names.
2. **A broad compatibility claim can create more obligations than the current
   tiny protocol.** Supporting a carefully bounded profile is essential.
3. **The standard is an external dependency and will evolve.** Using its full
   types in storage and every internal signature can amplify upstream changes.
4. **Translation remains intrinsically semantic.** A harness may emit plans,
   approvals, file changes, command progress, and partial failures with no exact
   standard equivalent. Hiding these may lose useful behavior; exposing them
   as extensions may leak the backend.
5. **OAuth can become its own architecture project.** Combining many standards
   without a deep library and narrow policy boundary may increase cognitive
   load beyond the custom profile.
6. **Bundling can conceal a monolith.** Avoiding a network boundary does not
   establish good source-code information hiding.
7. **A standards pivot can become tactical churn.** Renaming types without
   deleting paths, clarifying invariants, and simplifying common operations
   produces migration cost without lasting depth.

These objections justify ADR 0010's validation gates; they do not justify
retaining the custom public protocol by default.

## Recommended boundaries and interfaces

### Public boundary

- Publish one explicit, versioned Open Responses support profile.
- Preserve standard JSON objects and event names within that profile.
- Reject unsupported features predictably.
- Keep backend and deployment controls out of standard request extensions by
  default.
- Offer raw standard access and one genuinely higher-level `run()` helper.

### Response engine

- Own response IDs, chain mapping, semantic event ordering, storage, replay,
  cancellation, and the pending-call ledger.
- Accept an already-authorized application context rather than raw OAuth and
  Origin inputs.
- Publish events only through an operation that has satisfied durability
  invariants.
- Store a declared protocol version and isolate schema-version migration.

### Harness backend

- Ship translation and supervision together.
- Hide all native process, credential, workspace, session, MCP/ACP, approval,
  and health knowledge.
- Consume only the selected standard semantic data it can act upon.
- Emit through a response-engine-controlled sink; never write HTTP/SSE
  directly.
- Return stable categories of outcomes while retaining detailed backend errors
  in internal diagnostics.
- Start with Codex/Omnigent, but exercise the seam with a second implementation
  before freezing it.

### Authorization

- Let mature libraries own OAuth mechanics and cryptography.
- Keep gateway identity, owner authentication, and application grant policy
  distinct.
- Encapsulate Origin, app identity, grant, and tool-snapshot validation into an
  `AuthorizedApplication` capability used by the response engine.
- Keep the canonical tool snapshot and consent record independent of the
  chosen OAuth extension encoding.
- Provide named deployment profiles rather than a matrix of normal-use knobs.

### Application function contract

- Use standard function definitions and call/output items on the wire.
- Keep one stable identity across persistence, redelivery, result submission,
  and SDK deduplication.
- Never conflate an application-function output with a harness/native approval.
- Make duplicate result submission safe and explicit.
- Preserve the requirement for application idempotency where the side effect
  cannot be observed by the gateway.

## Migration red flags

Treat each of the following as a stop-and-redesign signal:

- **Shadow ontology:** new `AgentResponseEvent` types mirror standard events
  field for field.
- **Pass-through backend:** the harness backend receives `IncomingMessage`,
  OAuth claims, or an entire unvalidated `CreateResponseRequest` and writes to
  `ServerResponse`.
- **Generic lifecycle inventory:** an interface contains every imaginable
  start/resume/attach/restart/tool-install operation, with backend-specific
  unsupported cases.
- **Extension dumping ground:** namespaced Open Responses fields carry MCP
  configuration, host paths, Omnigent IDs, or approval modes.
- **Temporal modules:** separate “parse,” “store,” “notify,” and “ack” services
  expose an ordering that callers must assemble correctly.
- **Configuration explosion:** every backend adds environment variables to the
  shared gateway instead of owning a validated profile.
- **False completion equivalence:** `response.completed`, harness-turn complete,
  no unresolved function call, and SDK `run()` complete are treated as the same
  state without proof.
- **Catch-all errors:** all backend and recovery failures become 502, or raw
  provider exceptions cross the public boundary.
- **Conformance theater:** schema acceptance passes while multi-call behavior,
  interruption, revocation, and persistence remain untested.
- **Permanent dual path:** Open Responses is added while the custom task/event
  API, AG-UI core experiment, and browser Omnigent provider all remain normal
  supported surfaces.
- **Premature package proliferation:** many tiny “manager,” “service,” and
  “adapter” classes forward the same objects without hiding information.
- **Protocol-driven storage:** database records reproduce the entire current
  Open Responses document rather than preserving the smaller durable facts and
  version needed for recovery.

## Prioritized revisions to ADR 0010

### Priority 1: define the supported public profile

Replace the broad compatibility statement with a commitment to produce a
versioned support matrix before acceptance. Add explicit gates for optional
fields, parallel calls, storage, cancellation, response retrieval, SSE replay,
WebSocket behavior, and extension policy.

### Priority 2: narrow “use types directly”

State that standard types are authoritative at the application boundary and
may be reused for internal semantic items. Explicitly prohibit passing the
complete public request through unrelated modules and prohibit a one-for-one
renamed internal ontology. Allow small internal capability types when they
hide authorization, persistence, or backend details rather than duplicating
the standard.

### Priority 3: make durability an architectural boundary

Elevate the unresolved application-call ledger from a validation gate into the
response engine's core responsibility. Record its atomic publish rule, stable
identity, redelivery contract, duplicate-result behavior, and limits of
side-effect knowledge.

### Priority 4: clarify bundled deployment versus information hiding

Add that facade and backend are one deployment but separate source modules.
The response engine owns public protocol state; the backend owns all harness
supervision and translation; neither receives the other's raw transport or
native session details.

### Priority 5: require “design it twice” for the backend seam

Do not require a large framework or a production second harness. Require two
documented interface sketches and exercise the chosen seam against the current
Omnigent/Codex path plus a direct Codex spike or deterministic backend. Freeze
the seam only after observing both.

### Priority 6: constrain the OAuth audit

Make its goal a deep standards adapter plus a small Agent Connect grant-policy
module, not maximal OAuth feature coverage. Require a keep/replace map for
runtime-card identity, owner authentication, client identity, consent, grants,
session capabilities, and revocation. Add a configuration-budget test: common
deployment should select a validated profile rather than tune protocol pieces.

### Priority 7: define the migration deletion point

Name the old public types, routes, and exports expected to disappear after the
vertical slice. A pivot that only adds the standard path fails the complexity
goal. Preserve the Omnigent implementation as a backend baseline, not as a
permanent second browser protocol.

### Priority 8: add an error and capability matrix

For each supported feature and failure, specify whether the response engine
handles it, the backend reports it, the SDK absorbs it, or the application must
act. This reduces unknown unknowns around cancellation, backend restart,
revocation during streaming, malformed calls, and duplicate outputs.

## Decision recommendation

Continue the Open Responses pivot and run the vertical slice, but keep ADR 0010
in **proposed** status until the first four revisions above are incorporated and
tested.

The architectural decision should be accepted if the slice demonstrates that:

1. a standard client completes a multi-function Codex task through the gateway;
2. the supported profile is substantially smaller and clearer than “whatever
   Open Responses permits”;
3. the response engine persists and recovers a client-function request without
   exposing provider IDs;
4. the bundled backend hides all Omnigent/Codex/MCP lifecycle details from the
   engine and browser;
5. the OAuth audit reduces custom protocol machinery without leaking the full
   standards stack into grant policy; and
6. the migration deletes, rather than merely deprecates indefinitely, the
   duplicated application task/event path.

Under Ousterhout's philosophy, the decisive metric is not standards adoption or
package count. It is whether the most common future changes—adding an
application, changing authorization policy, updating Open Responses, replacing
the harness transport, and recovering a dropped function call—can each be made
by understanding and modifying one small set of deep modules. ADR 0010 points
toward that outcome. The revisions above are what turn the attractive diagram
into an architecture that actually controls complexity.

## Book concepts referenced

The review uses named concepts from the second edition without relying on
edition-specific page quotations:

- Chapter 2, “The Nature of Complexity”: dependencies, obscurity, change
  amplification, cognitive load, and unknown unknowns;
- Chapter 3, “Working Code Isn't Enough”: tactical versus strategic
  programming;
- Chapter 4, “Modules Should Be Deep”: interface complexity relative to hidden
  functionality, shallow modules, and classitis;
- Chapter 5, “Information Hiding (and Leakage)”: information leakage and
  temporal decomposition;
- Chapter 6, “General-Purpose Modules are Deeper”: somewhat general-purpose
  facilities, separating specialization, and eliminating special cases;
- Chapter 7, “Different Layer, Different Abstraction”: pass-through methods,
  interface duplication, decorators, and pass-through variables;
- Chapter 8, “Pull Complexity Downwards”: configuration as complexity imposed
  on callers;
- Chapter 9, “Better Together Or Better Apart?”: shared information and related
  tasks as reasons to combine code;
- Chapter 10, “Define Errors Out of Existence”: absorbing recoverable cases in
  the owning abstraction;
- Chapter 11, “Design it Twice”;
- Chapters 12–15 on comments, non-obvious information, names, and using comments
  as a design tool;
- Chapter 19's discussion of building agile increments as abstractions rather
  than feature-shaped patches; and
- Chapter 21, “Decide What Matters.”

These chapter names and the second-edition changes are corroborated by
[Ousterhout's official book page](https://web.stanford.edu/~ouster/cgi-bin/book.php),
his official notes on [the nature of complexity](https://web.stanford.edu/~ouster/cgi-bin/cs190-winter18/lecture.php?topic=complexity),
and his official [software-design course review](https://web.stanford.edu/~ouster/cgi-bin/cs190-winter21/lecture.php?topic=bookReview).
