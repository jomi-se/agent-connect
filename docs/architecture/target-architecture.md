# Architecture

Agent Connect lets web applications use an agent the user already owns. It is
one product with two components: the Rust gateway (`agent-connect`, packaged as
`@open-agent-connect/gateway`) and the browser SDK (`@open-agent-connect/web`).
Each user runs their own gateway at an origin applications cannot know in
advance, and each gateway serves whichever application origins its owner
approves.

The application wire is ACP over WebSocket with MCP-over-ACP for application
tools ([ADR 0016](../decisions/0016-acp-application-boundary.md)). ACP,
MCP-over-ACP and Agent Connect's `agent-connect.resume.v1` transport extension
remain unstable.

## Shape of the gateway

```text
application / browser
  @open-agent-connect/web + app tools (explicit or WebMCP snapshot)
                 | PAR + OAuth code + S256 PKCE
                 | exact-origin rotating grants + ACP WebSocket (unstable)
                 v
Agent Connect gateway (one or more configured entry-point addresses)
  per-address owner sign-in (passkey or TOTP) / consent / grant revocation
  default-deny policy proxy / action journal / resumable session hosts
  OTel JSON logs (session.id, no full session content)
                 | official ACP adapter, bridging MCP-over-ACP itself (unstable)
                 v
one disposable container per session (rootless Podman or Docker)
  locally built box (latest harnesses or owner pins; refreshed in background)
  dedicated shared harness home + gateway-owned restricted egress proxy
  provider harness owns inference and native execution
```

## Owner sign-in and surfaces

A gateway can serve one address (the common case) or several configured entry
points at once. [Surface model](surface-model.md) defines the boundary: to an
application, each address is its own gateway (pairing, issuer, tokens and
conversations stay bound to that address); to the owner, the console manages
the whole gateway from any signed-in address.

Each configured address holds one second factor
([ADR 0019](../decisions/0019-owner-passkeys.md)): a passkey (the default,
which signs in and approves on its own with user verification) or an
authenticator app (TOTP, for IP literals or by choice, paired with the
passphrase at sign-in and a fresh code per approval). On an address with
neither, the passphrase opens setup only. A weaker factor never removes a
stronger one; removing a factor on Security signs that address out and revokes
apps approved there; offline host recovery (`remove-factor` and
`reset-passphrase`) revokes every app grant.

Owner authority, configuration, grant state and action journals stay outside
the harness home mounted into session containers
([credential model](../plan/credentials.md)). Application tokens never grant
owner authority.

## Sessions, boxes and egress

Each session runs an unmodified ACP adapter, which bridges MCP-over-ACP itself, inside a
disposable container on rootless Podman (recommended on Linux) or Docker
([ADR 0020](../decisions/0020-container-engines.md)). Setup and `serve` refuse
a rootful engine unless the owner opts in explicitly, and the container user
follows the engine.

The box image is built locally from files shipped in the npm package
([ADR 0017](../decisions/0017-local-box-build.md)), taking the latest harness
and adapter releases unless the owner pins versions in `versions.json`
([ADR 0018](../decisions/0018-floating-harness-versions.md)). While serving,
the gateway rebuilds in the background when newer harnesses arrive and swaps
the new box in once idle.

The gateway owns its restricted egress proxy for as long as it serves (on
Podman, with a locked-down keepalive container on the shared rootless network),
verifying it by typed engine facts. Session containers have no direct internet
access; the egress refuses private, reserved, metadata and tailnet
destinations. Capacity defaults to one box until concurrent provider credential
refresh is qualified, and a slot is released only after owned container and
network cleanup succeeds.

## Protocol, ownership and logs

- **Application boundary:** The application owns its UI, tools and side
  effects. Approved tool schemas are frozen at consent; the gateway's policy
  proxy is default-deny in both directions and answers harness permission
  prompts from the consented profile rather than the application. See
  [narrow protocol profile](narrow-protocol-profile.md) and
  [browser SDK building blocks](browser-sdk-building-blocks.md).
- **Resumption and recovery:** Gateway-owned session hosts outlive dropped
  WebSockets for a bounded grace window under `agent-connect.resume.v1`,
  replaying unacknowledged frames by sequence. Application tool requests are
  persisted in the action journal with stable action IDs before delivery. Past
  grace or after a restart, clients load history explicitly without ever
  replaying uncertain prompts or application effects. Revocation ends active
  and detached sessions within one second.
- **Structured logs:** The gateway and its egress emit one OTel-shaped JSON
  object per line joined by `session.id`
  ([ADR 0021](../decisions/0021-structured-logs.md)). Session containers run
  with `--log-driver none`; the gateway logs bounded 50-character message
  previews instead of full conversations, and the egress logs no destinations
  or payloads.

Transport limits, retention and operator controls are in
[configuration](../install/configuration.md); verification layers are in
[testing strategy](testing-strategy.md).

## Where it is heading

Accepted work under [docs/plan/](../plan/README.md):

- **[Browser-bound grants (DPoP)](../plan/browser-bound-grants.md):** replace
  `Origin`-checked bearer tokens with sender-constrained WebCrypto keys bound
  to the browser that paired.
- **[Podman 5 minimum](../plan/require-podman-5.md):** drop the Podman 4.9
  egress keepalive container once Podman 5 is the floor.
- **[Painless harness pinning](../plan/harness-pinning/spec.md):** move from
  floating harness releases to one-step pinned bumps once updating and testing
  are low-friction.
- **[Release qualification](../plan/release-qualification/spec.md):** qualify
  real-credential flows and the native platform matrix beyond deterministic CI.
- **ACP v2 stream resumption:** retire `agent-connect.resume.v1` once ACP v2
  standardizes stream resumption ([ADR 0016](../decisions/0016-acp-application-boundary.md)).
