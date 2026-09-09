# ADR 0015: OpenClaw owns Agent Connect installation and lifecycle

Date: 2026-09-08. Status: accepted and implemented.

## Decision

The reference provider is an installable OpenClaw plugin, not an additional
executable that users must configure and operate. Stock OpenClaw loads the
plugin and manages its lifecycle. The plugin owns a second IPv4-loopback HTTP
listener dedicated to consent and app-scoped Responses; it does not mount
application routes on OpenClaw's native listener.
The plugin internally constructs authenticated requests to stock OpenClaw's
native Responses endpoint. No core patch, replacement agent loop, second
OpenClaw installation, or external proxy supervisor is required.

This supersedes the archived ADR 0014 separate-process installation prescription,
not its app-delegation boundary. Reuse its grant/PKCE/refresh/revocation, approved tool
snapshot, restricted request construction, response inspection, and bounded
conversation ownership code. The forwarding remains an internal plugin
implementation detail. The standalone executable and tests were removed after
the plugin became the sole installation target; git history retains them.

Use a plugin-owned listener and namespace rather than intercepting native
`/v1/responses`. The default application port is `127.0.0.1:18790`, must differ
from the configured native port, and never falls back to the native listener.
The SDK discovers a verified scoped endpoint; no OpenClaw operator credential
or private session identifier becomes application authority. Keep provider and
plugin implementation types out of the application-facing API.

## Coexistence is a requirement, not a packaging detail

Installation must preserve personal agents, channels, credentials and unrelated
configuration. An explicit owner setup operation may add namespaced restricted
agent profiles and enable the native Responses capability after showing the
change. Never weaken global security or erase personal configuration to make
installation pass. Validate the effective restrictions of offered profiles,
including relevant inheritance, native tools, sandboxing and global hooks.
Unsupported combinations fail with actionable diagnostics; arbitrary plugin
coexistence is not presumed safe merely because imports succeed.

Configuration drift must still fail closed for affected grants. Reading an
in-process config snapshot does not by itself make the later native HTTP
admission atomic. Retain an explicit supported reconfiguration policy and do not
claim that moving into the same process solves every reload race.

Retain explicit owner authentication initially. Plugin installation and tailnet
reachability are not proof of owner identity. Reusing native owner login may be
a later separately verified improvement; it is not a prerequisite for this slice.

## Evidence and limits

A disposable published OpenClaw 2026.9.1 probe on 2026-09-09 registered a service
with its own loopback HTTP server, forwarded internally to native Responses,
streamed an application function call and completed its result continuation.
The fixture app token was rejected by native Responses. There were two fake
inference requests and no subscription calls. Startup activation and readiness
were required. This proves the hosting seam, not production OAuth, teardown,
configuration confinement or arbitrary personal setups. OpenClaw 2026.9.1 is
the exact deployed/test evidence pin, not an upper bound on hosts allowed to load
the plugin; newer versions are admitted and compatibility fixes can arrive by PR.

Implementation and evidence ledger: [plugin-host plan](../plan/openclaw-plugin-host.md).
