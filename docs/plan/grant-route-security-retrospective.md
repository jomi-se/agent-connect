# Grant-route security retrospective

Status: investigation captured; complete after the public-demo implementation

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

## Completion checklist

After implementation, add:

- exact before/after source references;
- the final authentication and fixed-authority decisions;
- regression test names and outputs;
- confirmation that the private Tailscale profile still fails closed; and
- any accepted residual risk or newly discovered route coupling.
