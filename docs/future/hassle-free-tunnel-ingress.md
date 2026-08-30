# Future task: hassle-free tunnel ingress for self-hosted gateways

Status: proposed, not started. Written 2026-08-30 while scoping a desktop
application that would run a gateway for non-technical users.

## The gap

A user-owned gateway has to be reachable over HTTPS at a stable origin. The only
supported remote profile today is Tailscale Serve, which is excellent for the
operator who built it and unusable for the audience a packaged desktop
application would target:

- `tailscaled` is a system daemon. Root install, service registration,
  platform-specific packaging. It cannot be bundled inside an application and
  started on demand.
- Serve is tailnet-only, so every consuming device must also join the tailnet.
- Making it public means Funnel, which additionally requires a `nodeAttrs` entry
  carrying the `funnel` attribute in the **tailnet policy file**. Only an Owner,
  Admin, or Network admin can edit that. It is a step in a separate web console,
  before the application can do anything, and a user who joined an existing
  tailnet as a plain member cannot perform it at all.

So the current onboarding is: install a privileged daemon, log into a second web
console, edit an access-control policy. That is the barrier, not TLS.

The goal of this document is a deployment where the user installs one
application, and the gateway becomes reachable at a stable HTTPS origin without
a terminal and without root.

## What has to be true first

This is a transport question, and ADR 0009 already says transport and owner
authentication are separate concerns. That separation is the precondition here,
because every option below removes the thing the current code leans on.

`requireTransportPrincipal` (`packages/gateway/src/gateway.ts:812`) does two
things:

1. rejects any request that did not arrive on loopback —
   `trusted_proxy_required` (`isLoopbackAddress`, `:824`);
2. reads the `Tailscale-User-Login` header and checks it against an allowlist
   (`requireTailscaleUser`, `:799`).

Check 1 survives every provider considered here: they all run a local connector
that dials the gateway on `127.0.0.1`, exactly as `tailscale serve` does.

Check 2 does not. The header is trustworthy today only because `tailscaled`
refuses to forward requests from outside the tailnet. Once the origin is
publicly reachable, an unverified header is worthless.

### The identity is already there

The replacement does not have to be a third-party identity provider. The gateway
already authenticates its owner: `enrollDevice`
(`packages/gateway/src/connector-auth.ts:277`) takes a passphrase, derives a
scrypt verifier against a stored salt (`:548`), compares it in constant time,
and on success issues a device token stored as a hash with a TTL and set as a
`Secure; HttpOnly; SameSite=Lax` cookie.

Today that passphrase is a second factor behind the tailnet. In a public profile
it becomes the first one. That keeps the trust path user-owned — no external
identity provider — and it is a much smaller change than integrating one.

The shape of the work is therefore a new `transportProfile` variant in which
transport contributes **no** identity, rather than a variant that parses a
different vendor's header. Identity extraction becomes a per-profile strategy.

### Enrollment hardening this depends on

Making the passphrase the primary factor is not safe with the current throttle.
The lockout key combines the Tailscale user with the authorization request id,
and allows five failures per key with a fifteen-minute reset
(`requirePassphraseAllowed`, `:489`; `recordPassphraseFailure`, `:499`).

Behind a tailnet that is sound, because reaching the route at all requires being
an allowlisted tailnet user. On a public origin, authorization requests are
attacker-creatable, so a fresh request buys five fresh guesses. The only real
brake left is `MAX_CONCURRENT_PASSPHRASE_VERIFICATIONS = 2` plus scrypt's cost.
That is an online guessing oracle, not a lockout.

There is a mirror-image problem: once the failure map reaches
`MAX_PASSPHRASE_FAILURES = 256`, `recordPassphraseFailure` throws
`enrollment_capacity`, so an attacker who fills it locks the legitimate owner
out of enrolling for fifteen minutes.

Neither is a bug today. Both become one the moment the origin is public, and the
Tailscale-user half of the key disappears in the new profile regardless, so the
keying has to be reconsidered either way. Roughly: rate-limit by source address,
add a global backoff, and generate a high-entropy passphrase rather than
accepting a user-chosen one.

## The constraint that eliminates most options

The public origin must be **stable across restarts**. It is not cosmetic:
`AGENT_CONNECT_PUBLIC_ENDPOINT` is load-bearing in four places.

- it is published in the runtime card that applications scan and pin;
- it builds the `authorizeUrl` handed to the application (`gateway.ts:296`);
- it is the CSRF origin check on the consent POST (`:866`) and on `/authorize`
  (`:910`);
- application grants are pinned to it.

So an ephemeral or rotating hostname silently invalidates every grant and
re-onboards every connected application on each restart. That failure presents
as a mysterious authorization bug rather than as a configuration choice, which
makes it worse than an outage.

**Rule: reserved or named tunnels only. Never a quick or ephemeral tunnel.**

This is what rules out `TryCloudflare`, plain `localhost.run`, and the
random-URL mode of most free tiers.

## Provider survey

Evaluated on: no root, no terminal, stable hostname, and whether the user must
bring a domain.

### zrok (OpenZiti / NetFoundry) — recommended for the free tier

Runs as an unprivileged user process; the documentation describes running shares
as `systemd --user` units, which confirms it never needs privilege. Enrollment
is a single account token that identifies and authenticates in one step, so the
application's setup screen is one paste, or a browser handoff caught on a
loopback redirect. Reserved shares give a persistent
`https://<name>.share.zrok.io` with a caller-chosen name, surviving restarts.
Free, no domain required.

