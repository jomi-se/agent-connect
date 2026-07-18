# Agent Connect project and architecture context for Claude

Date: 2026-07-18

Purpose: self-contained factual overview of the Agent Connect product, current implementation, authorization model, MVP, security boundaries, and intended architecture for an external collaborator who does not have repository access.

## Reader contract

This document supplies project context only. It deliberately does not prescribe a visual composition, information architecture, deliverable format, animation style, implementation technology, timing, or interaction model. The person using this context will receive creative direction separately.

The relevant subject matter is:

1. the architecture that works today, including the SDK, gateway, Tailscale trust profile, OmniGENT conductor, ACP adapter, Codex, and request-scoped application tools;
2. the connector bootstrap and OAuth-style application-authorization flow, including how the app and connector authenticate each other;
3. the live prompt, tool-request, browser execution, and correlated-result loop across those components;
4. the implementation-specific seams and security limitations that remain today;
5. the intended future architecture in which the Agent Connect control plane stays stable while the browser protocol, provider, coding agent, deployment, and confinement profile become more standardized or interchangeable.

The most important distinction throughout the project is architectural status: what is proven, what is transitional, what is intended, and what is only experimental.

### Current and proven

- the provider-neutral browser task/tool API;
- the Agent Connect gateway and opaque application sessions;
- connector identity, signed challenge, device enrollment, connector-owned consent, PKCE, scoped grant, and revocation;
- the private Tailscale Serve → gateway → OmniGENT → ACP → `codex-acp` → Codex composition;
- the public Funnel → disposable judge appliance → deterministic ACP composition;
- request-scoped application tools travelling through MCP without advance installation into Codex;
- real correlated tool requests, browser execution, and results.

### Current but deliberately transitional

- the browser package's remaining `OmnigentProvider` and gateway-proxied OmniGENT HTTP/SSE wire seam;
- one fixed tool snapshot, one active task, one downstream agent, and memory-only pending state;
- bearer grants without app-instance sender binding;
- the private Codex runtime's incomplete arbitrary-application confinement story.

### Intended direction

- keep Agent Connect identity, authorization, grants, logical sessions, action correlation, recovery, audit, and posture vocabulary as the stable control plane;
- evaluate AG-UI as the standardized browser/gateway event and frontend-tool language;
- retain ACP as the preferred downstream coding-agent boundary;
- add provider adapters and deployment profiles without changing every application's integration;
- move toward durable unresolved actions and reproducible, isolated runtime appliances.

### Experimental or supporting evidence

- direct ACP over WebSocket and the narrow MCP-over-ACP subset;
- Bubblewrap confinement findings;
- DPoP/app-instance keys and stronger message binding;
- detailed container and posture-attestation work.

These experimental items are evidence of investigated directions, not shipped features or committed standards.

## One-sentence product statement

Agent Connect lets web developers add AI features powered by coding agents their users already own: the app defines temporary, scoped tools; the user's gateway controls access to Codex, Claude Code, or another compatible runtime; and the app remains the authority that executes its own mutations.

## The north star

The long-term product is not “a browser client for OmniGENT” and not “a remote Codex controller.” It is a harness-neutral bridge between arbitrary applications and user-owned agent runtimes.

The application-facing experience should stay stable while the user chooses:

- the coding agent or harness: Codex, Claude Code, or another compatible runtime;
- the conductor/provider: the current OmniGENT reference adapter, a future direct ACP adapter, OpenClaw or another provider behind a narrow adapter;
- the deployment boundary: laptop, VM, user-operated container, ephemeral runner, managed deployment, or another trusted environment;
- the transport trust profile: Tailscale Serve first, localhost for development, and eventually other tunnels, account-backed directories, relays, or advanced custom endpoints with clearly stated assurance.

The durable product value is the reusable layer above those choices:

- connector identity and continuity;
- first-use runtime enrollment;
- connector-hosted application consent;
- exact-origin, app, scope, tool-snapshot, and expiry-bound grants;
- opaque logical sessions;
- provider-neutral task and application-tool events;
- stable action correlation and eventual unresolved-action recovery;
- revocation, audit, abuse ceilings, and policy separation;
- a truthful vocabulary for requested, configured, observed, self-reported, and externally attested runtime posture.

OmniGENT is important heavy lifting in the current reference implementation. It is intentionally behind the gateway's provider boundary rather than embedded in the app developer's public API.

### The axes intended to become independently swappable

Agent Connect is not trying to replace every layer with one protocol. Its north star separates several choices that are coupled in the MVP:

| Axis                    | Current reference                                                                                  | Intended alternatives                                                                                                      | Stable Agent Connect responsibility                                                                            |
| ----------------------- | -------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| Browser/application API | `@agent-connect/web` with neutral task/tool events; internal OmniGENT-shaped provider seam remains | AG-UI-compatible profile, experimental direct ACP client profile, other standard event clients                             | Connector discovery, authorization, logical sessions, application-owned tools, correlated actions              |
| Conductor/provider      | OmniGENT HTTP/SSE                                                                                  | Direct ACP gateway adapter, OpenClaw-like conductor, another self-hosted or managed provider                               | Narrow provider contract and provider-ID hiding                                                                |
| Coding agent            | Codex through `codex-acp`                                                                          | Claude Code or another ACP/adapter-compatible agent                                                                        | No agent-specific types in the public application API                                                          |
| Agent-side protocol     | ACP into `codex-acp`, with OmniGENT's request-scoped MCP relay for app tools                       | Native ACP client tools, a stable future MCP-over-ACP mechanism, provider-native tool bridge                               | Fixed application-tool snapshot and correlated request/result semantics                                        |
| Transport trust profile | Tailscale Serve for the private proof; Tailscale Funnel for the public judge fixture               | Localhost, VS Code/Microsoft Dev Tunnels, public reverse tunnels, account-backed relay/directory, custom HTTPS endpoint    | Declare what identity evidence exists and never infer trust from a hostname alone                              |
| Deployment boundary     | Long-running personal VM; one disposable public judge container                                    | User laptop, NAS/home server, packaged container, cloud VM, ephemeral on-demand runner, managed connector                  | Runtime-card identity, authorization boundary, opaque logical sessions, posture description                    |
| Runtime confinement     | Codex defaults in the private proof; constrained single-container deterministic public fixture     | Separate ephemeral runner container, controlled mounts/egress, credential brokerage, managed sandbox, attested environment | Prevent application authority expansion and report guarantees without pretending to enforce provider internals |
| Human authorization     | Connector bootstrap plus connector-owned OAuth-style app consent                                   | Lighter preconfigured personal profile, managed identity-backed enrollment, QR/fingerprint transfer, enterprise policy     | Exact app authority, revocation, expiry, and separation of app consent from runtime-native approvals           |

Changing one axis should not force every other layer to change. For example, replacing OmniGENT should not require redesigning application enrollment; replacing Tailscale with a public or account-backed tunnel should not change the public task/tool API; running the agent in an ephemeral cloud runner should not expose provider session IDs to the application.

## The three human roles

### Application developer

Adds `@agent-connect/web`, declares typed application-owned tools, connects to the runtime card supplied by the user, sends prompts, consumes task events, and implements the actual mutations. The developer should not need to understand OmniGENT sessions, Codex app-server, ACP process lifecycle, Tailscale headers, or connector state.

### Agent owner / user

Runs or selects an Agent Connect gateway beside an agent they own. They bootstrap the connector once, save its public runtime card and private enrollment passphrase through a trusted personal channel such as a password manager, and approve applications through a connector-owned page. They choose and secure the runtime environment.

### End user inside the web application

Imports or selects their runtime, approves the application's requested authority, then uses app-native AI features. They should not install a per-app MCP server, restart OmniGENT, copy provider session IDs, or SSH into the runtime for every new application.

Often the agent owner and the end user are the same person, but their responsibilities remain conceptually distinct.

## MVP scope and deliberate non-goals

The MVP proves one narrow but complete capability-lending loop rather than generalized agent orchestration.

Current operating assumptions:

- one online OmniGENT host;
- one downstream coding agent;
- one active task per application session;
- one fixed tool snapshot per logical/downstream session;
- opaque Agent Connect session IDs at the application boundary;
- gateway-owned provisioning and replacement of unhealthy OmniGENT sessions;
- browser-owned execution of application tools;
- stable action IDs without a claim of generic exactly-once side effects;
- one private real-Codex composition proof and one public deterministic judge fixture.

Deliberate first-slice non-goals:

- multi-agent orchestration;
- full arbitrary MCP feature coverage;
- a finalized universal browser/agent protocol;
- multiple concurrent tasks per application session;
- importing normal Codex CLI history;
- production identity federation, billing, public relay, or account recovery;
- treating arbitrary custom URLs as verified user-owned runtimes;
- claiming production confinement for malicious authorized applications;
- replaying every streamed token;
- shipping a second provider before the existing provider boundary is stable.

The MVP's distinguishing proof is that the application can define tools dynamically for a session and a remote Codex composition can call them without the user installing an application-specific MCP server in advance.

## The core capability: applications lend tools temporarily

This is bidirectional, not a one-way prompt pipe.

1. The web app creates a fixed snapshot of tools for the logical session.
2. The app sends a prompt through Agent Connect.
3. The coding agent reasons and may stream text.
4. The agent may request zero, one, or many of the exact tools offered by the app.
5. The request returns to the browser with a stable action ID.
6. The browser validates the arguments and executes the application-owned handler.
7. The application changes its own DOM or data.
8. A correlated result returns to the same agent turn.
9. The agent can continue, call another tool, finish, fail, or be cancelled.

The coding agent does not directly own the application's DOM or database. The application is still the side-effect authority. Agent Connect does not claim generic exactly-once execution; consequential application handlers must be idempotent or deduplicate using the stable action ID.

