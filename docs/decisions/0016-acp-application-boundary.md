# ADR 0016: ACP application boundary and consent-enforcing ACP gateway

Status: accepted (2026-10-04); the owner selected ACP as the current product vision and open, still-evolving standard, filling the role Open Responses had in the earlier direction. Protocol instability remains explicit; publication requires separate owner authorization.

Date: 2026-09-30. The owner selected ACP
as the product direction and retired the superseded plugin implementation on
2026-10-03. [ADR 0010](0010-open-responses-gateway-pivot.md) and
[ADR 0015](0015-openclaw-plugin-host.md) preserve historical context.
The owner accepted the ACP decision on 2026-10-04. Publication remains an owner gate.

Evidence: [ACP gateway spike results](../archive/experiments/acp-gateway.md).

## Context

Agent Connect lets an application borrow the agent its user already has. The
user brings the agent; the application brings the UI and its own tools, under
scoped, revocable consent.

The current release does not deliver that for coding harnesses:

- The Agent Connect plugin delegates execution to OpenClaw's `/v1/responses`.
  In OpenClaw 2026.9.1, caller-supplied Responses tools work only on the
  built-in runtime, so the managed agent was pinned to it.
- Native tools are denied and sandboxing is off. Applications therefore reach
  a model loop with their own tools, not Codex or Claude Code with their
  capabilities.
- OpenClaw's alternatives do not close the gap. Plugin tool names are fixed in
  the installed manifest. Outbound MCP connections carry no session identity.
  An active OpenClaw sandbox disables Codex's user MCP servers.

The deeper mismatch: Open Responses models an application tool as the end of a
turn, while harnesses call tools inside their loop.

The Agent Client Protocol (ACP) is the protocol editors use to drive
user-owned agents, which is Agent Connect's relationship. Since ADR 0010 it has
gained what a web application needs:

- remote HTTP/WebSocket transport (active since 2026-07-02);
- MCP-over-ACP, through which a client offers its own tools over the
  connection (unstable);
- proxy chains;
- official Rust and TypeScript SDKs;
- maintained adapters for Codex, Claude Code and other harnesses.

## Decision

1. **Application wire: ACP over WebSocket.** Applications speak ACP v1 and
   offer their tools as one MCP-over-ACP server, declared in session setup.
   MCP-over-ACP is unstable and is labeled so in every public API and
   document.
2. **Agent Connect is a consent-enforcing ACP proxy.**
   - The gateway serves owner sign-in, application consent and grant management.
     Applications pair using pushed authorization requests and OAuth code +
     S256 PKCE, bound to their exact origin, same-origin redirect and gateway
     resource. No owner copies a bearer out of a file.
   - Consent fixes the complete tool definitions and an explicit access duration.
     Five-minute access tokens and rotating refresh tokens share a stable grant
     identity; refresh replay revokes the grant. Owner revocation and policy
     changes invalidate active and detached authority.
   - Owner passphrases and optional enrolled TOTP are separate from application
     grants. An application grant cannot create owner authority or approve grants.
     Owner state and configuration must remain outside the shared harness home.
   - WebSocket access checks the exact `Origin` and grant-bound access token
     offered as a subprotocol and the configured entry point used for pairing.
     Each configured entry point has origin-bound issuer, owner session and
     grant authority; proxy forwarding cannot mix them. Static bearer setup is an explicit headless/CI
     escape hatch, outside hosted pairing and individual grant management.
   - Its policy proxy is default-deny in both directions. It uses only generic
     ACP and MCP-over-ACP messages, and owns every authority-bearing field:
     client capabilities, `cwd`, MCP server declarations, mode and model.
   - It admits application tools only against the consented snapshot.
   - It answers harness permission prompts from the gateway profile, never
     through the application.
   - It restricts session load and resume to sessions the grant created.
   - Installation and operation belong to the product CLI: guided `setup`,
     read-only `doctor`, user-service lifecycle commands and anonymous minimal
     `/healthz`. Explicit setup upgrade replaces the release image and owned
     service executable while preserving private state; changed harness authority
     requires application reapproval. Plugin users initialize a fresh ACP runtime.
   - The owner console manages live sessions, individual/all grants, browser
     sign-out and configured entry points. Consent fixes a supported profile as
     well as the tools: Codex native read-only restricts native writes but still
     permits native reads and approved application-tool effects. Unsupported
     permission policies cannot be presented as native confinement.
   - Lost TOTP recovery is an explicit offline owner CLI operation under the
     exclusive authorization-state lock. It preserves the passphrase and grants
     and records bounded recovery metadata. App credentials provide no recovery
     authority. Remote recovery codes and mobile push approval remain deferred.
3. **Execution: unmodified ACP adapters.** The owner selects the harness.
   Adapters run behind the official MCP-over-ACP polyfill. No adapter is
   forked or patched.
4. **Isolation: one disposable container per session.** The box holds the
   polyfill and the adapter. Its only network exit is an egress proxy that
   refuses private, reserved, metadata and tailnet destinations. Inside the
   box the harness may use its native tools freely: the box, not permission
   prompts, bounds native actions.
