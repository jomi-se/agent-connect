# Connect your AI: OpenClaw-first implementation plan

Date: 2026-09-06.
Status: implementation in progress; native app authorization and live acceptance remain pending.

## Active execution ledger

For a fresh session, start with [the compact handoff](connect-your-ai-handoff.md).

Latest sequencing decision: inspect the supported patchless plugin execution
path before more implementation. We may support both plugin deployment and
upstream native hooks. The handoff records the concrete `runEmbeddedAgent`
candidate and unresolved authority, continuation and owner-auth questions.
Use one implementation lane for now; earlier parallel-lane entries below are
historical status, not instructions to restart workers.

2026-09-06 composition checkpoint: the actual compiled consent plugin passed
PAR, managed-ingress fixture owner consent, token issuance, native client tool
call, refresh rotation and result continuation to final text (`03MTsz`). The
ordinary listener rejects forged owner headers. Test:
`scripts/openclaw-consent-composition.test.mjs`. Tailscale/owner and inference
are disposable fixtures; the remaining live gate still requires owner approval
for runtime/routes and a real Bookhand acceptance run.

Started 2026-09-06 toward a clean Tailscale-flavored OpenClaw + SDK + Bookhand
vertical slice. Parent agent owns integration decisions, review and diagnosis;
Sol high workers own bounded implementation lanes. No live service migration or
push has occurred.

- Native app-principal lane: inspecting the exact supported plugin/core seam
  for delegated Responses authorization and native session/policy propagation.
  Initial seam approved: an endpoint-specific plugin verifier for native
  Responses, a stable plugin-namespaced app subject, and mandatory closed native
  policy. Core propagates creator/sandbox state without a private HTTP session
  bounce. Claimed invalid credentials deny rather than fall through to owner
  auth; app-controlled routing overrides are rejected. Native patch is under
  implementation and review; published OpenClaw does not yet supply this seam.
- AI SDK execution helpers committed as `c8d680b`; browser OAuth client and
  exports committed as `cf3b3d1`. Bookhand received the built SDK and the separate
  required dependency patch with verified hashes. Nothing was published to npm.
- AI SDK source finding: published `@ai-sdk/open-responses` 2.0.39 does not emit
  `previous_response_id`; AI SDK's tool steps replay accumulated messages. A
  reproducible downstream patch and public step hooks now retain native
  continuity. The real pinned OpenClaw integration passed two sequential local
  tools and a separate contextual follow-up in one native session, without
  duplicate result history. This used internal test authorization, not app
  consent, and is not subscription-model or Bookhand acceptance evidence.
- Grant service committed as `4c271ed`: durable fixed-snapshot grants, PKCE,
  token rotation, replay-family revocation, expiry and policy rechecks. Focused
  tests include actual file reload and uncertain-persistence fail-closed behavior.
- Actual browser client against the actual OAuth handler passed discovery,
  consent, issuer-bound callback, token exchange, concurrent refresh and
  revocation (`dedb8ef`). Owner identity was a test fixture: this does not prove
  native OpenClaw or Tailscale authentication. Model alias is
  `openclaw/default`. One app-level refresh getter is
  shared across features; conversations remain feature/book-local. Ambiguous
  admitted failures do not authorize automatic replay of a retained checkpoint.
- Native policy review caught an unnecessary unconditional sandbox requirement.
  App-tools-only/web-only profiles must have enforced restricted tool policies;
  code execution additionally requires a sandbox. Fingerprinting policy is not
  by itself proof that its initial permissions match the consent description.
- Real plugin startup exposed two native integration mismatches: agent config is
  normalized into entries, and registration-time plugin identity is not HTTP
  request context. The patch now uses native agent resolution and loader-owned
  registration identity. Rebuilt endpoint verification remains in progress.
- Security review also established that native `tools.allow: []` is permissive,
  not deny-all. Application-only profiles require explicit native denial. The
  acceptance test must inspect the actual inference tool list, including proving
  approved client functions remain available. Media/file inputs are rejected for
  the text-only v0 before extraction or URL fetching.
- Native source-runtime smoke now passes an actual client-tool round trip across
  access-token refresh, with only the approved function advertised to inference.
  It also checks cross-grant continuation and owner-route denial, invalid-token
  rejection, media/schema rejection before inference, and native creator state.
  Compiled external-plugin loading subsequently passed as recorded below.
- Consent plugin committed as `995423f`. Actual compiled patched-OpenClaw bundle
  load, discovery, PAR and forged-owner rejection pass. Default repository
  `npm run verify` also passes; live Tailscale owner consent and Bookhand
  subscription-backed hero remain pending.
- Consent required an additional narrow native helper: ordinary plugin HTTP
  routes cannot use OpenClaw's Control UI Tailscale auth surface. The new helper
  accepts the original listener-attributed request and reuses WhoIs, rate limits,
  durable profiles and role ceilings. Focused host tests pass owner/nonowner and
  forged-header cases; actual tailnet/browser acceptance is still unproven.
- Owner-authentication finding: pinned OpenClaw already has listener-attributed,
  WhoIs-verified Tailscale identity handling, but ordinary Responses requests do
  not automatically inherit it. Reuse that trust boundary for owner consent;
  app requests must use their own scoped principal afterward.
- Bookhand checkout is on `work/openclaw-tutor-demo` with substantial pre-existing
  uncommitted Tutor and unrelated work. Preserve all of it; coordinate ownership
  before modifying its integration. Existing live gateways remain untouched.
- Bookhand acknowledged the package handoff and started Sol-high implementation
  lanes. Its v0 credentials are memory-only per tab/application lifetime; pending
  PKCE and feature intent survive the redirect in sessionStorage. A new page
  lifetime requires reconnecting. Local connection generation survives refresh
  but not new authorization, and is distinct from each book conversation.
- Final native app-auth composition, Tailscale owner consent and Bookhand
  subscription-backed tool/follow-up acceptance remain unproven.

Resume from the lane artifacts and current diff, not the earlier separate-gateway
demo's success claims. Compatibility providers remain deferred.

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