## What the public browser API looks like

The application API is intentionally small and provider-neutral:

```ts
const moveTasks = defineTool({
  name: "move_project_tasks",
  description: "Move existing project tasks between board columns.",
  inputSchema: moveTasksSchema,
  execute: ({ moves }, context) => {
    board.moveAll(moves, { actionId: context.actionId });
  },
});

const connection = await connectAgent({
  baseUrl: runtimeCard.endpoint,
  appId: "agent-connect-demo",
  tools: [createTasks, updateTasks, moveTasks],
  accessToken: applicationGrant,
});

for await (const event of connection.session.streamTask(prompt)) {
  renderTaskEvent(event);
}
```

The normalized browser event vocabulary currently is:

```ts
type AgentTaskEvent =
  | { type: "task.started" }
  | { type: "text.delta"; delta: string }
  | {
      type: "tool.requested";
      actionId: string;
      name: string;
      arguments: Record<string, unknown>;
    }
  | {
      type: "tool.completed";
      actionId: string;
      name: string;
      isError: boolean;
      error?: { code: string; message: string };
    }
  | { type: "task.completed"; text: string }
  | { type: "task.failed"; error: { code: string; message: string } }
  | { type: "task.cancelled" };
```

Provider-specific events are smaller internal events and are translated into this vocabulary. The application receives an opaque Agent Connect session ID, never a raw OmniGENT conversation ID.

## Architecture that works today: private real-Codex profile

```text
Firebase or another HTTPS web application
  application UI and data
  @agent-connect/web
  application-owned JSON-Schema tools
           |
           | HTTPS through the user's tailnet
           v
Tailscale Serve
  valid HTTPS endpoint
  tailnet reachability and ACL policy
  strips spoofed identity headers
  injects authenticated Tailscale-User-Login
           |
           | loopback proxy only
           v
Agent Connect gateway
  durable connector Ed25519 identity
  enrollment and connector-owned consent UI
  origin/app/scope/tool-bound grants and revocation
  opaque logical sessions and session capabilities
  fixed tool-snapshot validation
  internal provider adapter and unhealthy-session healing
           |
           | current internal OmniGENT HTTP/SSE session protocol
           v
OmniGENT server + host
  conversation state
  harness process lifecycle
  session runner
  request-scoped client tools
           |
           | generic downstream ACP
           v
@agentclientprotocol/codex-acp
           |
           | Codex app-server protocol
           v
Codex
  user-owned model subscription and coding-agent runtime
           |
           | request-scoped MCP relay created by OmniGENT
           v
application tool request returns through gateway to browser
```

This composition has completed real remote browser-to-Codex tool calls. OmniGENT 0.5.1 launches the published `@agentclientprotocol/codex-acp` adapter. The browser supplies tools with the first session message. Codex sees those tools through OmniGENT's request-scoped MCP relay. An OmniGENT `action_required` function call travels back through the gateway, the app executes it, and a `function_call_output` resumes the same Codex turn.

The gateway automatically provisions an OmniGENT session when an application session is created. A healthy provider session with the same application Origin, app ID, grant, and canonical tool hash is reused. An unhealthy session is replaced behind the same opaque application boundary. A materially different tool snapshot produces a different downstream session instead of mutating the existing Codex process in place.

### Current OmniGENT-specific wire seam

The neutral `connectAgent()` API currently instantiates an internal `OmnigentProvider` in the browser package. That provider:

- opens gateway-proxied `GET /v1/sessions/{opaqueId}/stream` SSE;
- posts a strict `message` event containing one user input and the fixed OpenAI-format function-tool envelope;
- maps OmniGENT `response.output_text.delta` to `text.delta`;
- maps an OmniGENT `response.output_item.done` function call in `action_required` state to `tool.requested`;
- posts `function_call_output` with the correlated call ID;
- maps completion, failure, cancellation, and interruption into normalized events.

This works, but it is a transitional implementation seam. The project does not want OmniGENT event names to become the public application standard. A future browser/gateway protocol should move this translation wholly behind the gateway.

## Runtime enrollment and application authorization

The phrase “Tailscale OAuth-ish flow” is convenient shorthand but technically imprecise. Tailscale does not issue the application grant and Agent Connect does not use Tailscale as a generic OAuth authorization server.

The composition is:

- Tailscale Serve supplies authenticated transport, TLS, tailnet policy, and a protected requester identity header to a loopback gateway.
- Agent Connect supplies connector identity, runtime enrollment, its own connector-hosted OAuth-style Authorization Code + PKCE ceremony, grant storage, and revocation.

These are separate layers. The transport establishes how requests reach the connector and, for the private profile, which tailnet identity is making them. Agent Connect establishes which connector the user enrolled, which browser device may approve applications, which application authority the user approved, and whether that authority is still active.

### The parties and artifacts

