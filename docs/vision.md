# North star: Connect your AI

Recorded: 2026-09-06.
Status: **accepted product direction; proposed interoperability profile**.
José identified this framing as the closest description of the intended endgame
so far. This document preserves that discussion and its design implications.
It is not a published standard, a finished protocol specification, or a claim
that the current implementation already satisfies it.

## The ambition

Make **Connect your AI** an ordinary application capability, like connecting a
calendar or payment account. A developer integrates once; the user chooses who
supplies the intelligence and authorizes the application to use it.

> Choose your AI, authorize this app, and receive a usable, scoped Responses
> connection.

The motivating experience is as straightforward as a familiar external-account
authorization flow: a known consent surface, a clear decision, then back to the
application with the feature enabled. This is an illustration of the desired
ease of use, not a requirement to clone Google login or confuse authentication
with permission to spend inference allowance.

The important boundary is the **portable application–provider contract**.
OpenClaw is one possible implementation, not the definition of the product.

## The user and developer experience

```text
App: Connect your AI
    ↓
User chooses their AI provider
    ↓
Provider: This app requests these capabilities and this allowance
User authenticates and approves
    ↓
Back to the app
    ↓
The app has an authorized Open Responses connection
```

A provider could be a personal OpenClaw installation, another user-owned
runtime, a hosted personal-agent service, or eventually an AI lab directly.
Here, user-owned means selected and authorized by the user and backed by their
account/resources; it need not mean the user physically operates the server.
The application does not need to understand the harness, credential storage,
subscription mechanism, proxy, or machine underneath that provider.

An illustrative SDK shape, **not an existing API or settled field vocabulary**:

```ts
const ai = await connectAI({
  required: ["text", "application-tools", "continuation"],
  tools: bookhandTools,
});

const stream = await ai.responses.create({
  input: "Explain this passage",
  stream: true,
});
```

The connection handles authorization and credential renewal. It can expose an
authorized fetch/client configuration for existing Responses libraries; apps
must not be forced to adopt our chat UI or an additional task protocol.
The SDK is optional convenience: another SDK or plain HTTP must be able to
implement the same documented contract.

## A small profile around existing standards

The work is an authorization-and-discovery **profile around Open Responses**,
not a new agent protocol. A profile makes specific interoperability choices
about existing mechanisms and adds only the missing application semantics.

### 1. Find and recognize the selected provider

Unlike a fixed Sign in with Google button, Connect your AI does not necessarily
have one known destination. Initially, support provider selection or a personal
endpoint/link and remember the choice. A browser, OS or password-manager-like
integration could later supply a preferred provider, but v0 must not depend on
such an integration existing.

There must be no mandatory central Agent Connect account, provider directory,
relay, or online approval service. An optional provider catalog is a convenience,
not an authority required for independent providers to work.

After selection, machine-readable metadata identifies the authorization service,
Responses resource and capabilities. Reuse OAuth authorization-server discovery
and protected-resource metadata instead of inventing an unrelated discovery
protocol. The profile still needs to specify how these compose with the AI
resource and any additional capability description.

Provider selection establishes the expected identity before credentials are
exchanged. Validate the authorization issuer, resource and redirects; a URL
suggested by an application is not automatically a verified user-owned runtime.
Subscription credentials never pass through the application.

### 2. Admit unfamiliar applications without manual per-server registration

A Bookhand developer cannot manually register Bookhand with thousands of users'
personal servers. This is a central interoperability requirement, not an optional
setup convenience.

MCP's authorization work provides a relevant precedent: independently deployed
clients discover authorization services and establish client metadata without
requiring every pair to be registered manually. Its 2026-07-28 profile prefers
OAuth Client ID Metadata Documents and retains Dynamic Client Registration for
compatibility. Client ID Metadata Documents are still an Internet-Draft in the
research snapshot; do not describe them as a finalized RFC.

Reuse suitable OAuth mechanisms without requiring MCP as the inference wire.
Native forks and installations without a domain can use an explicitly unverified
installation/pairing path. Pairing, publisher metadata and proof of an official
binary are separate questions. A metadata URL or client registration does not
make an application trustworthy. Fetching arbitrary metadata also needs bounded,
SSRF-safe handling in a real implementation.

