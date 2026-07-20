# 0005: Bootstrap runtime identity through trusted transport profiles

- Status: accepted; narrow Tailscale Serve profile implemented and remotely validated
- Date: 2026-07-14

## Context

Agent Connect currently lets a hosted browser application call a user-owned
gateway at a configured URL. HTTPS protects the connection, and the gateway's
pairing code authorizes the application, but neither fact alone proves that an
arbitrary destination is the runtime the user intended to enroll.

A connector key accepted on first contact improves continuity only after that
first contact. A recognizable hostname is also insufficient: an attacker can
operate a valid endpoint under the same tunnel provider.

Some transport providers already bind accounts, devices, endpoint access, and
cryptographic transport identity. Reusing those bindings can give the first
release a materially stronger bootstrap story without immediately operating an
Agent Connect identity service or public relay.

## Decision

Agent Connect will model remote connectivity as named **transport trust
profiles**, not as an undifferentiated arbitrary base URL.

Each profile must define:

1. how the destination is reached;
2. what provider-backed identity evidence is available about the destination;
3. how the connector learns the requesting user's identity;
4. how the user deliberately binds the endpoint to an Agent Connect connector
   key;
5. what the browser can independently verify;
6. the resulting assurance level and limitations.

The first supported remote profile will be **Tailscale Serve**. Localhost is a
development profile. Microsoft Dev Tunnels is the next profile to investigate.
A naked custom URL remains an advanced, unverified profile until it is paired
through QR/fingerprint transfer or account-backed connector enrollment.

Hostname suffix detection may suggest a profile in the UI. It must never
establish trust.

Agent Connect application authorization remains a separate layer. A trusted
transport does not authorize an arbitrary origin to send prompts or lend tools.
The gateway must still approve the exact Origin, app identity, browser/app key,
tool snapshot, requested scopes, and expiry.

## Tailscale profile

The Tailscale profile relies on these provider guarantees:

- Tailscale binds a user identity to a device-specific node identity backed by
  cryptographic keys, and WireGuard authenticates the destination node during
  the connection.
- Tailscale Serve is tailnet-only and subject to tailnet policy. Funnel is
  public and is not accepted by this profile.
- Serve removes spoofed inbound identity headers and injects the requesting
  user's `Tailscale-User-Login` into the loopback backend request.
- The Agent Connect gateway listens only on loopback, so callers cannot bypass
  Serve and forge those headers over the LAN or tailnet.

These guarantees are useful but asymmetric. A normal web page does not receive
the destination node public key, node owner, or LocalAPI `whois` result. The
browser benefits from Tailscale's authenticated transport, but page JavaScript
cannot independently reconstruct its proof. A `.ts.net` TLS certificate also
authenticates a hostname, not the human ownership claim Agent Connect needs.

Therefore first-use enrollment must deliberately bind:

```text
expected Tailscale Serve endpoint
+ expected Tailscale owner/login or tailnet context
+ Agent Connect connector public key
```

The initial implementation may obtain that binding from the connector's local
operator channel: show the Serve endpoint, local Tailscale identity, and
connector key fingerprint together and export them as a stable runtime card.
The user stores and transfers that card deliberately. Each application then
uses a separate connector-hosted OAuth flow to request exact origin/tool
authority. A later managed directory can replace the manual runtime-card
bootstrap with an account-backed signed enrollment statement.

The connector should inspect its local Tailscale status/LocalAPI and refuse to
advertise the Tailscale profile when it cannot establish the expected Serve
configuration. The browser must not infer Serve-versus-Funnel from the
hostname. The protocol should return a structured assurance result without
pretending that self-reported fields are independently browser-verifiable.

## Public API direction

The eventual application API should select a profile and runtime identity,
while keeping provider details out of task and tool APIs:

```ts
const connection = await connectAgent({
  runtime: {
    profile: "tailscale-serve",
    runtimeId: "sha256:<connector-key-thumbprint>",
    endpoint: "https://device.tailnet.ts.net:8443",
  },
  applicationId: "example-app",
  tools,
});
```

The connection should expose a normalized assurance description such as:

```ts
type RuntimeAssurance = {
  profile: "localhost" | "tailscale-serve" | "dev-tunnel" | "custom";
  transportAuthenticated: boolean;
  connectorKeyVerified: boolean;
  enrollment: "local-transfer" | "provider-account" | "tofu" | "none";
  requesterIdentitySource?: "tailscale-serve" | "tunnel-provider";
  warnings: string[];
};
```

The exact public shape is deferred until implementation. It must remain
harness-neutral and must not expose OmniGENT, Codex, or ACP types.

## Consequences

- The hackathon path can have a credible two-way authentication story without
  first building a universal connector CA.
- The Tailscale profile proves authenticated tailnet transport and requester
  identity at the connector. It does not make destination ownership directly
  inspectable by arbitrary browser JavaScript.
- The connector-key enrollment closes that browser visibility gap for future
  connections: the address routes to a peer, while the pinned key identifies
  the enrolled Agent Connect runtime.
- After bootstrap, per-app authorization occurs on a connector-owned browser
  page and does not require returning to the terminal.
- Shared nodes, shared tailnets, tagged devices, Funnel, and public custom URLs
  require explicit policy and cannot inherit the personal same-user claim.
- A later generic managed profile still needs device enrollment, revocation,
  recovery, and sender-constrained capabilities.

## Sources

- [Tailscale identity](https://tailscale.com/docs/concepts/tailscale-identity)
- [Tailscale Serve and identity headers](https://tailscale.com/docs/features/tailscale-serve)
- [Tailscale tsidp](https://tailscale.com/docs/features/tsidp)
- [Microsoft Dev Tunnels security](https://learn.microsoft.com/en-us/azure/developer/dev-tunnels/security)
