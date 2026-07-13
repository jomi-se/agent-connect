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
