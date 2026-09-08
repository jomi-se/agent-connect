# ADR 0015: OpenClaw owns Agent Connect installation and lifecycle

Date: 2026-09-08. Status: accepted target; implementation pending.

## Decision

The reference provider is an installable OpenClaw plugin, not an additional
executable that users must configure and operate. Stock OpenClaw hosts the
plugin's consent and app-scoped Responses endpoints and manages its lifecycle.
The plugin internally constructs authenticated requests to stock OpenClaw's
native Responses endpoint. No core patch, replacement agent loop, second
OpenClaw installation, or external proxy supervisor is required.

This supersedes ADR 0014's separate-process installation prescription, not its
app-delegation boundary. Reuse its grant/PKCE/refresh/revocation, approved tool
snapshot, restricted request construction, response inspection, and bounded
conversation ownership code. The forwarding remains a proxy implementation
detail inside the plugin. The standalone composition remains the verified
baseline until plugin verification and an independently authorized live cutover.

Use a plugin-owned namespace rather than intercepting native `/v1/responses`.
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

A disposable published OpenClaw 2026.9.1 probe on 2026-09-08 registered a service
and an `auth: "plugin"` HTTP route, forwarded internally to native Responses,
streamed an application function call and completed its result continuation.
The fixture app token was rejected by native Responses. There were two fake
inference requests and no subscription calls. Startup activation and readiness
were required. This proves the hosting seam, not production OAuth, teardown,
configuration confinement, packaged installation or arbitrary personal setups.

Implementation and evidence ledger: [plugin-host plan](../plan/openclaw-plugin-host.md).
