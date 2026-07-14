# 0004: Pair applications and broker provider sessions

## Status

Accepted for the OmniGENT-first implementation on 2026-07-13.

## Decision

The public browser API creates opaque Agent Connect sessions. It never accepts
or returns an OmniGENT conversation identifier as required application
configuration.

The connector emits a short-lived, single-use pairing code through its local
terminal. A hosted application submits that code with its application id and
fixed tool snapshot. The gateway binds the resulting capability to the request
Origin, application id, logical session id, and canonical tool-snapshot hash.
Capabilities are signed by a connector-local secret and expire.

The gateway provisions the OmniGENT conversation and runner. A matching healthy
provider session is reused. An offline provider runner is replaced without
changing the logical application session. A changed tool snapshot creates a new
logical and downstream ACP session rather than mutating a live ACP tool surface.

## Security boundary

Pairing proves possession of a secret delivered through a user-controlled local
channel; it does not prove a civil identity. The gateway, not the model, makes
the authorization decision. Both sending prompts and exposing application
tools are remote execution capabilities. Agent Connect does not override the
underlying harness's filesystem, shell, network, sandbox, or approval policy.

The prototype stores session mappings and pairing state in memory. Durable
device keys, revocation, public-relay end-to-end encryption, account recovery,
and multi-user policy are required before production use.

## Subsequent identity investigation

The implemented generic startup code authenticates the application to the
connector but does not independently authenticate an arbitrary first-contact
destination to the application. The target mutual-identity design is recorded
in `docs/research/2026-07-14-mutual-runtime-identity.md`: enroll the connector
key through an account-backed device flow, Tailscale identity, or direct
QR/fingerprint transfer; treat URLs as routing hints; and bind later
application capabilities to both connector and browser keys. This clarifies the
production direction without retroactively claiming that the prototype already
implements it.

ADR 0007 replaces the per-application terminal-code target with two separate
ceremonies: export a stable public runtime card once through the connector's
operator channel, then authorize each new web origin through a connector-owned
OAuth page. The generic startup code in this ADR remains only a legacy
compatibility mode. When durable connector authorization is configured, the
gateway disables it so the terminal code cannot bypass connector-owned consent.
