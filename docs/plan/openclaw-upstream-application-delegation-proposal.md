# Proposal: plugin-issued principals for native OpenClaw Responses

Date: 2026-09-07. Target evidence: pinned OpenClaw 2026.9.1 only.

## Problem

An owner-installed plugin needs to issue revocable, app-scoped credentials that
run the owner's native subscription-backed OpenClaw agent through
`POST /v1/responses`. The application must not receive an operator credential,
choose a private agent/model/session, or inherit unrelated conversations. A stock
plugin HTTP route can run embedded agents, but it cannot inject a verified
principal into native Responses ownership, continuation, and streaming without
reimplementing that protocol surface.

## Minimum reusable hooks

```ts
api.registerOpenResponsesApplicationAuth({
  resolveBrowserOrigin?(request),
  authenticate(request):
    | { status: "pass" }
    | { status: "deny" }
    | { status: "authenticated"; principal: {
        subject: string;
        policyRef: string;
        policyRevision: string;
        context?: unknown;
      } };
  authorize({ principal, request: {
    clientTools, toolChoice, hasMediaInput
  } }): boolean | Promise<boolean>;
});

fingerprintOpenResponsesApplicationPolicy(config, { policyRef }):
  string | undefined;

authenticateVerifiedPluginHttpPrincipal(request, {
  authMethods: ["tailscale"]
}): Promise<VerifiedPrincipal | undefined>;
```

The policy reference is intentionally narrow and experimental: it must name a
non-admin role with `sessions.others: none` and exactly one configured agent. Core
revisions the effective agent/default/tool configuration and, at admission,
captures the exact config object used by native preparation. A future general
per-run tool-policy system is not implied.

The host binds plugin id, version, registry, and lifecycle generation. Plugins do
not mint host admission handles, profile ids, agents, or runtime configs. Provider
callbacks execute in the owning plugin scope. One selected provider is sufficient
for v0; conflicts are explicit and failed registration rolls back atomically.

## Security and compatibility semantics

`pass` preserves stock operator authentication. A provider that claims a
credential must return terminal `deny`; exceptions do not fall through. Browser
CORS grants transport permission only and cannot expand operator access.

Authentication occurs before the bounded body read. Parsed-request authorization
then sees media presence and exact client-function shapes before media fetch.
Native admission occurs immediately afterward and before durable principal,
session, or runtime effects. It rejects a retired provider generation or changed
policy revision. Once admitted, execution uses the captured effective config;
later revocation or reload does not cancel an active stream.

The durable ownership key is `(pluginId, subject)`. A session records nonhuman
application provenance and the internal profile key used for native sharing
checks. Subjects identify grant instances, survive token rotation, and are never
reused after deletion. Revoked/expired identities and sessions may be retained as
audit tombstones; reinstalling with a new grant cannot recover them. The plugin,
not core, owns consenting-owner, expiry, and revocation records.

Native response-id mappings remain bounded and process-local. Restart or eviction
loses continuation and must fail closed; this proposal does not add a durable
Responses engine.

## Non-goals

- OAuth, PKCE, grant schemas, Agent Connect capability labels, or app recipes.
- Generalized multi-provider authentication or arbitrary MCP support.
- A replacement Responses endpoint, agent runtime, or owner login product.
- Active cancellation after grant revocation/plugin retirement.
- Claims that optional web or sandbox-code capability confinement is proven until
  corresponding real pinned-runtime tests pass.

## Acceptance evidence

- Deterministic barriers for config revision and plugin retirement between
  authentication and admission.
- Register-then-throw rollback followed by successful replacement registration.
- Claimed-invalid terminal denial and unclaimed stock operator compatibility.
- Real pinned native two-turn client-tool composition with token rotation,
  cross-grant denial, exact stored application creator, and sandbox stamp.
- Optional sandbox capability only after a sandbox-unavailable run proves no
  model request or model-directed host tool execution.
- Patch application, package build, SDK declaration build, and existing native
  composition tests against the pinned package integrity.

This is a proposal-ready downstream patch, not a claim of maintainer acceptance or
compatibility with OpenClaw newer than 2026.9.1.