5. **Sessions outlive sockets.** Each chain runs in a gateway-owned session
   host. A client that opts into Agent Connect's `agent-connect.resume.v1`
   WebSocket subprotocol can reattach after a dropped socket, within a bounded
   grace period. It must present the same grant, origin and resume token.
   Sequence-acknowledged frames are resent in both directions, so an in-flight
   turn and its application tool calls survive a phone backgrounding the page.
   Past the grace or retention bound, clients fall back to ACP v1
   `session/load`, and interrupted turns are not re-sent. This extension is not
   an ACP standard. It should retire once ACP v2 defines stream resumption.
   Plain `acp.v1` clients keep per-socket sessions.
6. **Implementation and distribution.** The gateway is Rust, on the official
   ACP Rust SDK. It ships as a prebuilt binary for a small target matrix,
   primarily through npm, because the adapters already require Node. The
   browser SDK stays TypeScript, on `@agentclientprotocol/sdk`.
   `@open-agent-connect/web` adds the connection, grant, resumable transport,
   tool server and chat state that the ACP SDK lacks. It integrates with the
   AI SDK at the UI layer (a `useChat` `ChatTransport`), not as a
   `LanguageModel`, because a harness runs its own loop. See the
   [release plan](../install/README.md).
7. **Unchanged principles.** Owner consent with OAuth/PKCE, revocable grants,
   immutable tool snapshots, stable action IDs, no automatic replay of
   ambiguous effects, and no claim of exactly-once execution.

## Consequences

Gains:

- Applications get the owner's real harness, with its web search, code
  execution and model, next to their own tools.
- Tools reach the model under their real names and schemas.
- Any ACP harness can sit behind the gateway without a translation layer.
- Progress rendering uses generic ACP `session/update` items.

Costs and risks:

- Applications lose drop-in Open Responses compatibility and the AI SDK
  `LanguageModel` path (`streamText` running the tool loop in the browser).
  AI SDK UI applications keep `useChat` through an ACP `ChatTransport`.
  Direct-provider paths, such as Bookhand's direct Open Responses connection,
  remain separate.
- The product depends on an unstable MCP-over-ACP RFD, and on MCP protocol
  generations interoperating (spike finding 3).
- OpenClaw leaves the execution path. The installation and hosting story, and
  the approved product direction uses the standalone gateway, while the previous
  plugin remains available until a separate retirement decision.
- Agent Connect owns a small non-standard transport extension for mobile
  resilience until ACP v2 stream resumption exists.
- Harness tool calls have a default ceiling of about 300 s. Long human waits
  need progress notifications or a receipt-and-follow-up pattern.
- Per-session images are large (about 2 GB unpacked), although runtime cost is
  small (about 0.6–1.5 s start, 80–190 MiB per session).

## Prerequisites before acceptance

- **Provider terms.** Anthropic's Claude Code terms allow an end user to sign
  in to unmodified Claude Code with their own subscription. They prohibit
  third-party developers from routing requests through Free, Pro or Max
  credentials on their users' behalf, and they point Agent SDK products to API
  keys. Get Anthropic's answer on whether an application driving the owner's
  own Claude Code through Agent Connect is permitted. Until then, label the
  Claude Code harness as unconfirmed. The current implementation never
  forwards API-key variables into boxes. OpenAI
  publicly supports ChatGPT-plan use in third-party tools. See the [credentials
  plan](../plan/credentials.md).
- **Credential boundary.** Use the owner's subscription without copying the
  owner's personal login, and without breaking refresh-token rotation for the
  owner's other sessions. The proposed direction is a dedicated Agent Connect
  login per harness, made once through the provider's own flow, in a shared
  home that every box mounts. Credential exposure to the harness's shell is
  accepted and documented ([credentials
  plan](../plan/credentials.md)).
- **Hosting and installation.** What the owner installs and runs. The
  [release plan](../install/README.md) proposes a prebuilt binary
  through npm and GitHub Releases. The implementation removes the superseded plugin. Owner-only post-publication npm retirement is recorded in the release checklist.
- **Consent code.** The Rust gateway now implements hosted owner consent,
  OAuth/PKCE, refresh, revocation and optional TOTP, following ADR 0009/0014/0015
  semantics. Automated browser composition and independent security review are
  required; live owner verification remains a release prerequisite.
- **Session isolation.** A per-session internal network. The dedicated shared harness home restores conversations after a
  box is gone, but exposes transcripts across grants. Live credential checks
  remain a release prerequisite.
- **Mobile.** One manual iOS Safari check of the resumable transport.
- **Migration.** Applications move to AI SDK `useChat` over the root SDK's ACP transport ([release
  plan](../install/README.md)). The SDK's MCP server answers unknown
  methods with method-not-found and sends progress while it waits.

## Alternatives considered

- **Keep Open Responses through OpenClaw's built-in loop.** This is the status
  quo, a model loop without harness capabilities.
- **Upstream harness-neutral client tools in OpenClaw.** A larger upstream
  feature; it would still bridge a turn-ending wire to in-loop tools.
- **OpenClaw MCP route with a session-identity header.** A small upstream ask
  that gives real tool names, but conflicts with OpenClaw disabling Codex MCP
  servers inside a sandbox.
- **Return to Omnigent.** Its July spike proved the MCP relay, but it is a
  private session API that ACP now standardizes.
- **AG-UI.** It is widely adopted, but it models the application developer's
  own agent, and its frontend tools end the turn like Responses.