Exact registration priorities and the first native fallback remain profile
decisions, not silently settled by this vision.

### 3. Give the authorization a consistent, enforceable meaning

The baseline grant should mean:

> This application may spend the approved allowance, create and continue its
> own conversations, and offer the approved application tools. It receives no
> gateway administration rights or access to unrelated conversations.

The provider owns the consent UI and enforces the result. Approval should explain
which app/installation is asking, the requested capabilities, allowance, duration,
and how to revoke access. An app cannot authorize itself, approve its own
escalation, or receive the owner's general account/gateway credential.

Use existing OAuth authorization and resource/audience binding. Browser code/PKCE
and device authorization can mint the same underlying grant; implementing every
flow is not a prerequisite for the first working profile. Avoid an embedded
secret in public clients and do not imply PKCE verifies the publisher.

Permissions are server-owned records, not caller-supplied scope headers. Bind
conversation ownership to a stable application grant rather than a rotating
access-token string. Renewal must not silently switch conversations or force
owner consent on every ordinary token expiry.

Keep these boundaries distinct:

| Boundary                    | Required meaning                                                  |
| --------------------------- | ----------------------------------------------------------------- |
| API authority               | No configuration, pairing, approval or unrelated control APIs     |
| Conversation authority      | Only sessions/responses belonging to this grant                   |
| Agent capabilities and data | Only the owner-approved tools, context and resources              |
| Resource allowance          | Enforced limits and clear exhausted-allowance behavior            |
| Lifecycle                   | Explicit expiry, renewal, revocation and in-flight-work semantics |

The normally useful agent can retain approved web research, computation and
other native tools alongside application tools. Access to personal files,
connected accounts, private memory or powerful host tools requires separate
disclosure and authorization. Restricting the API credential alone does not
protect data exposed through the agent. The profile must not promise immunity
to prompt injection or label an unrestricted owner agent app-isolated.

Providers may enforce these boundaries differently, but equivalent permission
claims must have equivalent minimum meaning. A small initial vocabulary is
preferable to standardizing every runtime's internal ACL or tool taxonomy.

### 4. Return an interchangeable Responses connection

Use ordinary Open Responses for execution, including its client-tool round trip.
Do not expose Omnigent, ACP, OpenClaw internal sessions, or a new proprietary
task/event protocol to applications.

Specify a small tested baseline rather than saying OpenAI-compatible and leaving
developers to discover the differences:

- Text and streaming.
- Application function requests and correlated function outputs.
- Defined continuation and session-selection behavior.
- Predictable failure for expired/revoked authorization, exhausted allowance and
  unsupported capabilities.
- Credential renewal without changing conversation identity.

Advertise optional capabilities such as images, files or web research. An app
declares what it requires and checks what was actually granted; it must not infer
capabilities from a provider's brand. Do not interpret a generic completed stream
as proof an external side effect happened exactly once.

The exact metadata fields, scope names, required Responses subset, lifecycle/error
mapping and version negotiation are still to be specified and tested. Existing
SDK session capabilities are implementation evidence, not automatically a new
wire-level requirement for every provider.

## Transport is deployment, not application identity

The contract should work over a reachable, correctly authenticated HTTPS
connection. Tailscale, VS Code/Dev Tunnels and ordinary reverse proxies are
possible ways to provide that connection, not mandatory authentication protocols.

Separate three questions: can the app reach the endpoint, can the owner approve
the app, and what may its credential do afterward? A private tunnel may add its
own login/token gate before OAuth or Responses is reachable. Browser CORS,
preflight, streaming and that outer authentication need real tests; HTTPS alone
does not prove cross-origin compatibility. A publicly reachable endpoint may
still require strong app authorization.

Tunnels can terminate TLS and see traffic; they belong in the chosen deployment's
trust model. Their credentials must not be confused with app grants. Provider URL
changes also require deliberate identity/issuer handling, not credential forwarding
to an arbitrary replacement address.

## How to make this capable of becoming a standard

Ship three complementary deliverables:

1. **A short public profile:** exact handshake, metadata, permission semantics and
   mandatory Responses behavior, with explicit optional extensions.