The ceremony involves several distinct parties and artifacts that must not be collapsed into one generic “login”:

- **Connector identity:** a durable Ed25519 key pair created by the gateway. Its public-key thumbprint becomes the stable runtime ID.
- **Runtime card:** public routing and connector-identity material carried by the user from the connector to an application. It contains the endpoint and public key, but no bearer secret.
- **Enrollment passphrase:** a high-entropy private bootstrap secret delivered through the connector's trusted operator channel. It enrolls a browser device on the connector origin; it is not an application API key and is never given to the application.
- **Transport principal:** identity asserted by the selected transport profile. In the private Tailscale Serve profile this is the protected `Tailscale-User-Login` header. A public Funnel endpoint does not provide that identity.
- **Enrolled-device cookie:** an `HttpOnly`, `Secure`, `SameSite=Lax` connector-origin cookie issued after passphrase verification. It lets that browser device review and manage application grants without returning to the terminal for every app.
- **Authorization request:** an ephemeral record containing the exact app ID, Origin, callback, scopes, and canonical tool metadata the application wants the user to approve.
- **Authorization code and PKCE verifier:** a short-lived, one-use redirect result plus proof held by the initiating browser instance. These protect the callback exchange from interception and request mix-ups.
- **Application grant:** a revocable bearer token bound server-side to connector identity, exact Origin, app ID, scopes, canonical tool hash, and expiry.
- **Session capability:** a narrower capability derived after session creation and bound to the exact logical session and tool snapshot.

### What “two-way trust” means here

There are three different trust questions:

1. **The application asks whether it reached the connector the user enrolled.** The imported runtime card pins a connector public key. A fresh signed challenge proves the endpoint currently controls the matching private key before the application reveals prompts, tool schemas, or app data.
2. **The connector asks whether the person at its authorization page may manage this user's connector.** The transport principal supplies profile-specific identity where available, and the enrollment passphrase establishes first-device user presence on the connector's own origin. The enrolled-device cookie supports later approvals.
3. **The connector asks whether this request stays inside authority the user granted to this application.** Consent records the exact Origin, app ID, scopes, callback, tool snapshot, and expiry. Later requests must present the corresponding grant and match those bindings.

The current system does **not** give every web application its own cryptographic key. An `Origin` header alone is a browser/CSRF boundary, not caller authentication, because a non-browser client can fabricate it. Current application access depends on the bearer grant plus server-side Origin/app/tool bindings. App-instance keys and DPoP-style sender-constrained grants are future hardening.

### Why each protection exists

| Concern                                                          | Current response                                                                                                                                          | Remaining limitation                                                                                                          |
| ---------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| A malicious endpoint substitutes itself for the user's connector | User transfers a runtime card containing the connector public key; the app verifies a fresh Ed25519 challenge before disclosure                           | This proves key continuity, not host integrity or sandbox correctness                                                         |
| A random caller consumes the user's agent subscription           | Private Serve profile checks the protected Tailscale requester; connector management requires an enrolled device; agent use requires an application grant | Public profiles need a different requester policy and connector-level usage ceilings remain limited                           |
| An application counterfeits the consent screen                   | Consent is a top-level page on the connector's origin, not an iframe or app-owned modal                                                                   | The user must still recognize and judge whether the requesting app is trustworthy                                             |
| An application silently broadens its authority                   | Grant binds exact Origin, app ID, scopes, canonical tool hash, and expiry; changed tools require new consent                                              | Incremental/partial grants are not implemented                                                                                |
| An authorization redirect is intercepted or mixed up             | OAuth state, exact callback matching, short-lived single-use code, and S256 PKCE                                                                          | This is an OAuth-style connector protocol, not a claim of full generic OAuth-server conformance                               |
| A grant is later stolen                                          | Grant hashes are stored server-side; browser token lives in `sessionStorage`; expiry and revocation are enforced                                          | The token remains bearer material until app-instance sender binding is implemented                                            |
| Traffic is modified in transit                                   | The supported remote profiles use HTTPS/TLS                                                                                                               | Payloads are not additionally end-to-end signed; DPoP/message binding remains planned                                         |
| An authorized app is malicious                                   | Consent names the exact app and warns about prompts, subscription use, exfiltration attempts, and ambient agent authority; tool expansion is blocked      | Authorization records user intent but does not make the app benign; runtime confinement is a separate provider responsibility |
| The connector claims it is sandboxed                             | Runtime posture can name whether a claim is configured, self-reported, observed, or externally attested                                                   | A connector signature proves who made a claim, not that the claim is independently true                                       |

### Phase A: bootstrap the connector once

On first setup:

1. The gateway creates a durable Ed25519 connector identity.
2. It creates a high-entropy enrollment passphrase and stores only an scrypt verifier.
3. It emits two separate artifacts through a trusted operator channel such as the terminal or installer:
   - a public runtime card;
   - the private enrollment passphrase.
