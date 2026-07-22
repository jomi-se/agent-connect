# VAL-TEST-001: Gateway policy remains fast and fail-closed

Surface: api.
Needs: the repository's supported Node toolchain; no Omnigent service, Codex
credential, Tailscale daemon, browser, or external runner is required.
Behavior: routine tests make real HTTP requests to an in-process Agent Connect
gateway with an instrumented provider boundary. They cover enrolled grant and
PKCE issuance, code replay, revocation, exact origin and requester identity,
capability/session/tool-snapshot binding, raw-provider isolation, and rejection
of unknown or approval-like events. Missing, unexpected, and ambiguous
Tailscale requester values fail closed. Every rejected request that should be
decided by Agent Connect is rejected before a provider call.
Evidence: the normal gateway test command covers the listed policy families;
focused requester-identity cases assert allowed, missing, unexpected, and
ambiguous values and zero instrumented provider calls for rejection.
Fail: a rejected policy case reaches the provider; a gateway can create an
application session without an approved grant; a capability or grant crosses its bound origin,
application, session, or tool snapshot; a revoked or replayed credential is
accepted; or a caller can use a raw provider session.
Scope: this validates Agent Connect's consumption of Tailscale requester
headers, not Tailscale's identity or network implementation. Provider behavior
is injected only at the explicit runtime/HTTP boundary.
