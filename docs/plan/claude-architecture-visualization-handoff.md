# Claude handoff: Agent Connect architecture visualization

Date: 2026-07-18

Purpose: self-contained product, architecture, security, protocol, and visual-design brief for an external designer who does not have repository access.

## Your assignment

Design a substantial technical deep-dive section for the Agent Connect demo page. It appears after the hero, working demo applications, live tool-call choreography, browser SDK example, and gateway setup. By this point the visitor already understands the high-level promise: a web app lends tools to a user-owned coding agent through Agent Connect.

This section should now explain, in meaningful detail:

1. the architecture that works today, including the SDK, gateway, Tailscale trust profile, OmniGENT conductor, ACP adapter, Codex, and request-scoped application tools;
2. the connector bootstrap and OAuth-style application-authorization flow, including how the app and connector authenticate each other;
3. the live prompt, tool-request, browser execution, and correlated-result loop across those components;
4. the implementation-specific seams and security limitations that remain today;
5. the intended future architecture in which the Agent Connect control plane stays stable while the browser protocol, provider, coding agent, deployment, and confinement profile become more standardized or interchangeable.

The goal is not to repeat the simple three-actor hero diagram. It is to reward a technically curious judge with a clear “where the project is now, what is deliberately temporary, and where it is going” explanation.

The output should make a technically sophisticated hackathon judge understand both the simplicity of the application integration and the seriousness of the system beneath it. It must not make unimplemented standards or security claims.

Create a design that can eventually react to real application events. A self-contained HTML preview plus portable source is ideal. The actual demo is framework-light Vite, TypeScript, HTML, and CSS, so dependency-free SVG/CSS/Web Animations code is easiest to integrate. A React prototype is acceptable if the visual structure and timing are easy to port and the deliverable also contains a rendered standalone preview.

## Narrative role: explain “now” and “next” without flattening them

This is intentionally the technical section of the page. OmniGENT, ACP, AG-UI, PKCE, Tailscale Serve and Funnel, request-scoped MCP, opaque sessions, provider adapters, and confinement boundaries may all appear where they explain the system. The page has already demonstrated the product before asking the visitor to learn these names.

The hierarchy should come from architectural status rather than from hiding detail:

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

These experimental items should remain visibly labeled, but they do not need to disappear. Use them to show informed direction rather than presenting them as shipped features. Low-level facts should earn their place by explaining a boundary, a current seam, or a future transition—not merely because they exist.

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

## The three human roles

### Application developer

Adds `@agent-connect/web`, declares typed application-owned tools, connects to the runtime card supplied by the user, sends prompts, consumes task events, and implements the actual mutations. The developer should not need to understand OmniGENT sessions, Codex app-server, ACP process lifecycle, Tailscale headers, or connector state.

### Agent owner / user

Runs or selects an Agent Connect gateway beside an agent they own. They bootstrap the connector once, save its public runtime card and private enrollment passphrase through a trusted personal channel such as a password manager, and approve applications through a connector-owned page. They choose and secure the runtime environment.

### End user inside the web application

Imports or selects their runtime, approves the application's requested authority, then uses app-native AI features. They should not install a per-app MCP server, restart OmniGENT, copy provider session IDs, or SSH into the runtime for every new application.

Often the agent owner and the end user are the same person, but the architecture should not visually collapse their distinct responsibilities.

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

These are separate layers and should be drawn separately.

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

Authorization proves that the user knowingly gave this Origin the displayed authority. It does not make the application trustworthy. A malicious or compromised authorized app can send adversarial prompts and tool descriptions, consume the user's subscription, try to induce data exfiltration, or exploit ambient runtime authority. The consent design must state that clearly.

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

The separate private proof completed the same composition with real Codex. A useful diagram may show these as two deployment badges over the same control/data boundaries:

- **Private composition proof:** real Codex through OmniGENT; personal credentials; Tailscale Serve; current runtime sandbox is transitional.
- **Public judge fixture:** deterministic ACP; no model credential; Tailscale Funnel; disposable container; safe free judging path.

## The current demo surface

The demo is both a working application and the project's primary explainer. It currently contains:

1. a hero with the claim “Let Codex work inside your app”;
2. a compact three-actor microflow: Web app → Agent Connect → Coding agent, with tool calls and responses returning;
3. a runtime-card connection and authorization workbench;
4. three embedded, visually independent example applications;
5. an event-driven session activity feed and raw event disclosure;
6. a “two pieces, two owners” SDK/gateway responsibility explanation;
7. a browser SDK code example;
8. an animated terminal showing the current source-based gateway startup.

