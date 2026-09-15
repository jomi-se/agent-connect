# Future feature: owner console and managed agent profiles

Status: proposed, not started. Product intent captured 2026-09-09; persistence
and OpenClaw integration require investigation before implementation.

## Goal

Make setup and authorization feel like a conventional, trustworthy OAuth flow
while giving the owner one progressively disclosed entry point for operating the
Agent Connect plugin. The common path should remain quick: identify the
application, authenticate, inspect the requested authority, choose an agent
profile, and approve or cancel.

The stock plugin currently renders a raw owner-passphrase form followed by a
small consent page. It has durable grant state and revocation machinery but no
standalone owner-facing grant dashboard. This feature therefore adds an owner
console as well as redesigning the existing pages.

## Experience

- Design mobile-first and use familiar OAuth page conventions rather than a
  novel security aesthetic. The page should immediately read as “an application
  is requesting access.” Use the repository's Impeccable design workflow during
  implementation.
- Present authentication and consent as one coherent two-step flow. The first
  step names the requesting application while accepting the existing enrollment
  passphrase. The second shows a compact authority summary with expandable
  details, profile choice, a primary approval action, and a clear cancellation
  action.
- Do not change the underlying enrollment-secret verification, owner-session,
  CSRF, redirect, or grant mechanics merely to combine the presentation.
- A direct visit to the management URL uses the existing owner authentication
  and opens a status-and-activity dashboard. Pending requests and current
  problems lead; active grants, profiles, and settings appear through
  progressive disclosure.
- Initial grant management supports inspection and individual revocation. Each
  row should identify the application, chosen profile, approved application
  tools and native capabilities, creation and expiry state, and last use when a
  truthful timestamp is available.

## Managed profiles

An Agent Connect profile represents one managed restricted OpenClaw agent. The
owner chooses among offered profiles during consent. The first useful editor
supports a display name, model, reasoning-effort level, and a curated set of
native OpenClaw capabilities. Application-provided tools remain a separate part
of each application's consent and must not be folded into the profile.

Material profile changes create a new authorization boundary. Existing grants
remain on the authority they received until the owner reconsents; editing a
profile must not silently expand their power.

Persistence is intentionally undecided. Before designing a schema or write
path, inspect the deployed and current stock OpenClaw source for supported agent
configuration, plugin state, mutation, reload, validation, and rollback hooks.
Compare at least:

- plugin-owned durable profile state applied through supported host APIs;
- native OpenClaw configuration as the source of truth;
- a staged export/apply boundary when live mutation would be invasive.

Recommend the least cumbersome reversible design that preserves unrelated
OpenClaw configuration, survives restart, fails closed on partial application,
and does not make an operator-infrastructure Git checkout the implicit database. Record a
decision separately if the chosen ownership boundary changes architecture.

## Acceptance outcomes

- A phone user can follow the normal authorization path without encountering a
  raw utility form or needing to understand OpenClaw configuration.
- Authentication failures, expired requests, cancellation, stale runtime
  configuration, and revocation have polished, specific, non-leaking states.
- Advanced configuration never obscures the normal approval path.
- Profile authority is inspectable, application tools and native capabilities
  remain distinct, and material expansion requires renewed consent.
- Accessibility covers keyboard use, visible focus, labels, error association,
  reduced motion, contrast, narrow screens, and browser zoom.

## Boundaries

This brief does not authorize a new authentication scheme, hosted control
plane, public multi-tenancy, arbitrary OpenClaw configuration editor, or
exposure of provider credentials. Do not claim that visual familiarity itself
adds security.
