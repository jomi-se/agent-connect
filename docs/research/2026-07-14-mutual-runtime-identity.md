# Mutual runtime identity without hardware attestation

Date: 2026-07-14

Status: investigation and proposed direction; not implemented.

## Question

Agent Connect currently authenticates a hosted application to a local gateway,
but a browser configured with an arbitrary URL has weak evidence about what is
on the other end. TLS authenticates a domain or tailnet endpoint; a gateway
key accepted on first use proves only future continuity. Neither alone proves
the user deliberately set up that gateway.

The desired claim is narrower than trusted execution:

> This endpoint proves possession of a gateway key that this user explicitly
> enrolled from a channel independent of the application connection.

This does not claim that the host is uncompromised, that a reported harness is
genuine, or that the gateway binary is executing inside protected hardware.

## Trust requires an independent root

There is no cryptographic way to derive ownership from an arbitrary first
connection. The initial binding must ultimately rely on at least one independent
root:

- an account or identity provider;
- another already trusted user device;
- a private network identity such as Tailscale;
- a manually compared code, fingerprint, or QR payload;
- control of a DNS name;
- cloud, TPM, secure-enclave, or other platform attestation.

Open source improves inspectability and makes it possible to self-host the
coordinator. It does not prove that the endpoint reached by a browser is the
user's installation; an attacker can run the same source.

## Existing patterns

### OAuth device authorization