The architecture section you are designing should deepen the page after the working proof. Do not rebuild the live demo or duplicate the small hero microflow. The new section should answer the questions the compact hero deliberately leaves open: What is really running? Who owns what? How does trust bootstrap? Where does OAuth-style authorization happen? Why can tools travel backward? What is provider-specific today? What remains stable when the protocols change?

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

The public grant authorizes one frozen superset of all nine tools so switching tabs does not require repeated consent. The deterministic fixture selects the corresponding recorded three-tool plan. Product prices and sources are recorded, not live web research.

### Existing live motion

Real `tool.requested` events send one amber correlated call pill into the selected app. The app boundary illuminates, and the actual affected object animates: project cards pop/update/move using FLIP; document passages highlight/rewrite/reformat; product research panels and rows reveal. `tool.completed` changes the same pill and boundary to success or failure before the result returns.

Real runtimes emit calls rapidly, so the Canvas applies a presentation clock between yielded tool request and result events. Each real correlated request and result receives a minimum readable dwell before the task stream advances. No event is invented or reordered. Reduced-motion mode uses short static state holds without spatial movement.

The new architecture animation should complement this. It may reuse the same actor colors and action IDs, but should not compete with the embedded-app mutation choreography.

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

The future diagram should visually preserve the Agent Connect control plane while allowing both the application protocol and runtime adapter to change.

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

Do not visualize generic exactly-once magic. Visualize explicit pending, delivered, applied, acknowledged, and resumed states.

## Visual language already established

### Creative north star: The Open Workbench

The page should feel like a precise workbench in a bright studio: useful machinery is visible, every handoff is marked, and technical depth is progressively disclosed. It should feel effortless, trustworthy, refined, and technically compelling—not futuristic.

### Actor colors

Use these roles consistently:

```css
--background: oklch(1 0 0);
--surface: oklch(0.972 0.006 250);
--surface-strong: oklch(0.935 0.01 250);
--ink: oklch(0.2 0.018 250);
--muted: oklch(0.46 0.018 250);
--border: oklch(0.85 0.012 250);

--app-coral: oklch(0.56 0.16 32.1);
--connector-teal: oklch(0.43 0.09 190);
--agent-periwinkle: oklch(0.52 0.15 275);
--signal-amber: oklch(0.79 0.14 83);
--success: oklch(0.48 0.12 150);
--danger: oklch(0.5 0.18 25);
```

- Coral always means the application or an application-owned capability.
- Teal always means connector identity, gateway, authorization boundary, or verified trust state.
- Periwinkle always means the coding agent or downstream runtime.
- Amber means a request or handoff is in flight.
- Green means completed/applied.
- Red is only failure, revocation, or destructive warning.

### Typography

- Main family: Figtree Variable, falling back to `ui-sans-serif, system-ui, sans-serif`.
- Evidence/code family: IBM Plex Mono, falling back to `ui-monospace, monospace`.
- Prose explains; monospace proves.
- Labels use weight and proximity, not uppercase letter-spaced eyebrows.
- Body text should remain around 65–75 characters per line.

### Shape, spacing, and elevation

- Radii: 6px small, 10px controls, 14px major workbench/code surfaces.
- Spacing vocabulary: 4, 8, 12, 16, 24, 32, 48, 64, and 96px.
- Flat structural surfaces by default. Use dividers and tonal contrast before shadow.
- Maximum resting lift: approximately `0 6px 8px oklch(0.2 0.018 250 / 0.08)`.
- Do not pair decorative borders with large soft shadows.
- Controls use familiar product affordances and a minimum 44–48px touch target.

### Explicit anti-references

Do not create:

- a sci-fi command center;
- neon circuitry, holograms, glowing grids, or particle fields;
- a generic gradient-heavy AI startup page;
- glassmorphism;
- gradient text;
- cream/parchment AI-editorial styling;
- a terminal-first hacker aesthetic;
- a dense enterprise-security dashboard;
- endless identical cards;
- a static “three boxes with arrows” architecture chart;
- decorative looping motion unrelated to real states;
- hand-drawn or sketchy SVG illustrations;
- a diagram that implies every task always calls the same tools.

The page is mostly true white and cool neutral structure. Color communicates responsibility and state rather than decoration.

## Motion requirements

Animation must explain causality and direction.

Recommended semantic motions:

