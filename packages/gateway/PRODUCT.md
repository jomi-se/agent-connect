# Product

## Platform

web

## Users

The primary user is the owner of a self-operated OpenClaw gateway. They may be
authorizing an application from a phone or another browser and need to
understand, quickly and accurately, what that application will be allowed to
do. The same owner later needs one dependable place to inspect access, revoke a
grant, and understand the restricted profiles their applications can use.

## Product Purpose

Agent Connect lets an application use a user-owned agent without receiving the
owner's OpenClaw credentials or access to the native OpenClaw surface. The owner
console should make authentication, consent, profiles, active grants, and
problems understandable without weakening the existing Origin, redirect, CSRF,
session, policy, or grant boundaries. Success means an owner can confidently
approve the common case on a narrow screen and can later inspect or withdraw
that authority without reaching for configuration files.

## Positioning

The owner stays in control of an application-to-agent connection through a
small, explicit authorization boundary hosted with their own agent.

## Brand Personality

Calm, candid, and capable. The interface uses familiar authorization and
settings conventions, plain language, and specific recovery guidance. It should
feel like dependable infrastructure that respects the owner's attention, not a
security-themed spectacle.

## Anti-references

Do not reproduce the current raw utility form, a cloud-vendor administration
maze, or a theatrical hacker/security aesthetic. Avoid decorative dashboards,
invented trust scores, unexplained protocol vocabulary, hidden authority, and
visual familiarity presented as proof of security.

## Design Principles

- Put the pending decision or current problem first.
- Summarize authority plainly, with exact details available on demand.
- Keep application tools distinct from native OpenClaw capabilities.
- Make cancellation and revocation as legible as approval.
- Preserve truthful operational boundaries: show when restart, reconsent, or
  another owner action is actually required.

## Accessibility & Inclusion

The complete flow must work by keyboard and touch, retain visible focus, use
explicit labels and associated errors, meet WCAG AA contrast, survive browser
zoom and narrow mobile screens, and respect reduced-motion preferences. Status
must never rely on color alone, and error copy must remain specific without
leaking credentials or sensitive host details.
