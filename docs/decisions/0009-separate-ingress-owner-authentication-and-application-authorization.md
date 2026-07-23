# 0009: Separate ingress, owner authentication, and application authorization

- Status: proposed
- Date: 2026-07-23

## Context

The current gateway combines several distinct security mechanisms:

1. the transport determines how requests reach the gateway and may contribute
   caller evidence;
2. the runtime card and signed challenge let an application authenticate the
   selected gateway;
3. a passphrase and durable browser cookie authenticate a gateway owner;
4. gateway-owned consent issues an exact application grant;
5. a session capability authorizes access to one opaque application session.

The first implementation applies passphrase-based browser-device enrollment to
both the private Tailscale Serve profile and the public Funnel judge demo. This
is safe but obscures why each mechanism exists. ADR 0007 intended Tailscale
Serve's authenticated requester identity to authenticate the gateway owner,
while the public Funnel profile has no equivalent transport identity and needs
another owner authenticator.

Transport and authentication must not become one large optional configuration
shape. Different ingress mechanisms provide genuinely different evidence.
Routes also need semantic access requirements that do not depend on whether
the deployment uses Tailscale, public HTTPS, localhost, an identity provider,
or a future tunnel.

## Security ceremonies

Agent Connect distinguishes four ceremonies:

### Gateway authentication

The application verifies the gateway key from a deliberately transferred
runtime card by checking a signed challenge. This establishes continuity with
the gateway selected by the user. It is independent of caller authentication.

### Gateway-owner authentication

The gateway establishes that the caller may approve applications, inspect
grants, revoke grants, or perform recovery. Candidate mechanisms include:

- a Tailscale Serve requester identity;
- a passphrase-bootstrapped enrolled browser;
- WebAuthn/passkeys;
- an OIDC or SSO identity provider;
- a managed account session;
- a local native/operator channel.

### Application authorization

An authenticated gateway owner approves an exact application Origin, redirect
URI, app id, scope set, tool snapshot, and expiry. The gateway returns a
revocable application grant. The owner authenticator does not replace this
consent and grant.

### Session authorization

An application grant creates or recovers an opaque Agent Connect session. A
short-lived session capability authorizes traffic for that session while its
underlying grant remains active.

“Runtime bootstrap,” “browser-device enrollment,” and “application
authorization” must not be shortened to the ambiguous term “enrollment.”

## Proposed model

The stable authorization core remains transport-independent:

- the runtime-card challenge;
- gateway-owned application consent;
- PKCE code exchange;
- exact application grants;
- session capabilities;
- grant revocation.

A deployment profile composes three separate concerns:

```ts
interface GatewayDeploymentProfile {
  readonly ingress: IngressAdapter;
  readonly ownerAuthentication: OwnerAuthenticator;
  readonly applicationExposure: ApplicationIngressPolicy;
}
```

The exact TypeScript interfaces are deferred. Their responsibilities are not.

### Ingress adapter

The ingress adapter validates how the gateway is exposed and returns only the
evidence that mechanism can actually provide. It does not approve applications
or sessions.

### Owner authenticator

The owner authenticator consumes transport evidence, browser credentials, an
external identity protocol, or a composition of those mechanisms and returns a
gateway-owner principal. The authorization page and grant administration ask
for a gateway owner; they do not know how that owner authenticated.

### Application ingress policy

The application ingress policy decides which prospective application requests
may reach bounded challenge and authorization-request endpoints before a grant
exists. It includes profile-specific exposure and abuse controls but cannot
issue a grant without owner consent.

## Semantic route access classes

Routes declare the principal or authority they require, not a transport:

```ts
type RouteAccess =
  | "public"
  | "prospective-application"
  | "gateway-owner"
  | "authorized-application"
  | "active-session";
```

These are access classes, not an ordered privilege ladder. A gateway owner, an
authorized application, and an active session are different principals.

The selected deployment profile supplies the concrete policy behind each
class. For example, `gateway-owner` may resolve to a verified Tailscale user in
one profile and an OIDC-backed browser session in another. Application grants
and session capabilities remain the same across those profiles.

