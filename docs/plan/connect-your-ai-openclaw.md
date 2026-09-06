# Connect your AI: OpenClaw-first implementation plan

Date: 2026-09-06.
Status: accepted plan; implementation and live acceptance remain pending.

This records José's refinements to the
[implementation brief](../../agent-connect-implementation-brief.md) and
[north star](../vision.md). Where their implementation ordering differs, this
plan takes precedence. Work stays on `work/openclaw-gateway` in
`/home/dev/agent-connect-openclaw`. No push, live runtime change or deployment
is authorized by documenting this plan.

## Settled product and responsibility boundaries

Bookhand invokes an AI feature (Tutor, remastering, or another feature). Without
a connection, it offers Connect your AI. The primary path asks for the user's
OpenClaw address, redirects to provider-owned authentication and consent, then
returns with an application-scoped credential. Pending feature input survives
the redirect. Features reuse the connection, not necessarily a conversation.

Agent Connect owns connection/authentication integration and thin adapter glue.
AI SDK owns the application-side model abstraction, streaming and tool loop.
OpenClaw owns execution, upstream subscription credentials and enforcement of
application authority. Use `@ai-sdk/open-responses` for native execution and a
small WebMCP-to-AI-SDK tool adapter for application tools. Do not add a new
Responses engine, message protocol or hosted inference relay.

At the Responses execution layer, the SDK needs an endpoint and bearer token;
it does not interpret grant internals. The provider's authorization flow must
care: it negotiates requested access, recommends conservative permissions,
explains the actual authority and issues the credential. OpenClaw enforces that
authority on each request. Never expose its owner token or upstream subscription
credentials to Bookhand.

### Two owner-authentication experiences, shared grants

- **Tailscale-flavored OpenClaw:** Tailscale is part of the authentication/trust
  story, not just reachability. Reuse verified owner identity where supported;
  establish exactly how the deployment supplies and verifies it. A forwarded
  request or recognizable hostname alone must not count as that proof.
- **Ordinary HTTPS OpenClaw:** use an explicit owner-verification/login mechanism.
  Select the smallest supported mechanism during the extension investigation;
  do not invent a second authorization protocol for it.

Both converge on the same consent, application grants, bearer verification,
refresh/revocation and Responses execution. Network membership does not itself
authorize Bookhand. These may be distinct connection experiences without
separate model providers or duplicate grant implementations. Tailscale is the
first end-to-end deployment; keep the shared boundary ready for ordinary HTTPS.

### Optional native capabilities

The owner may approve useful provider-native capabilities such as public web
search and **sandboxed code execution**. The latter means writing and executing
code in an isolated workspace, for example to process application-supplied book
chunks without putting the entire text in model context. It does **not** mean
host filesystem access, personal files, ambient memory or gateway administration.

The provider must explain and enforce the real sandbox boundaries: supplied
data, available mounts, network access and execution limits. Do not label an
unrestricted host process a sandbox. If required isolation is unavailable, fail
closed rather than silently run on the host. Exact sandbox policy and how the
app supplies larger data remain implementation decisions, not settled APIs.

## Implementation sequence

### 1. Establish the smallest upstreamable OpenClaw extension

Start from the existing [delegation research](../research/2026-09-05-openclaw-app-delegation.md)
and [plugin spike](openclaw-delegation-spike/README.md), not another broad survey.
Trace owner authentication, consent, credential verification, application
principal propagation, native session ownership and runtime policy enforcement.

Deliver an exact division of supported plugin work and any necessary core patch.
Prefer a small coherent upstreamable change over cumbersome proxy choreography
solely to avoid touching core. Do not assume upstream acceptance or claim that
the earlier feasibility fixture is already a deployable authorization service.

### 2. Implement provider-owned authorization and enforcement

Implement discovery, public-client Authorization Code + PKCE, owner consent,
durable app grants, access tokens, expiry and revocation; define refresh behavior.
Reuse existing authorization code where sound rather than rewrite it for style.
Connect verified app identity to OpenClaw's actual permission/session machinery.
Enforce application-owned conversations and permitted native capabilities;
application-supplied routing or headers cannot elevate authority.

Tailscale and ordinary HTTPS owner authentication feed this shared mechanism.
Browser preflight/CORS and redirect handling are part of implementation, not an
assumption that any HTTPS endpoint can be used from Bookhand.

### 3. Build the thin SDK connection path

Implement address/connection-flavor selection, PKCE redirect/callback handling,
credential lifecycle, disconnect and creation of an AI SDK Open Responses model.
Keep credentials separate from display metadata; do not log secrets. Begin with
internal modules rather than a package family or broad provider registry.

### 4. Integrate Bookhand and prove execution during the build

Start with Tutor, then route other AI features through the shared connection.
Preserve pending input across authorization. Use AI SDK for browser tool steps
and the WebMCP adapter for page-owned tools. OpenClaw owns native tool execution.

Prove two sequential application calls and a subsequent contextual user turn,
including correct retained conversation/history behavior and native-tool
composition. Do not precede this work with a separate multi-provider spike.
Document any actual adapter incompatibility before adding custom machinery.

### 5. Focused validation and review

- Real phone/Tailscale owner approval, useful Bookhand action and follow-up.
- Allowed native capability works; denied capability cannot execute.
- Cross-application conversation access and administrative access are rejected.
- Expiry, refresh, revocation, cancellation and reload preserve honest UI state.
- Ambiguous failures never automatically replay potentially mutating operations.
- Sandbox-required execution cannot fall back to the host.

Use deterministic real-OpenClaw checks for dependency-sensitive claims, narrow
contract fixtures for owned invariants, and a small real-subscription browser
smoke for final composition. Review the authority boundary before live cutover.
Avoid a large generic provider test matrix or unnecessary repeated full checks.

### 6. Compatibility providers last

Add OpenRouter and Mistral as secondary compatibility/demo connections after
the OpenClaw path works. Verify browser-direct support and current test allowance
availability then; free usage is not assumed. Pasted API keys are a fallback,
not subscription delegation. They should produce AI SDK models without changes
to consuming feature logic. They are not the first implementation priority.

## Decisions still requiring explicit resolution

- Exact supported plugin/core integration and ordinary-HTTPS owner login.
- Application identification/discovery details and renewal policy.
- Sandbox provisioning, permitted network/data access and resource limits.
- Fixed approved tool snapshot versus permission for an app to evolve its tool
  set: this plan does not silently replace existing fixed-snapshot consent with
  the brief's per-generation refresh policy.
- Retained OpenClaw history versus AI SDK message replay and interruption behavior.

Success is a useful Bookhand feature backed by the user's subscription through
an enforceable app-scoped OpenClaw connection, with ordinary Responses execution
and less Agent Connect-owned machinery. Other providers and a polished chooser
follow that proof, not the other way around.
