# OpenClaw consent plugin progress

Date: 2026-09-06.
Status: implementation shell and compiled patched-OpenClaw plugin composition
complete; live managed-Tailscale owner consent remains pending.

The provider-owned plugin now implements the OpenClaw-first version-zero OAuth
surface as a public-client Authorization Code flow with S256 PKCE and pushed
authorization requests. `client_id` is the application's canonical HTTPS origin,
redirects must remain on that origin, and the protected resource is the configured
same-provider `/v1/responses` endpoint.
Authorization callbacks include the RFC 9207 `iss` parameter and advertise that
behavior so the client binds success and denial to the selected issuer.

The experimental `authorization_details` profile is intentionally local, not a
claim of a universal Agent Connect or OAuth schema:

```json
[
  {
    "type": "agent_connect",
    "application_tools": [
      { "name": "tool_name", "description": "...", "inputSchema": {} }
    ]
  }
]
```

The shape is exact. In particular, version zero does not accept a client-selected
`strict` field. The grant service validates and fingerprints the fixed tool set.
Protected-resource metadata advertises the fixed opaque model alias
`openclaw/default`; it does not disclose an upstream provider model or agent id.

Owner consent is available only through the host SDK's consent-specific managed
Tailscale verifier on the plugin-owned authorization route. The helper binds the
actual request to host listener attribution, WhoIs, rate limiting, a durable
profile, and the host role ceiling; it fails closed away from managed Serve and
does not accept shared-secret credentials. The plugin independently requires
`operator.admin` and an operator-configured durable owner profile id. It does not
read Tailscale or forwarded identity headers. GET consent displays only the
canonical application origin, browser tool names, and safe operator-configured
capability descriptions. POST consent requires the same owner, same origin and a
one-use owner/request-bound CSRF value. Policies are selected by a per-page index;
internal policy refs are not disclosed to the application. An ordinary HTTPS
owner-login flow is not part of this version-zero slice.

Deployment therefore has a deliberate two-stage prerequisite: OpenClaw must first
materialize the configured owner's durable profile through its host-verified
identity path, then the operator allowlists that profile id before enabling this
plugin. An empty allowlist fails plugin startup. A recognizable hostname, a
caller-supplied Tailscale header, or tailnet membership alone cannot perform this
bootstrap and cannot approve an application.

The current Bookhand reader and library snapshot was measured from its actual tool
factories at 21 Tutor tools (excluding `open_book`): 23,633 bytes of JSON and
32,136 bytes for the complete URL-encoded PAR form. The 64 KiB form cap therefore
has roughly two-times observed headroom while remaining finite; the small design
context tool is additional and must remain inside that bound.

The native Responses provider recognizes only the plugin's access-token prefix.
Claimed invalid credentials deny instead of falling through. Valid credentials
are origin-bound when used by a browser, carry the stable grant subject and closed
policy identity, and recheck the exact parsed application tools immediately at the
native authorization seam. OpenClaw core remains responsible for routing,
session ownership, native policy and sandbox enforcement.

The application-tools-only agent policy must use the host's real deny-all shape,
`tools.deny: ["*"]`; an empty `tools.allow` is permissive in OpenClaw and is not a
closed policy. Capability-bearing policies use the host-verified exact native
allowlist (`web_search`, or sandboxed `exec` and `process`) and reject additional
agent/global/provider/sender policy layers that could broaden it. Application
function definitions travel through Open Responses' separate client-tool path, so
the native deny-all rule does not remove the fixed owner-approved application tools.

The standalone build bundles the grant and OAuth implementation into
`dist/openclaw-plugin/index.mjs`; only the two narrow patched OpenClaw host SDK
imports remain external. The output includes the OpenClaw manifest and extension
package metadata. It is an in-process plugin, not another gateway process.

The compiled bundle has loaded through the patched host's materialized SDK
entrypoints in a disposable OpenClaw runtime. That smoke verified protected-resource
metadata, a real PAR, and fail-closed authorization (HTTP 401 with no consent CORS)
for a forged Tailscale identity header away from managed Serve. The native host
smoke separately proves that its deny-all agent configuration sends exactly one
consented application tool and no native tools to the provider.

Pending acceptance evidence:

- Exercise the verified managed-Tailscale owner principal through the compiled
  authorization route.
- Extend real OpenClaw composition evidence beyond the current application-tools-only
  native smoke to optional native capabilities. OAuth lifecycle integration already
  covers fixed-tool mismatch, refresh/revocation, callback issuer binding, and browser
  CORS against the real plugin handler and SDK client.
- Run one real-phone consent and Bookhand composition smoke without changing the
  current personal runtime until cutover is explicitly authorized.