## Tailscale Serve assurance

Tailscale Serve is explicitly configured; it is never inferred from a
`.ts.net` hostname or from the presence of an identity header.

Before activating an optimized Tailscale Serve profile, the gateway should
fail closed unless it can validate at least:

- the backend listener is loopback-only;
- the local Tailscale daemon/LocalAPI is available;
- the active Serve configuration maps the expected HTTPS endpoint to the exact
  gateway loopback target;
- the endpoint is Serve rather than Funnel;
- protected requests contain one unambiguous allowed Tailscale identity.

Automatic detection may recommend a profile, but it must not silently weaken
owner authentication. Explicitly selecting a profile whose prerequisites
cannot be proven fails startup. It does not fall back to an anonymous or weaker
mode.

These checks establish a useful remote-network boundary, not host-process
isolation. Tailscale removes incoming identity headers before injecting its
own, but its documentation states that a localhost backend limits spoofing to
other services running on the Serve machine. A local process can connect
directly to the loopback gateway and fabricate the same headers.

This matters because the downstream agent may run on the same machine. An
optimized Tailscale-only owner authenticator is valid only for a profile whose
declared threat model trusts local processes or isolates the gateway backend
from the agent. Without that assurance, Tailscale identity should augment
rather than replace a browser-held owner credential.

Two Tailscale variants therefore remain possible:

```text
personal trusted-host:
  owner = verified Tailscale requester

untrusted local-agent:
  owner = verified Tailscale requester
          AND browser-held credential/passkey
```

The current passphrase/device mechanism remains the safer general baseline
until the optimized profile and its local-process assumptions are explicit and
validated.

## General and future owner authentication

Transport-dependent behavior does not require multiple authorization
protocols. Agent Connect should have one application authorization and session
authorization core with interchangeable gateway-owner authenticators.

The initial general authenticator can remain:

```text
one-time passphrase bootstrap
  -> durable browser-held owner credential
  -> gateway-owned consent
```

Future authenticators can replace only the first two steps:

- WebAuthn can produce a phishing-resistant local owner session;
- OIDC/SSO can authenticate the gateway owner through an external identity
  provider;
- a managed Agent Connect account can supply recovery and multi-device owner
  sessions;
- Tailscale `tsidp` may eventually supply signed OIDC identity derived from
  Tailscale, but it is currently experimental and adds another deployed
  service.

The gateway may itself act as the authorization server for applications while
using a separate upstream OIDC provider to authenticate its owner. Those are
different protocol roles and must remain separate in code and documentation.

## Consequences

- Popular HTTP frameworks may implement routing, parsing, schemas, lifecycle,
  streaming, and errors, but Agent Connect still needs this small domain policy
  layer.
- Route definitions remain stable when transports or owner identity providers
  change.
- Adding an ingress mechanism does not create another app-grant protocol.
- Adding SSO or passkeys does not change session capabilities.
- Transport detection is advisory until explicit profile activation validates
  its prerequisites.
- Optimized authentication is allowed only with an explicit assurance claim and
  fail-closed validation.
- The current implementation does not yet satisfy this decomposition and must
  not be described as though it does.

## Open questions

- Can the reference deployment isolate the loopback backend from the downstream
  agent without requiring a heavyweight container topology?
- Should the first optimized Tailscale profile require `tsidp`, use Serve
  identity headers under a trusted-host assumption, or remain deferred?
- Should owner sessions always become a common gateway cookie regardless of
  whether the initial authenticator was passphrase, Tailscale, OIDC, or
  WebAuthn?
- What continuous owner or grant checks are required for already-open SSE
  streams?

## Sources

- [Tailscale Serve identity headers](https://tailscale.com/docs/features/tailscale-serve)
- [Tailscale identity and LocalAPI](https://tailscale.com/docs/concepts/tailscale-identity)
- [Tailscale Serve configuration](https://tailscale.com/docs/reference/tailscale-cli/serve)
- [Tailscale Funnel](https://tailscale.com/docs/features/tailscale-funnel)
- [Tailscale tsidp](https://tailscale.com/docs/features/tsidp)
