# Plan: shipping the ACP gateway and its browser SDK

Status: unreleased candidate 0.0.1; hosted authorization implementation updated 2026-10-03. Publication depends on accepting
[ADR 0016](../decisions/0016-acp-application-boundary.md). Nothing here is
released; the SDK candidate is independently versioned at 0.0.10. Evidence comes from the
[ACP gateway spike](../archive/experiments/acp-gateway.md) and its
[mobile follow-up](../archive/plans/acp-gateway-mobile-resume.md).

The plan covers three questions:

- how an application drives a chat over ACP;
- what `@open-agent-connect/web` must add on top of the ACP SDK, including AI
  SDK support;
- how the Rust gateway is packaged with the ACP SDK.

## How a chat runs over ACP

The application page is the ACP **client**. The harness adapter
(`codex-acp`, `claude-agent-acp`) is the ACP **agent**. The gateway is an ACP
proxy between them: it authorizes the socket and filters every message. This is
the same relationship an editor such as Zed has with an agent, with the page in
the editor's place.

The client drives. One chat is:

1. **Consent and connect.** An explicit application action starts gateway-hosted
   owner sign-in and exact-origin OAuth consent for the fixed tool snapshot.
   The page exchanges a single-use PKCE code for a short-lived access token and
   rotating refresh token, then opens the gateway WebSocket and sends `initialize`.
   Default SDK resume only reuses/completes a grant; it never opens consent.
2. **Start.** `session/new` declares the page's tools as one MCP-over-ACP
   server. The gateway overwrites `cwd`, mode, model and every other
   authority-bearing field. The result is a `sessionId`.
3. **Send a message.** `session/prompt` carries the user's new message only.
   The harness owns the conversation history, its model, and its loop.
4. **Stream.** While the turn runs, the agent sends `session/update`
   notifications: message chunks, thought chunks, tool calls and their status,
   and plans.
5. **Application tools.** When the model calls one of the page's tools, the
   page receives an MCP `tools/call` request over the same connection, runs its
   handler, and answers it. The turn continues inside the harness. The gateway
   admits only tools in the consented snapshot.
6. **Native tools and permissions.** The harness's own tools (shell, web
   search, file edits) run inside the session box. Permission requests are
   answered by the gateway profile and never reach the page.
7. **Finish.** The `session/prompt` response carries a stop reason. Stop
   sends `session/cancel`. A later message is another `session/prompt` on the
   same session. A returning page uses `session/load`.

Open Responses works the other way round. There, a tool call ends the HTTP
response, and the caller, such as the AI SDK, runs the tool loop and sends the
result in a new request. Over ACP, the harness runs the loop, and a tool call
is a request that the page answers while the turn stays open.

The ACP TypeScript SDK (`@agentclientprotocol/sdk`) provides only the typed
JSON-RPC connection: it sends requests and dispatches the agent's requests and
notifications to handlers. It has no chat state, tool registry, schema
validation, reconnect, grant handling or error model. Those are what the
Agent Connect SDK adds.

## Browser SDK: `@open-agent-connect/web` over ACP

Applications use the Agent Connect SDK, not the ACP SDK directly. The spike
page used the ACP SDK directly, and needed about 280 lines of glue for one
chat with three tools.

The root package exposes `connectAgent`, `createAcpPairing`,
`createAcpChatTransport`, WebMCP snapshots and CSP-safe tool definitions. Tool
execution is internal to the ACP chat transport. The generic session executor,
headless chat presenter and previous model/authorization clients are removed.

Pairing uses owner-hosted consent, exact-origin fixed-tool grants and rotating
session credentials. Sequence reattachment preserves ongoing turns; explicit
history recovery never retries an uncertain prompt or effect. Every ACP-facing
export remains experimental while MCP-over-ACP is unstable.

## AI SDK

Use AI SDK `useChat` with `createAcpChatTransport({ provider, tools })`.
ACP exposes session/prompt and application tools rather than a LanguageModel.
Send only the latest deliberate user message. The harness owns history and its
tool loop; browser UI history is never replayed, and AI SDK tool callbacks must
not execute the same application tools a second time.

## Packaging and installation

The gateway, platform packages and session image share version `0.0.1`;
the root SDK is independently versioned at `0.0.10`. Operators need only Node 24 and Docker, not a checkout or
compiler. The [install guide](../install/README.md) covers npm, checksum-verified
GitHub archives/shell installer, sample SDK tarball, private setup, dedicated
login, egress, upgrade, revoke and uninstall.

The primary npm package is a small launcher plus optional per-platform binaries.
npm selects the matching executable and records integrity without a runtime or
postinstall binary download. Adapter/native CLI versions are pinned in the
launcher metadata and matching session-image manifest; they run inside Docker
rather than being duplicated on the host. cargo-dist produces archives,
SHA-256 checksums and a shell installer. Its generated npm installer was compared
in the earlier dry run; wrapper tarball sizes were not a total disk-size comparison.

Supported targets are `aarch64-apple-darwin`, `x86_64-unknown-linux-musl`, and
`aarch64-unknown-linux-musl`. Windows is not yet supported. The session image
builds for `linux/amd64` and `linux/arm64`; published gateway binaries embed its
immutable registry digest. Local-only candidates embed the explicit local tag
and cannot be promoted by the publish script.