4. The user stores them in a password manager or another trusted personal store.
5. This ceremony is the user's statement: “this endpoint and public key belong to the connector I set up.”

The runtime card is routing and public identity material, not a bearer credential:

```json
{
  "version": 1,
  "runtimeId": "sha256:connector-key-thumbprint",
  "endpoint": "https://device.tailnet.ts.net:8443",
  "connectorPublicKey": {
    "kty": "OKP",
    "crv": "Ed25519",
    "x": "base64url-public-key"
  },
  "transportProfile": "tailscale-serve",
  "authorizationServer": "https://device.tailnet.ts.net:8443"
}
```

The passphrase is never placed in the runtime card, Firebase assets, app storage, URL, or authorization request. It is entered only on the connector-owned origin.

Why this bootstrap exists: HTTPS proves control of a hostname, and a `.ts.net` suffix suggests a transport provider, but neither alone tells an arbitrary app that the destination is the connector this user deliberately set up. Trust-on-first-use without an operator-channel artifact would only prove continuity after a potentially malicious first contact.

### Phase B: verify the connector before disclosure

Before sending prompts, tool schemas, or application data:

1. The SDK generates a fresh nonce.
2. It calls `POST /v1/runtime-challenges`.
3. The endpoint returns the nonce, runtime card, and an Ed25519 signature.
4. The SDK verifies the signature against the public key pinned in the imported runtime card.
5. A wrong endpoint or wrong key fails before the app reveals its tool surface.

This authenticates continuity with the enrolled connector. It does not prove that the host is uncompromised, that its software is benign, or that its sandbox claims are true.

### Phase C: authorize one application

For a new web application:

1. The SDK generates OAuth state, a PKCE verifier, and an S256 challenge.
2. It pushes an authorization request to `POST /v1/authorization-requests` containing the exact app ID, callback, requested scopes, and canonical tool metadata.
3. The connector returns an opaque request ID and a top-level `/authorize` URL on its own origin.
4. The browser navigates away from the app to the connector-owned page. It is not an iframe and the app cannot counterfeit the consent UI.
5. The private Tailscale Serve profile checks the protected Tailscale requester identity against connector policy.
6. On the first browser device, the connector asks for the enrollment passphrase and issues an `HttpOnly`, `Secure`, `SameSite=Lax` enrolled-device cookie after successful verification.
7. The consent page displays the actual application Origin, exact callback, app ID, scopes, tool names/descriptions/schemas, duration, subscription-use warning, and an explicit malicious-application warning.
8. The user approves or denies.
9. Approval returns a short-lived, single-use code to the exact callback URI.
10. The app validates callback location and state, then exchanges the code with the PKCE verifier at `POST /oauth/token`.
11. The connector issues a revocable bearer grant bound to its connector identity, exact Origin, app ID, full scope set, canonical tool hash, and expiry.
12. The grant can create an opaque application session. A session-specific capability then binds Origin, app ID, session ID, tool hash, issued time, and expiry.

The currently implemented scopes are the complete set `agent:prompt`, `agent:result`, and `tools:invoke`; partial and incremental grants are not yet implemented. Grant tokens are hashed at rest but are bearer tokens in browser `sessionStorage`. App-instance keys and DPoP-style sender-constrained tokens are target hardening, not current behavior.

Authorization proves that the user knowingly gave this Origin the displayed authority. It does not make the application trustworthy. A malicious or compromised authorized app can send adversarial prompts and tool descriptions, consume the user's subscription, try to induce data exfiltration, or exploit ambient runtime authority. The implemented consent page therefore states this risk explicitly.

### Phase D: later use and revocation

An equal authorized tool snapshot can reconnect silently while the grant remains active. The connector-owned grants page lists authorized applications. `POST /oauth/revoke` invalidates the app grant, and the gateway rejects new application sessions and live session capabilities derived from a revoked grant.

Current persistent state includes connector keys, enrollment verifier, device-token hashes, application-grant hashes and bindings, revocation state, and the capability-signing secret. Pending authorization requests, authorization codes, logical-to-provider mappings, and unresolved application tool calls are still memory-only.

### Current UX restriction versus target UX

The normal deployed profile still has an environment-configured Origin allowlist. The public judge profile intentionally freezes exact authorities. This is an implementation restriction, not the product's intended application-onboarding model.

The target behavior is dynamic application enrollment:

- an unknown HTTPS Origin may initiate only the bounded connector-identity and authorization bootstrap;
- it receives no prompt, result, tool, or session authority before approval;
- approval creates a durable grant for exactly that Origin, redirect, app, scopes, and tool snapshot;
- it does not add the host to a global trust list;
- a new or broader tool surface requires new or incremental consent.

## Tailscale trust profile: what it proves and what it does not

The first private remote profile is Tailscale Serve:

- the gateway listens only on loopback;
- Tailscale terminates HTTPS and authenticates the destination node at the transport layer;
- tailnet ACLs control reachability;
- Serve removes spoofed inbound identity headers and injects the authenticated requester's Tailscale login;
- the gateway checks that identity against its configured policy.