2. **An SDK:** selection, authorization, renewal and application-tool handling;
   no mandatory UI framework or runtime dependency.
3. **A provider implementation:** initially OpenClaw integration, keeping its
   operational details behind the public contract.

Use Bookhand as a real application, then demonstrate the **same app integration
against two independently implemented providers**. A second deployment of the
same adapter, or two providers sharing our entire server implementation, is weaker
evidence. Someone should be able to build a provider from the document without
copying our gateway or adding provider-specific code to Bookhand.

Make conformance tests exercise the public boundary, including isolation,
revocation, errors and continuation, not just a successful text response. The
second implementation is how we discover accidental OpenClaw assumptions before
turning them into supposed universal requirements.

Take that working interoperability and the smallest remaining proposal to Open
Responses, OAuth/MCP contributors and runtime maintainers. Seek reuse and common
ownership; publishing our document alone does not create an industry standard.
This direction authorizes neither external outreach nor submissions by itself.

## What the current OpenClaw work proves—and does not

The [delegation investigation](research/2026-09-05-openclaw-app-delegation.md) and
[independent feasibility report](reviews/2026-09-05-openclaw-plugin-feasibility.md)
show a plugin composition with native sessions, Responses, app/native tools and
scoped enforcement. Its private routes, trusted headers, proxy restrictions and
process layout are implementation details. They must not become requirements
for all conforming providers.

Plugin-plus-restricted-ingress packaging and a cleaner native delegation hook
remain implementation options with different costs. This vision does not settle
that choice, approve an upstream patch, or authorize a live migration. It also
does not retrospectively turn the feasibility prototype into a complete consent,
durability, transport or Bookhand release pass.

Evaluate implementation work by whether it advances the app/provider contract.
Do not preserve a separate Agent Connect gateway, custom response engine or
provider-specific public session protocol merely because we built one earlier.

## Limits and decisions still open

- AI providers must permit and support the delegated use of their subscriptions.
  A standard cannot manufacture that commercial permission. The motivating
  product uses the user's existing account/allowance, not a mandatory second
  subscription or developer-owned API bill.
- Local models and other owner-chosen backends can implement the same contract;
  subscription billing mechanics must not be baked into the wire.
- Select the initial registration/consent profile, metadata vocabulary and
  concrete grant/lifecycle semantics before claiming interoperability.
- Keep provider selection functional without a universal browser/OS AI picker.
- Select a genuinely independent second provider; none is promised by this note.
- Decide how to demonstrate enforcement of optional powerful capabilities
  without implying all implementations have identical agents or sandboxes.
- Do not broaden the current implementation's release gates to the whole
  endgame at once. A small end-to-end profile is the next proof, not a fully
  standardized ecosystem or a federation/billing platform.

## References and related decisions

External references below preserve the discussion's 2026-09-05/06 research
context; draft status and provider support must be rechecked before implementation.

- [Open Responses specification](https://www.openresponses.org/specification).
- [OAuth authorization-server metadata, RFC 8414](https://www.rfc-editor.org/info/rfc8414/).
- [OAuth protected-resource metadata, RFC 9728](https://www.rfc-editor.org/info/rfc9728/).
- [OAuth resource indicators, RFC 8707](https://www.rfc-editor.org/info/rfc8707/).
- [OAuth security best current practice, RFC 9700](https://www.rfc-editor.org/info/rfc9700/).
- [MCP authorization, 2026-07-28 revision](https://modelcontextprotocol.io/specification/2026-07-28/basic/authorization).
- [OAuth Client ID Metadata Document, Internet-Draft](https://datatracker.ietf.org/doc/draft-ietf-oauth-client-id-metadata-document/).
- [Device authorization, RFC 8628](https://www.rfc-editor.org/rfc/rfc8628.html).
- [Native application identity investigation](future/native-client-identity.md).
- [ADR 0010: existing Open Responses boundary](decisions/0010-open-responses-gateway-pivot.md).
- [ADR 0012: current OpenClaw implementation direction](decisions/0012-openclaw-policy-gateway.md).
- [Current mission](mission.md), [implementation inventory](scope-inventory.md),
  and [current work](plan/current-work.md).