[RFC 8628](https://www.rfc-editor.org/rfc/rfc8628.html) standardizes the familiar
device enrollment flow: a device obtains a short-lived device/user code, the
user authenticates and reviews the request in a separate browser context, and
the device polls until approval. The specification requires outbound HTTPS and
explicitly supports QR transfer while retaining a displayed comparison code as
remote-phishing mitigation.

The standard authorizes a device to an account; it does not itself certify a
gateway public key. Agent Connect can bind the enrollment to the gateway's
key by requiring proof of possession during token issuance and registering that
key after authorization.

### Device key plus user identity

Tailscale is a close production precedent. Its client generates machine and
node keys, the user authenticates through an identity provider, and the control
plane links the node public key to the device and user identity. Other nodes
then authenticate the node cryptographically rather than trusting its address.
See [Tailscale node keys](https://tailscale.com/docs/concepts/node-keys) and
[Tailscale identity](https://tailscale.com/docs/concepts/tailscale-identity).

### Workload identity and join tokens

SPIFFE/SPIRE calls this general problem node attestation. Strong deployments
can use cloud identity documents, TPMs, or HSMs; its portable fallback is a
single-use join token supplied during installation. See
[SPIRE concepts](https://spiffe.io/docs/latest/spire-about/spire-concepts/) and
[join-token configuration](https://spiffe.io/docs/latest/deploying/configuring/).
SPIFFE is too operationally heavy for the SDK, but its separation of bootstrap,
node identity, workload identity, and revocation is useful.

### Host certificates

SSH host certificates solve the same verifier problem with a CA: a client trusts
a host key because a trusted authority signed it, not because the host appeared
at a particular IP address. This is a useful mental model for an Agent Connect
runtime certificate.

### Sender-constrained capabilities

[OAuth DPoP (RFC 9449)](https://www.rfc-editor.org/rfc/rfc9449.html) binds a
token to a public key and requires a fresh request proof. This limits replay of
stolen browser or gateway tokens. DPoP is not authentication by itself and
must be combined with HTTPS and an authorization decision.

## Proposed default: user-enrolled gateway certificate

The generic deployment should use account-backed device enrollment rather than
trust-on-first-use:

```text
gateway installation
  -> generate non-exported gateway identity key Kc
  -> request OAuth device authorization
  -> display verification URL + short code / QR

user on an independently authenticated browser
  -> signs in to Agent Connect (or configured OIDC provider)
  -> sees gateway nickname + short key fingerprint
  -> approves "register this gateway"

identity/coordinator service
  -> binds Kc public key to the user's account
  -> issues a signed, expiring runtime certificate
  -> exposes device list, rotation, and revocation

application connection
  -> identifies the desired runtime by runtime ID, not arbitrary URL
  -> receives the certified gateway public key
  -> challenges the destination
  -> accepts it only if it proves Kc possession
```

The certificate or signed enrollment statement should contain at least:

```json
{
  "version": 1,
  "runtimeId": "sha256:<gateway-key-thumbprint>",
  "connectorPublicKey": {},
  "ownerSubject": "pairwise-pseudonymous-user-id",
  "issuer": "https://identity.agentconnect.example",
  "issuedAt": "...",
  "expiresAt": "...",
  "enrollmentMethod": "oauth-device",
  "connectorRelease": "self-asserted-or-signed-build-metadata"
}
```

The owner identifier should be pairwise/pseudonymous where possible. An
application usually needs to know "same Agent Connect user," not the user's
email address.

The gateway proves possession of its certified key during every transport
handshake. The browser also owns an origin-scoped application-instance key, and
session capabilities are sender-constrained to both keys, the exact Origin,
application ID, tool snapshot, policy profile, and expiration.

## The URL is routing, not identity

Once runtime identity is key-based, a direct URL or relay address is only a
transport hint. A different endpoint cannot impersonate the runtime without the
certified gateway private key. If an untrusted relay forwards the handshake
to the real gateway, the browser still establishes its authenticated,
encrypted channel with the real gateway; the relay can observe routing
metadata but cannot read or alter payloads.

The normal SDK should therefore accept a runtime ID or signed pairing payload,
not a naked arbitrary base URL. Direct URL entry can remain an advanced mode,
but must require a fingerprint comparison or show an explicit unverified-runtime
warning.

## Pairing the application is a separate decision

Runtime enrollment answers "is this one of my gateways?" It does not authorize
an arbitrary application. Application pairing should be request-specific:

1. The browser generates a non-exportable application-instance key.
2. It requests access with the browser-controlled Origin, app ID, tool snapshot,
   requested prompt/output scopes, and its public key.
3. The gateway presents the exact request through a trusted local UI or the
   user's authenticated Agent Connect device page.
4. The user approves or denies it.
5. The resulting grant is bound to both gateway and browser keys.

A generic code printed at gateway startup is only a prototype. It does not show
the user, through a trusted surface, which origin and tool set will consume it.

## Deployment profiles

### What Tailscale exposes to each side

Tailscale gives the network stack stronger evidence than it gives ordinary web
page JavaScript. A Tailscale connection authenticates node keys through
WireGuard, so the client device's Tailscale daemon knows which destination node
it reached. On the server, LocalAPI can resolve a source IP to its node and user
or tags. Tailscale Serve additionally strips spoofed identity headers and
injects the requesting user's identity into the loopback backend request. See
[Tailscale identity](https://tailscale.com/docs/concepts/tailscale-identity) and
[Tailscale Serve](https://tailscale.com/docs/features/tailscale-serve).

However, a standard hosted page cannot call the local Tailscale daemon and is
not handed the destination node key, node owner, or LocalAPI result. TLS and the
`.ts.net` hostname are not a portable proof that the node belongs to the same
human as the browser user. Serve's identity header authenticates the requester
to the gateway; it does not send a provider-signed destination-owner claim
back to page JavaScript.

Therefore Tailscale is a strong bootstrap profile, not a complete browser API.
The user must deliberately select or approve the Serve endpoint and bind it to
the gateway key. Subsequent Agent Connect handshakes verify that pinned key.
The gateway should inspect local Tailscale posture, while the SDK reports
which properties are provider-backed, gateway-verified, or merely
self-reported. [tsidp](https://tailscale.com/docs/features/tsidp) may later give
applications signed OIDC tokens for user login, but it does not eliminate the
need to enroll the gateway endpoint.

### Tailscale profile (first supported remote profile)

- Tailscale cryptographically authenticates tailnet nodes and HTTPS protects
  the Serve hostname.
- Serve authenticates the requesting Tailscale user to the loopback gateway.
- User-approved enrollment pins the Agent Connect gateway key and expected
  endpoint/owner context.
- This is suitable for the current personal demo and a credible first release,
  but does not become a generic custom-URL proof.

### Managed identity profile (eventual portable default)

- Agent Connect or a configured OIDC service enrolls gateway keys.
- A coordinator/directory issues and revokes runtime certificates.
- A public relay may route end-to-end encrypted envelopes.
- This gives the cleanest consumer UX and cross-device recovery.

### Accountless profile

- The gateway displays a QR or high-entropy pairing payload containing its
  public-key fingerprint and an ephemeral enrollment secret.
- The user transfers that payload directly to the browser/app.
- This proves deliberate access to the gateway's local channel, without
  account recovery or a global device directory.

### Enterprise/attested profile

- An operator may additionally require custom OIDC, mTLS, SPIFFE, cloud instance
  identity, TPM, or device-posture evidence.
- These signals strengthen environment provenance but are not the baseline
  promise for an open user-owned runtime.

## What this proves and does not prove

It proves:

- the current peer holds the private key of a gateway enrolled by the user;
- subsequent requests remain bound to the approved gateway and app keys;
- a substituted URL, relay, or stolen bearer token cannot silently impersonate
  either party;
- enrollment can be listed, expired, rotated, and revoked.

It does not prove:

- the VM is uncompromised;
- Omnigent, Codex, or any reported harness is genuine;
- the gateway is running an audited release unless a separate software supply
  chain or platform-attestation policy is enabled;
- an authorized application origin is free from XSS or malicious first-party
  code.

## Recommended implementation sequence

1. Introduce named transport profiles and replace naked URL trust with
   `runtimeId + transport hints`.
2. Implement the Tailscale Serve profile: inspect local posture, reject Funnel,
   require loopback, authenticate requester identity, and enroll a gateway
   key through the local operator channel.
3. Bind application capabilities to browser and gateway keys using
   DPoP-like per-request proofs.
4. Prototype accountless QR enrollment for custom transports.
5. Add OAuth device authorization and key registration for the eventual
   managed profile.
6. Issue short-lived signed runtime certificates and provide device
   list/revocation UX.
7. Carry authenticated encryption unchanged through the public relay.
8. Treat custom OIDC, SPIFFE, and hardware/cloud attestation as optional
   stronger profiles.

## Open decisions

- Which Tailscale interface should be the stable oracle for Serve-versus-Funnel
  posture and local node identity.
- Whether the hackathon demo should stop at Tailscale plus local-transfer key
  enrollment or include accountless QR enrollment.
- Which account provider should anchor the managed profile.
- Whether runtime certificates are compact signed statements or conventional
  X.509/SSH-style certificates.
- How gateway keys are stored across Linux, macOS, and Windows.
- Whether the coordinator publishes an append-only key history to make silent
  certificate substitution detectable.
- How a self-hosted coordinator interoperates with hosted applications without
  reintroducing naked URL trust.