However, ordinary page JavaScript does not receive the destination's Tailscale node public key, LocalAPI `whois`, or a cryptographic statement that the human owning the app also owns the destination. Recognizing a `.ts.net` hostname is never treated as sufficient trust. The runtime card and connector-key challenge provide the user-mediated binding that the browser can verify.

Transport trust and application authorization are separate. A trusted Tailscale connection does not authorize an arbitrary web Origin. Conversely, a valid application grant does not prove the connector host is uncompromised.

Future transport profiles may use Microsoft Dev Tunnels, localhost, an account-backed Agent Connect directory, a public relay, QR/fingerprint transfer, managed connectors, or advanced custom URLs. Each must publish what identity evidence exists, what the browser can verify, and the resulting assurance level. “Custom URL” must not silently inherit the assurance of Tailscale Serve.

### Transport and deployment profiles under consideration

Transport reachability, destination ownership, caller identity, deployment isolation, and application authorization are separate properties. Different profiles can supply different subsets:

| Profile                                           | Reachability and identity characteristics                                                                                   | Agent Connect implications                                                                                                                                                                     | Status                                             |
| ------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------- |
| Localhost / same device                           | Loopback reachability strongly limits the network path; browser and connector run on one machine                            | Still needs a way to select the intended connector and authorize apps, but can support a deliberately lighter personal ceremony                                                                | Development and future personal profile            |
| Tailscale Serve                                   | Private tailnet HTTPS, destination node identity, ACL policy, and protected requester login forwarded to loopback           | Runtime card binds the endpoint to the user's connector key; Agent Connect adds per-app consent and grants                                                                                     | Implemented private reference profile              |
| Tailscale Funnel / public HTTPS                   | Public reachability and TLS to the node, but no private `Tailscale-User-Login` assurance                                    | Must not pretend to have a tailnet requester; relies on connector proof, device enrollment, exact frozen or approved app authority, grants, and stronger public-exposure hardening             | Implemented only for the restricted judge fixture  |
| VS Code or Microsoft Dev Tunnel                   | Candidate account-backed tunnel with Microsoft-authenticated provisioning and a stable public URL                           | Needs investigation into which destination/caller identity assertions are available to the browser and connector; could reduce custom tunnel setup without replacing Agent Connect app consent | Planned research profile                           |
| Generic public reverse tunnel or custom HTTPS URL | Usually proves control of a hostname/certificate, not that the endpoint belongs to this user or that callers are authorized | Runtime-card key binding and connector-hosted enrollment become essential; public abuse controls and confinement matter more                                                                   | Advanced future profile, not automatically trusted |
| Account-backed Agent Connect directory or relay   | A service could bind a connector public key and endpoint to an authenticated user account                                   | Could improve discovery, recovery, multi-device UX, and destination-ownership evidence while leaving application grants connector-owned                                                        | North-star option, not implemented                 |
| Packaged cloud VM or long-running container       | Internet-reachable user-owned deployment with reproducible packaging                                                        | Needs deliberate credential injection, persistent connector identity, updates, audit, and a named transport profile                                                                            | Planned appliance direction                        |
| Ephemeral on-demand cloud runner                  | Short-lived isolated agent execution, potentially created per session or task                                               | Connector/control-plane identity may remain durable while workspaces, agent processes, and credentials are brokered into disposable runners                                                    | Longer-term confinement/deployment direction       |
| Managed connector/runtime                         | Provider operates reachability and execution                                                                                | Can offer stronger account identity, policy, updates, and possibly attestation, but changes the trust and business boundary from purely self-hosted                                            | Possible future provisioning profile               |

The common requirement is explicit assurance. Every profile must state what is known about the destination, what is known about the caller, what the browser can verify, what the connector enforces, and which claims come only from the downstream runtime.

## Public hackathon judge profile: same boundaries, different identity source

The public judge demo exists so judges install nothing and do not join the owner's tailnet.

```text
Firebase Canvas
    |
    | public HTTPS, exact Origin
    v
Tailscale Funnel :10000
    |
    | loopback proxy
    v
one disposable judge appliance container
  Agent Connect gateway + authorization UI
  separate connector state volume
  OmniGENT server and host
  deterministic ACP agent
  request-scoped MCP relay
  tmpfs home/temp/workspace
```

Funnel is public HTTPS transport. It does not inject the private `Tailscale-User-Login` guarantee. The `public-demo` profile therefore uses an internal public-demo principal only after connector-key proof, high-entropy passphrase enrollment on the connector origin, an enrolled-device cookie, exact configured app/callback/tool authority, PKCE, and an app grant. It never fabricates a Tailscale user identity.