It is also open source with a self-hosting path, which matters for a project
whose premise is that the user owns their runtime: the vendor is a convenience,
not a dependency.

### cloudflared — recommended for a managed tier

Inverts the domain problem instead of solving it. Cloudflare Tunnel public
hostnames must resolve to an active zone in _your_ Cloudflare account, which is
why `workers.dev` cannot be used as tunnel ingress despite being a free stable
hostname. But that only means the domain has to belong to whoever operates the
service.

A managed deployment therefore provisions the named tunnel and DNS record
through the Cloudflare API, hands the desktop application a token, and the
application runs `cloudflared tunnel run --token <...>` as an unprivileged child
process. Root is needed only to install `cloudflared` as a system service, which
this use does not require. The user configures nothing and gets a stable
hostname on the operator's domain.

The cost is operational, not technical: whoever owns the domain owns the abuse
surface, the uptime expectation, and the reputation of every gateway behind it.

Cloudflare Access could additionally supply owner identity by injecting a signed
`Cf-Access-Jwt-Assertion`, which is architecturally the same pattern as
`Tailscale-User-Login`. Worth noting, but it must be **verified as a JWT**,
never merely read as a header, and the passphrase path above makes it optional.

### ngrok — best integration story, disqualified by the free tier

The only option with genuine in-process SDKs (Rust, Go, Node), so no child
process to supervise at all: call a function, get a listener. For a Tauri or
Electron application that is materially simpler than everything else here.

Free static domains exist (`<name>.ngrok-free.app`), but free HTTP/S endpoints
serve a browser interstitial that visitors must click through. That is
disqualifying for this specific system: the consent page is a top-level browser
navigation inside an OAuth redirect chain, and the `ngrok-skip-browser-warning`
header bypass cannot be applied to one. Paid tiers remove the interstitial, so
ngrok means paying per user from the first day.

### Tailscale Funnel — free and stable, but the wrong installer

Worth recording precisely because it looks like the obvious answer. Funnel is
available on every plan including free, gives a stable
`https://<machine>.<tailnet>.ts.net`, and its allowed ports are 443, 8443, and
10000 — the reference deployment already listens on 8443, so
`AGENT_CONNECT_PUBLIC_ENDPOINT` would not change.

Under the passphrase-primary profile, Funnel's lack of a caller identity header
stops being a regression and becomes the expected shape, which removes the
objection ADR 0005 raised against it. What remains is the installer problem: the
privileged daemon and the admin-console policy edit. Funnel is the shortest path
for an operator who already runs Tailscale, and the wrong default for a packaged
application.

### Building the tunnel on Cloudflare Workers — rejected

A Worker on `*.workers.dev` fronting a Durable Object, with the desktop
application holding an outbound WebSocket and the object relaying inbound
requests, would give a free stable hostname without a domain. It works in
principle, but it means implementing a tunnel — streaming, backpressure,
reconnection — against free-tier request and CPU ceilings. Not justified while
zrok exists.

### Microsoft Dev Tunnels — deprioritized

ADR 0005 names Dev Tunnels as "the next profile to investigate". That should be
revisited. It is licensed and shaped for developer inner-loop work, not as the
transport underneath a third-party product, which makes it a poor foundation for
a packaged application regardless of its technical fit.

## Recommendation

**zrok as the self-hosted default; `cloudflared` with an operator-owned domain
if a managed tier is ever offered.**

The useful property is that these two are the _same integration shape_: a
bundled binary, supervised as an unprivileged child process, credential in,
stable hostname out. One small provider abstraction — start, health, restart,
and a resulting hostname — covers both, so the free and managed paths are two
implementations rather than a rewrite. ngrok would slot in as a third if the
in-process variant ever becomes worth paying for.

## What it would take

**A transport-profile strategy seam.** `transportProfile` already exists
(`config.ts:12`) and already gates dynamic enrollment (`gateway.ts:80`). Extend
it so that owner-identity extraction is per-profile, with a variant that
contributes none.

**Enrollment hardening.** As above. This is the gating security work, and it
should land before any public profile, not alongside it.

**A supervised tunnel process.** Lifecycle, health, restart, and surfacing the
hostname into `AGENT_CONNECT_PUBLIC_ENDPOINT` before the gateway binds — the
endpoint is required at construction (`config.ts:42`) and must be an HTTPS
origin with no path (`gateway.ts:653`).

**A new ADR.** This changes the trust story established by ADR 0005 and depends
on ADR 0009 being accepted rather than proposed. It should not be slipped in as
a configuration option.

## Risks

- A publicly reachable consent page and `/authorize` are a materially larger
  attack surface than a tailnet-only one. The threat model in
  `docs/research/2026-07-14-malicious-application-runtime-threat-model.md` was
  written against the private profile.
- Trust becomes partly the tunnel provider's. They terminate TLS and can see
  plaintext. That is a real change to the user-owned premise and deserves saying
  out loud in the UI, not only in a document.
- Bundling a third-party binary brings its update cadence, its telemetry, and
  its terms of service into the distribution.

## Open questions

1. Does the passphrase-primary profile need a second factor of its own once the
   origin is public, or is a generated high-entropy passphrase plus per-source
   rate limiting sufficient?
2. Should the runtime card record which transport profile produced the endpoint,
   so an application can display the assurance level rather than inferring it
   from the hostname suffix? ADR 0005 is explicit that suffix detection must
   never establish trust.
3. If a managed tier exists, does the operator's ability to re-point DNS
   constitute a trust claim over user gateways that has to be disclosed?
