# Grant-route security retrospective

Status: minimum fix implemented and covered on 2026-07-17

## Why this note exists

The public judge profile replaces authenticated Tailscale Serve requests with
anonymous Tailscale Funnel transport. During planning, a route audit found that
a naive transport-profile change could accidentally make application-grant
listing and revocation anonymous. This note preserves how that issue was found;
the final implementation details and regression evidence must be added after
the fix lands.

## Discovery flow

1. Treat Funnel as a trust-boundary substitution, not merely a different port:
   Funnel supplies HTTPS reachability but no `tailscale-user-login` identity.
2. Trace every gateway route that currently derives authority from the trusted
   Tailscale identity rather than reviewing only the enrollment happy path.
3. In `packages/gateway/src/gateway.ts`, identify the special authorization
   branch covering `/authorize` and `/v1/grants`; both currently pass through
   `requireTailscaleUser`.
4. Ask what independently authenticates each route if `public-demo` skips that
   Tailscale requirement. The authorization page has a legitimate pre-enrollment
   phase, but grant listing and revocation manage already-issued authority.
5. Observe that Origin checks do not fill this gap. They are browser CSRF/CORS
   controls, not caller authentication, and a non-browser client can supply an
   `Origin` header.
6. Conclude that simply replacing the missing Tailscale user with a shared or
   fabricated public principal would expose `/v1/grants` management to anonymous
   callers.

The minimum fix is to require the connector-issued enrolled-device cookie for
grant listing and revocation in `public-demo`, while keeping the private
`tailscale-serve` behavior unchanged. Exact Firebase app id, Origin, callback,
scope, and tool-snapshot authority must also be configured rather than accepted
from arbitrary passphrase holders.

A later review also caught that the private and public connectors share a
hostname even though they use different ports. Browser cookies are not
port-scoped, so the minimum judge instructions require a clean browser profile;
a distinct public hostname is the durable transport-level separation.

## Provenance

The initial finding came from the delegated `public_profile_investigation`
review lane while it audited the existing gateway for a Funnel-compatible
profile. The primary agent then checked the source path, incorporated the issue
into the judge plan, and asked adversarial contract reviewers to challenge the
proposed authorization boundary. Those reviews additionally raised
device-scoped grant ownership and shared-passphrase lockout concerns. They are
valuable hardening work, but are not prerequisites for the first deterministic
judge demo.

This was therefore not an intuition invented after seeing a failure, nor solely
the primary agent's independent discovery. It emerged from a deliberate
trust-substitution and route-by-route audit performed by a subagent, followed by
primary-source confirmation and adversarial review.

## Implemented result and evidence

`packages/gateway/src/gateway.ts` now distinguishes `public-demo` from the
unchanged private profile. Public API routes use an internal enrollment
principal without reading or fabricating a Tailscale user. `/v1/grants`
requires a valid connector-issued device cookie before listing or revoking
grants. Authorization-request creation compares the submitted app id, callback,
and canonical tool hash with explicit operator configuration before creating a
pending consent request.

`packages/gateway/src/config.ts` requires all three fixed-authority values when
the public profile is selected. Missing authority fails gateway startup.

The `public-demo transport profile` cases in
`packages/gateway/test/gateway.test.ts` prove:

- a spoofed or missing Tailscale header neither blocks nor supplies public
  authority;
- anonymous grant management returns `device_not_enrolled`;
- an enrolled-device cookie reaches the grant page;
- the real PKCE grant creates an application session without a Tailscale
  header;
- changed app id, callback, or tool snapshot is rejected before consent; and
- public-demo cannot start without fixed authority configuration.

The pre-existing private-profile cases continue to prove missing, unexpected,
and ambiguous Tailscale identities fail closed. The gateway suite passed 23
tests on 2026-07-17. The container smoke additionally completed the real
OmniGENT/ACP/MCP tool loop under this public grant.

Accepted residual risks remain device-global grant visibility for enrolled
judges, shared-passphrase denial of service, and same-hostname cookie
transmission between ports. These are documented security polish, not hidden
claims of the minimum profile.