The entire public stack runs in one container as an unprivileged user with a read-only root filesystem, default seccomp, all capabilities dropped, `no-new-privileges`, bounded PIDs/CPU/memory, loopback-only publishing, isolated tmpfs scratch paths, and no host home, repository, Docker socket, SSH material, Codex credential, or model credential. Processes inside the disposable appliance are not isolated from one another. This is a practical hackathon boundary, not a TEE.

The public runtime is honestly deterministic. It contains three Codex-authored recorded plans—one for a project board, one for document review, and one for product research. It still exercises the real browser SDK, authorization, gateway, OmniGENT, ACP, request-scoped MCP, browser tool, result-return, and visible-mutation path. It does not perform live model reasoning and must never be labeled as live Codex.

The separate private proof completed the same composition with real Codex. The two profiles share control and data boundaries but provide different runtime and transport evidence:

- **Private composition proof:** real Codex through OmniGENT; personal credentials; Tailscale Serve; current runtime sandbox is transitional.
- **Public judge fixture:** deterministic ACP; no model credential; Tailscale Funnel; disposable container; safe free judging path.

## The current demo proof

The public demo exercises the following product behavior:

1. a visitor imports the public runtime card;
2. the SDK verifies connector identity and completes device enrollment and application authorization when required;
3. one application grant authorizes the exact fixed nine-tool snapshot;
4. the visitor selects a project-board, document-review, or product-research scenario and sends a prompt;
5. the deterministic ACP fixture follows the corresponding Codex-authored recorded plan;
6. real tool requests cross OmniGENT, the gateway, and SDK into browser-owned handlers;
7. the selected application mutates its own state and returns correlated tool results;
8. the task completes through the same protocol path;
9. the connector can list and revoke the application grant, after which reuse is rejected.

### Three example applications and nine tools

**Northstar project board**

- `create_project_tasks`
- `update_project_tasks`
- `move_project_tasks`

**Fieldnotes document review**

- `add_document_comments`
- `replace_document_text`
- `format_document_blocks`

**Everyday product research**

- `add_product_assessment`
- `add_price_comparison`
- `add_product_alternatives`

The public grant authorizes one frozen superset of all nine tools so switching scenarios does not require repeated consent. The deterministic fixture selects the corresponding recorded three-tool plan. Product prices and sources are recorded, not live web research.

## Current security and confinement truth

Authentication and consent are implemented; safe arbitrary-app runtime confinement is not.

An authenticated and approved application must still be treated as adversarial. It may send malicious prompts, misleading tool schemas, hostile tool results, or requests intended to consume subscription capacity. Agent Connect prevents it from broadening the declared application tool snapshot and separates app-tool results from runtime-native approvals, but the runtime adapter owns filesystem, shell, network, process, credential, MCP, plugin, skill, and native-tool enforcement.

The private reference path uses OmniGENT with `codex-acp`. Codex's own default agent mode supplies a workspace-write sandbox, network-disabled sandboxed commands, and on-request approvals, but ambient Codex configuration, MCP servers, plugins, skills, copied credentials, or same-user host access can still create authority. The current private composition proof must be described as transitional, not a secure arbitrary-app sandbox.

A Bubblewrap experiment successfully established an outer boundary with `NoNewPrivs`, seccomp, a guarded read-only workspace, dedicated writable Codex home, and a host sentinel, but the dynamic OmniGENT-to-Codex MCP child failed to start inside that composition. It also did not solve exposure of copied Codex credentials to a network-capable process. Bubblewrap is evidence, not the default profile.

The preferred deployment-hardening direction is a reproducible connector appliance, eventually with a separate ephemeral runner container per downstream session, controlled mounts, deliberate credential injection or brokerage, and controlled egress. Containers simplify the boundary and installation story; they do not automatically prevent credential exfiltration or prove host integrity.

Agent Connect can report runtime posture with an honest evidence source:

- connector-configured;
- runtime-reported;
- observed by a named probe;
- externally attested.

It cannot remotely prove arbitrary self-hosted sandbox enforcement merely because the same connector signed a `sandboxed: true` claim. Connector identity proves who made the statement, not whether the statement is independently true.

## Intended future architecture

The intended architecture preserves the Agent Connect control plane while allowing both the application protocol and runtime adapter to change.

```text
web application
  app UI, app data, app-owned tools
  @agent-connect/web
           |
           | chosen application protocol profile
           | leading candidate: standard AG-UI events + frontend tools
           | Agent Connect identity/authorization outside the event schema
           v
Agent Connect gateway / control plane
  runtime-card enrollment and connector-key continuity
  transport trust profile
  connector-owned OAuth-style application authorization
  origin/app/scope/tool/expiry-bound grants
  opaque logical sessions
  stable action IDs and durable unresolved-action recovery
  revocation, audit, budgets, and policy ceilings
  provider-neutral posture vocabulary
           |
           | narrow provider adapter
           +----------------------+-----------------------+
           |                      |                       |
           v                      v                       v
     OmniGENT adapter       direct ACP adapter      another provider
           |                      |                       |
           | normalized          |                       |
           +----------------------+-----------------------+
                                  |
                                  | preferred downstream harness boundary: ACP
                                  v
                         Codex / Claude Code / other agent
                                  |
                                  | temporary app capabilities
                                  v
                       frontend tool call returns to app
```