The [protected manual release workflow](../../.github/workflows/acp-release.yml)
uses cargo-dist's local/global split, trusted npm publishing with OIDC/provenance
and an ephemeral GHCR job token. It defaults to no-write dry runs. Actual
publication requires an accepted ADR, an already owner-pushed exact version tag
and the protected environment. Ordinary PR/main CI never publishes. See the
[release guide](../install/release.md) for setup and concrete artifact commands.

## Hosted owner authorization

The owner-approved direction replaces the manual bearer proof of concept in the
normal product path; ADR 0016 remains proposed. Owner sign-in is separate from
provider login and from application tokens. `init` stores an Argon2 passphrase
hash in private `state/auth` state; optional TOTP enrollment requires fresh codes
at subsequent login and each approval. Owner pages and OAuth share the exact
`public_url` origin with `/acp`, including through a reverse proxy. Cookie,
CSRF and anti-framing protections guard owner forms. Owner secrets are outside
the shared harness home and are not mounted into sessions.

Consent shows the app origin, full fixed tools and native boxed authority.
The owner chooses 1 hour (default), 1 day, 7 days or 30 days of access. Requests
expire after ten minutes, authorization codes after two minutes, and access
tokens after five minutes. Refresh tokens rotate within the selected grant
lifetime; detected reuse revokes the grant. A stable grant ID owns sessions
across access-token rotation. Revocation and expiry stop active/detached
authority within one second, with per-frame checks dropping unauthorized
traffic. Operator policy fingerprint changes invalidate existing grants.
No refresh, recovery or new consent replays an uncertain prompt or effect.

Mobile browsers can use the explicit redirect flow. A separately paired mobile
approval client is a follow-up design, not an implemented app; see the
[credential plan](acp-gateway-credentials.md#mobile-owner-approval-follow-up).
Hosted authorization has separate deterministic, browser and packaged acceptance
evidence; earlier static-bearer spike results do not prove hosted pairing. No
automated check establishes a subscription-backed authorization flow.

## Completed implementation

The first five phases implemented the product crate, dedicated homes/login,
local packaging, resumable SDK/provider and AI SDK chat transport.
The product-completion work then delivered, in order:

1. ACP-only root SDK, transport and fixed-tool execution;
2. packaged gateway CLI, private config/init and owned egress management;
3. installation/operator instructions using release artifacts;
4. locally validated release/PR workflows, independent SDK/gateway versions, checksums and image builds;
5. artifact-only clean-room sample acceptance wired into `npm run verify`;
6. reconciled product/status guidance with the ACP-only product boundary.

The clean-room test installs the packed launcher/platform package and SDK in a
fresh container without a checkout, builds the sample through public exports,
and exercises browser owner denial/approval, refresh rotation and owner/app
separation, then a real pinned Codex adapter turn and owner grant revocation.
It checks read/highlight exactly once, reconnect
during a held app tool on the same session without duplicate submission, and Stop
without a follow-up model request. It also restores the actual browser
back/forward cache while idle and while an app tool waits, preserving the session
without replay. A gateway-only teardown gate checks owned resource removal before
fallback cleanup, including shutdown during allocation and uncertain Docker-create
responses. Release hashes are verified before installation.
It uses a deterministic model and temporary homes; it never logs in or spends
subscription allowance. Both adapters also retain their host/boxed scenario gates.
Native plan UI conversion is contract-tested; pinned fixtures expose no native
plan tool. Results are recorded in [the experiment](../archive/experiments/acp-gateway.md).

## Owner gates

ADR 0016 acceptance, registry permissions, release workflow invocation,
publication and retirement of old npm versions are owner-run actions. See
[current work](current-work.md) and [release checklist](../install/release.md).
The gateway/image and SDK have independent 0.0.x versions.

## Authorization quality gate and independent hardening (2026-10-03)

Hosted owner authorization follows [ADR 0016](../decisions/0016-acp-application-boundary.md)
without accepting it. Required local evidence covers approve/deny, exact origin,
PKCE/replay, refresh rotation/expiry/revocation, fixed full tool definitions,
owner/app credential separation, CSRF, optional TOTP and safe page error states.
The artifact-only browser test must complete real owner consent before its app
connects; copied static tokens cannot satisfy this gate.
The same artifact gate must exercise unattended setup planning/application,
doctor, offline service definition lifecycle where a user manager is unavailable,
real session/end-session controls, revoke-all and automatic uncertain-turn
recovery without replay. User-systemd and launchd lifecycles have isolated
manager-contract fixtures; native macOS release verification remains owner-run.

The pre-auth review also requires terminal eviction and oversized-frame handling,
bounded startup/shutdown, honest per-harness
permission profiles, asserted real-adapter policy tests, restart-safe owned egress
and startup preflight. Metadata-only durable action records, bounded ownership,
correct MCP progress, safe idle recovery, stable volume IDs, typed Codex modes,
release-image provenance checks and launcher forward compatibility are part of
this same gate. The previous plugin remains independently available; its manual
release boundary is documented in [the release guide](../install/release.md).

Public ACP/MCP-over-ACP exports remain unstable. Neither local evidence nor this
plan authorizes publication, personal-login changes or new live model turns.
