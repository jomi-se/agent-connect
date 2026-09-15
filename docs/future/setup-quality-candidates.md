# Future candidates: setup quality follow-ups

Status: ideas captured 2026-09-09. These are unprioritized candidates, not
committed implementation or release gates.

## Trusted application identity

Consent currently leads with a raw client identifier. Investigate a truthful
way to present a recognizable application name, HTTPS origin, icon, and redirect
destination while keeping the browser Origin and registered redirect as the
actual security identities. Metadata must be authenticated or clearly labeled
as application-supplied; attractive branding must never allow one origin to
impersonate another.

Success means the owner can answer “which application is this?” without hiding
the exact origin or callback behind branding.

## Browser-visible connection doctor

Add a progressive diagnostic surface for the common connection path. It should
distinguish HTTPS/discovery failure, CORS or redirect mismatch, expired owner
request, unavailable plugin listener, stale runtime configuration, revoked
grant, and provider unavailability, then offer the smallest actionable repair.
Keep sensitive host details behind owner authentication.

Success means a user can understand where connection failed without reading raw
JSON, while developers can still reveal bounded technical evidence.

## Bounded owner security and recovery

Provide a carefully explained security area for owner logout, individual and
bulk grant revocation, and enrollment-secret rotation guidance. Every destructive
action should preview which applications or sessions will lose access and
whether the action is reversible. Reuse existing authentication and revocation
mechanics unless a separate reviewed design authorizes changes.

Success means the owner has an obvious emergency off-switch and recovery path
without turning the console into a general OpenClaw administration UI.