### AG-UI: leading candidate for the application-facing language

AG-UI is an open event protocol between user-facing applications and agent backends. It already models runs, threads, messages, streamed text, lifecycle events, frontend-defined tools, correlated tool calls, tool results, state, and human-in-the-loop interactions. Its frontend-tool model closely matches Agent Connect's central capability.

A conceptual mapping is:

| Current Agent Connect event | AG-UI concept                  |
| --------------------------- | ------------------------------ |
| `task.started`              | `RUN_STARTED`                  |
| `text.delta`                | text message start/content/end |
| `tool.requested`            | tool-call start/arguments/end  |
| browser handler result      | tool-result message            |
| `task.completed`            | `RUN_FINISHED`                 |
| `task.failed`               | `RUN_ERROR`                    |
| logical session             | thread                         |
| active task                 | run                            |

AG-UI does **not** launch Codex, supervise agent processes, bridge Codex authentication, own a workspace, provide connector enrollment, establish that a URL belongs to the user, define per-Origin consent, sender-bind tokens, persist unresolved side effects, or supply sandbox guarantees. Those remain Agent Connect and runtime-adapter responsibilities.

The candidate composition is:

```text
browser -- standard AG-UI subset + Agent Connect security --> gateway
gateway -- OmniGENT provider adapter --> OmniGENT
OmniGENT -- ACP --> codex-acp --> Codex app-server --> Codex
```

AG-UI has not been adopted. The project must first prove official client interoperability, frontend tools through the live Codex loop, stable action/recovery mapping, and a smaller provider-neutral browser implementation without forking AG-UI schemas.

### ACP and MCP-over-ACP

ACP remains the preferred downstream harness interface between a conductor and coding agents. OmniGENT already uses generic ACP toward `codex-acp` in the working implementation.

An earlier architectural direction imagined ACP over WebSocket from the application side and a narrow MCP-over-ACP channel carrying one application-owned MCP server. A deliberately narrow experimental profile includes one authenticated connection, one agent session, one fixed tool set, and nested MCP `initialize`, `ping`, `tools/list`, and `tools/call` behavior.

MCP-over-ACP is unstable and must not be presented as a current stable standard. ACP session loading also does not automatically replay in-flight transport requests, so durable unresolved actions remain a gateway responsibility. The browser-facing role may ultimately be better served by AG-UI, while ACP remains downstream. A direct ACP browser adapter can still exist as an explicit experimental profile for ACP clients.

### Other providers

A second harness should usually implement only this narrow internal provider contract:

```text
create or recover provider session
stream task with fixed application tools
submit correlated application-tool result
cancel
emit text, tool request, completion, failure, or cancellation
```

It should not reimplement runtime enrollment, connector OAuth, Origin grants, browser tools, or revocation. Supporting OpenClaw or another conductor is a future proof of this boundary, not a committed dependency.

## Durability and reliability roadmap

The next reliability boundary is not “replay every token.” It is preserving unresolved application side effects correctly.

Target sequence:

1. persist an application tool request before notifying the browser;
2. give it a stable action ID;
3. distinguish conversation resumption from unresolved-action delivery;
4. after reconnect, list or redispatch the unresolved action with the same ID;
5. require idempotent handlers or application-owned deduplication;
6. record the result before resuming the downstream agent;
7. persist logical-to-provider mappings so an unhealthy runner can be replaced without exposing provider IDs.

The intended reliability model uses explicit pending, delivered, applied, acknowledged, and resumed states rather than claiming generic exactly-once execution.

## Implementation status summary

- **Implemented now:** neutral public task/tool types, connector key and runtime card, signed challenge, passphrase device enrollment, connector-owned consent, PKCE, bearer grant, exact Origin/app/scope/tool bindings, revocation, opaque sessions, OmniGENT provisioning and healing, real Codex composition proof, deterministic public judge appliance, nine browser tools, and live browser mutation choreography.
- **Current provider-specific seam:** the browser package still contains an `OmnigentProvider` and uses gateway-proxied OmniGENT-shaped routes internally.
- **Proposed or pending:** AG-UI application-facing adapter, dynamic unknown-Origin enrollment, DPoP/app-instance keys, durable pending actions and provider mappings, audit and usage ceilings, a reproducible general connector appliance, separate ephemeral runner containers, and a second provider.
- **Experimental or unstable:** direct ACP browser profile, WebSocket ACP transport, MCP-over-ACP subset, and the Bubblewrap dynamic-tool sandbox.
- **Not claimed:** generic OAuth conformance, generic AG-UI conformance, stable MCP-over-ACP conformance, exactly-once side effects, verified arbitrary-host sandboxing, live model reasoning in the public judge fixture, or that authorization makes an application trustworthy.