- **Runtime bootstrap:** a connector key and public runtime card emerge from the user-owned boundary; the private passphrase follows a separate protected path into the user's password manager.
- **Connector proof:** a nonce travels to the gateway; a signed response returns and locks the connector identity into a verified state.
- **Authorization:** app metadata and tool cards travel to the connector; the view changes origin; the user reviews and approves; a one-use code returns; PKCE exchange produces a scoped grant.
- **Prompt:** one packet moves app → gateway → conductor → adapter → agent.
- **Tool request:** direction reverses agent → adapter → conductor → gateway → app, carrying tool name and stable action ID.
- **App mutation:** the application surface changes itself.
- **Tool result:** the correlated result returns app → gateway → agent and the agent continues.
- **Provider swap / future architecture:** the Agent Connect security and control-plane frame remains fixed while the application protocol and provider tiles swap behind explicit adapter seams.
- **Failure:** motion stops at the responsible boundary and that boundary becomes the recovery focus; do not turn the entire page red.

Use 150–250ms for ordinary state transitions and roughly 300–500ms for spatial handoffs. For explanatory sequences, minimum readable dwell matters more than raw event speed. Rapid incoming events should queue, coalesce only when semantically safe, or fast-forward obsolete transit motion without dropping the final state. Never reorder correlated actions.

`prefers-reduced-motion` must remove moving packets and spatial travel. Show the same state changes, labels, ordering, and results instantly or with short crossfades. Motion must never be the only source of meaning.

## Suggested information architecture for the new section

This is a recommendation, not a rigid wireframe. The section may use several connected views because its purpose is a deep dive, but they should feel like one “current system → trust and execution → future system” narrative.

### View 1: “Reference architecture today”

A layered current-system diagram with visibly different ownership and deployment zones:

- third-party web application and `@agent-connect/web`;
- transport boundary and Agent Connect gateway;
- user-owned runtime boundary;
- OmniGENT conductor;
- ACP adapter;
- Codex or the deterministic ACP fixture;
- request-scoped MCP relay returning application tools to the browser.

Let visitors switch between “Private real Codex proof” and “Public judge fixture.” Keep shared layers fixed and animate the profile-specific transport, credential, runtime, and confinement pieces. Make the deterministic-fixture disclosure clear without implying that the private Codex proof is part of the public appliance.

### View 2: “Two-way trust and application authorization”

Show the complete ceremony in two phases:

1. **Set up the connector once:** it creates a runtime card and private enrollment passphrase; the user saves them through a trusted personal channel.
2. **Approve an application:** the app verifies a signed connector challenge before disclosure, redirects to the connector-owned page, the connector verifies its transport principal, the user reviews the exact Origin and tools, and Authorization Code + S256 PKCE returns a revocable scoped grant.
3. **Use it normally:** later tasks reconnect without SSH or restarting the agent until the grant expires, is revoked, or its requested authority changes.

Make both trust questions legible:

- connector asks, “Is this exact app allowed to use the agent?”
- app asks, “Is this the connector the user enrolled?”

Show that Tailscale provides the first trusted transport profile while Agent Connect—not Tailscale—owns connector enrollment and the application grant. Distinguish private Serve identity from public Funnel reachability.

### View 3: “One task across the current stack”

Animate one complete correlated turn through the components shown in View 1:

1. application sends a prompt;
2. gateway resolves an opaque logical session;
3. OmniGENT runs the downstream ACP agent;
4. agent requests an application tool through the request-scoped MCP relay;
5. `tool.requested` returns to the browser with a stable action ID;
6. the application executes and visibly mutates itself;
7. `tool.completed` and the result return to the same downstream turn;
8. the agent continues or completes.

Allow no tools, one tool, or multiple tools. The visualization must not imply a hard-coded linear pipeline even though the public judge fixture uses recorded Codex-authored plans.

### View 4: “Stable control plane, replaceable runtimes”

Use a current-to-future morph. Keep the web application's tool contract and Agent Connect's trust/control-plane frame visually fixed while the internal runtime stack changes.

- **Current reference:** browser SDK → Agent Connect gateway → OmniGENT → ACP adapter → Codex.
- **Future direction:** a standardized application-facing event profile may use AG-UI; provider adapters may target OmniGENT, direct ACP, or another conductor; ACP remains the preferred downstream coding-agent boundary.
- **Experimental only:** direct browser ACP/WebSocket and MCP-over-ACP may appear in a technical annotation, not as an equal or promised product path.

The visual takeaway is not “Agent Connect supports every agent today.” It is “applications integrate against a neutral boundary, and the current OmniGENT/Codex composition proves that boundary can work.” AG-UI and ACP should be shown at their different intended layers, not grouped together as interchangeable protocol logos.

### View 5: “What is proven, transitional, and proposed”

Apply an assurance/status legend to the architecture rather than presenting every box as equally finished:

- implemented and enforced by Agent Connect;
- current reference implementation but provider-specific;
- enforced by the selected transport/provider/runtime;
- observed or self-reported;
- experimental;
- planned;
- explicitly not claimed.

This can be a final overlay or scrubber that recolors/annotates the preceding diagrams. It should make the honest engineering boundary memorable: authorization is real; provider neutrality exists at the public API but still has an OmniGENT seam internally; public judging is isolated and deterministic; general runtime confinement and durable recovery remain future work.

## Real and proposed event hooks

The task stream already emits the real `AgentTaskEvent` union shown earlier. Connection and authorization lifecycle points exist in code but are not yet published as one dedicated visualization bus.

A future integration may expose:

```ts
type DemoFlowEvent =
  | { type: "connector.checking" }
  | { type: "connector.verified"; runtimeId: string; profile: string }
  | {
      type: "authorization.required";
      appId: string;
      origin: string;
      toolNames: string[];
    }
  | { type: "authorization.approved" }
  | { type: "authorization.revoked" }
  | { type: "runtime.connected"; label: string }
  | { type: "task.sent"; scenario: string; prompt: string }
  | AgentTaskEvent;
```

Potential dispatch shape:

```ts
window.dispatchEvent(
  new CustomEvent("agent-connect:demo-flow", { detail: event }),
);
```

Do not describe this event bus as implemented. Design the visual state machine so it can consume it later. The current activity feed is real and the tool choreography already consumes real task events directly.

## Required truth labels

The final design must make these distinctions clear:

- **Implemented now:** neutral public task/tool types, connector key and runtime card, signed challenge, passphrase device enrollment, connector-owned consent, PKCE, bearer grant, exact Origin/app/scope/tool bindings, revocation, opaque sessions, OmniGENT provisioning/healing, real Codex composition proof, deterministic public judge appliance, nine browser tools, live browser mutation choreography.
- **Current implementation seam:** browser package still contains an `OmnigentProvider` and gateway-proxied OmniGENT-shaped routes.
- **Proposed/pending:** AG-UI application-facing adapter, dynamic unknown-Origin enrollment, DPoP/app-instance keys, durable pending actions and provider mappings, audit and budgets, reproducible general connector appliance, separate ephemeral runner containers, second provider.
- **Experimental/unstable:** direct ACP browser profile, WebSocket ACP transport, MCP-over-ACP subset, Bubblewrap dynamic-tool sandbox.
- **Not claimed:** generic OAuth conformance, generic AG-UI conformance, stable MCP-over-ACP conformance, exactly-once side effects, verified arbitrary-host sandboxing, live model reasoning in the public judge fixture, or that authorization makes an app trustworthy.

## Deliverables requested from you

Please provide:

1. a polished desktop architecture section;
2. a separately composed mobile version, not merely a squeezed desktop diagram;
3. static states for current architecture, authorization, live tool loop, and future architecture;
4. animated transitions between those states;
5. a reduced-motion variant;
6. readable labels at actual page size;
7. a self-contained preview;
8. editable source with semantic component and event names;
9. a short integration note describing the state machine, dimensions/viewBox, timing, and where real events plug in;
10. any assets used, preferably none beyond CSS, fonts already listed, and inline SVG.

Prioritize clarity over density. The visual should reward a technically curious judge without requiring them to read every label before understanding the main relationships.

## Final design test

Because this section follows the high-level product proof, it does not need to teach the product from zero. After exploring it, a technically curious viewer should understand:

1. exactly how the current browser → gateway → OmniGENT → ACP → Codex composition works;
2. how dynamically supplied application tools return through MCP without advance per-app installation;
3. how connector identity, Tailscale transport, connector-owned consent, PKCE grants, and revocation divide responsibility;
4. why the public deterministic fixture and private real-Codex composition are related proofs but not the same deployment;
5. which OmniGENT-specific and in-memory seams remain today;
6. which security guarantees are implemented, provider-enforced, transitional, experimental, or not claimed;
7. how the stable Agent Connect control plane can survive future AG-UI, ACP, provider, agent, deployment, and confinement changes;
8. why AG-UI and ACP are candidates at different layers rather than competing names for one protocol slot.
