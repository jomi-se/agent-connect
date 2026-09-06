# Compact continuation handoff

Checkpoint: 2026-09-06, native seam `9ef0b39` on `work/openclaw-gateway`.
Goal remains a real Tailscale-flavored OpenClaw → SDK → Bookhand vertical slice.
It is **not complete**. No push or live service migration has occurred.

## Resume economically

Use one implementation agent. Avoid rebuilding working artifacts or repeating
component reconnaissance. A bounded reviewer is useful after the next actual
integration result, not several interconnected coding lanes in parallel.
Read the active ledger in `connect-your-ai-openclaw.md` and the specific files
needed below; the full conversation is not required. Subagents are checkpointed
and idle. Continue to use quiet commands and preserve unrelated work.

## Implemented and checked

- Durable grants: `4c271ed`; AI SDK execution helpers: `c8d680b`.
- Browser OAuth client/exports: `cf3b3d1`; actual client/handler lifecycle test:
  `dedb8ef`; compiled consent plugin: `995423f`.
- Native OpenClaw patch, reproduction instructions and smoke: `9ef0b39`.
- Default repository verify passed. Native smoke separately passed approved
  client-tool execution, token-refresh continuation, absence of native tools,
  and isolation/rejection checks. Actual compiled plugin load, discovery, PAR
  and forged-owner denial passed.
- Generic OpenClaw SDK declaration checker has an unresolved `__exportAll`
  error. Runtime/required compiled exports work; do not claim all build gates pass.

## Exact next work

Before further implementation, investigate a **patchless plugin deployment**
alongside the upstream hooks/patch approach. Both may be useful; native
`/v1/responses` is not itself a product requirement. Do not abandon the working
patch or start a second implementation before comparing the supported seams.

Source inspection on 2026-09-06 found a concrete candidate:
`api.runtime.agent.runEmbeddedAgent`, documented in OpenClaw's
`docs/plugins/sdk-runtime.md`. The pinned source's public runtime parameter type
includes `clientTools`, `onPartialReply`, `onAgentEvent`, session identity and
sandbox-agent selection; its result includes `pendingToolCalls`. These source
files are unchanged by our patch. This establishes API availability, not an
end-to-end compatibility pass.

The important limitation is in
`src/plugins/runtime/runtime-embedded-agent.runtime.ts`: admission identifies
the registered plugin and rejects caller-supplied host admission authority.
An application grant is not automatically a native restricted principal.
Next inspect how plugin-selected agent policy can enforce confinement, and how
client tool outputs enter the next turn (the native HTTP path has separate
`openresponses-prompt.ts` conversion). Determine what Responses framing/session
bookkeeping the plugin would have to own. Also retain the separate question of
owner authentication without our managed-Tailscale helper patch. Do not equate
available callbacks with a complete secure patchless deployment.

Follow-up source findings:

- Native `openresponses-prompt.ts` renders `function_call_output` as a `Tool:`
  conversation entry and ultimately a message string. The public embedded-run
  parameters expose a prompt, not a Responses continuation operation. A plugin
  would own this conversion, grant-bound response-ID/session mapping and SSE
  framing; the native HTTP handler owns those today. This is not evidence of a
  broken continuation, but it is real adapter work, not endpoint registration
  alone.
- **Correction:** both exports in `authenticated-http-principal.ts`, including
  `getAuthenticatedPluginHttpPrincipal`, are additions in our patch. Neither
  is evidence of a stock supported owner-identity API.
- Stock `docs/plugins/sdk-overview.md` describes authenticated external-tab
  bootstrap cookies, but explicitly limits them to GET/HEAD and operator.read.
  Tab visibility scopes do not authorize mutations. That mechanism alone
  cannot approve our OAuth grant.
- The embedded-run wrapper admits the plugin identity, not a caller-supplied
  host authority envelope. Dedicated configured agents/sandbox selection are
  a candidate confinement mechanism, not yet a proven replacement for our
  native app principal. Test confinement through the actual public wrapper
  before recommending it.

Decision remains open: patchless deployment could reuse the runtime but must
replace both Responses adaptation and owner-consent authentication. Do not
launch a parallel production implementation based only on the available types.

The bounded stock-runtime probe is
`scripts/openclaw-plugin-runtime-probe.test.mjs`. It uses the existing disposable
real provider harness and deterministic inference, not personal credentials.
It exercises a gateway-authenticated test-only plugin route, a dedicated
deny-all native-tools agent plus one client tool, streaming callbacks and a
second prompt with a tool-result marker. It is **not** OAuth, native app-role
enforcement, exact Responses call-ID validation, or sandbox-escape evidence.
The initial assertion incorrectly read pending calls at the result root;
actual public runtime results carry them in `result.meta.pendingToolCalls`.
Corrected probe passed against the published, unpatched pinned runtime on
2026-09-06 (quiet-run handle `XH3D7L`): exactly two inference requests, only
`lookup_book` offered, pending call returned, second-turn text streamed, and
the original prompt remained in the second inference request. This confirms
the execution building blocks, not the missing authorization composition.

Owner-auth investigation found another stock supported seam:
`api.registerGatewayMethod(name, handler, { scope: "operator.admin" })`.
`docs/plugins/sdk-overview.md` documents required authenticated-profile checks
by default; `src/plugins/registry-registrars-network.ts` records the scope and
profile requirement. The handler receives `client`, including its authenticated
profile. Thus an approval RPC could check the configured owner profile and
commit our existing grant without either new HTTP-principal helper. This is
source evidence only; an actual plugin RPC authorization test is outstanding.

A provider-hosted consent page could use the published browser-safe
`@openclaw/gateway-client/browser` surface to call that RPC. Owner credentials
must stay at the provider origin; Bookhand receives only app credentials.
Do not treat the read-only embedded-frame cookie as mutation authorization.
The stock documented generic-client bootstrap requires device identity and
pairing. Tailscale's special WebSocket path recognizes operator UI client IDs;
claiming the built-in Control UI identity is not yet established as a supported
third-party plugin login contract. Therefore **seamless Tailscale consent is
still unproven**, even though stock authenticated RPC is a plausible alternative
to implementing password verification ourselves.

Investigation outcome: retain the native patch path for the current vertical
slice; preserve patchless deployment as a concrete follow-up, not a second
simultaneous implementation. The supported execution probe removes one major
unknown. The remaining cost is a plugin-owned Responses adapter and a validated
owner WebSocket login/approval surface. Finish the already-built native consent
composition test next; do not switch live routes without owner approval.

The remaining native-patch validation path, if retained, is:

1. **Passed 2026-09-06:** combined isolated actual compiled plugin flow:
   PAR → managed-ingress/WhoIs fixture consent → issued token → native client
   tool call → refresh rotation → function output → final model text. Ordinary
   listener forged identity headers fail. Exactly two deterministic inference
   requests, only the approved tool. Reproduction:
   `scripts/openclaw-consent-composition.test.mjs`; quiet-run `03MTsz`.
   The fixture must use the explicit test-only Tailscale binary override:
   PATH shadowing failed because OpenClaw hardens PATH. This does not prove
   live owner authentication or subscription/browser acceptance.
2. Obtain owner approval before changing live Tailscale routes or subscription
   runtime setup. Follow the two-stage owner bootstrap in
   `openclaw-native-application-principal-seam.md`. Never approve real consent
   for the owner, expose credentials, or infer ownership from forwarded headers.
3. Coordinate with the existing Bookhand Codex in tmux `cdx2:1.1`; it owns the
   dirty `work/openclaw-tutor-demo` checkout. It received SDK/patch provenance
   and reports its integration, focused tests, and disconnected mobile browser
   checks pass. Verify current state rather than overwriting its work.
4. Run real owner consent and subscription-backed Bookhand source lookup →
   useful saved Study artifact → contextual follow-up → reload/source-link
   verification. Preserve partial effects; no automatic replay after ambiguity.

## Contract reminders

Historical operator constraint after the composition checkpoint: the user
allows replacing/stopping the Bookhand test deployment, but explicitly rejects
granting agents Tailscale operator rights. Do not request blanket sudo, sudo
credential caching, or install a privileged helper as a workaround. The user
removed the private HTTPS 443 route manually; a read-only status check confirmed
it absent, with no public Funnel enabled. Other routes remain unchanged.

Live startup is still blocked by the pinned host's managed-Serve lifecycle:
`server-runtime-state.ts` opens an ephemeral loopback ingress and awaits
`prepareManagedTailscaleIngress`; `server-tailscale.ts` then requires its own
active CLI route claim. A manual proxy to ordinary gateway ingress is not an
equivalent authentication path. A supported manual-Serve deployment mode would
need an explicit implementation/design decision and validation. Removing the
old route alone did not unblock live startup. Do not claim a provider is ready
or restart subscription services until that deployment boundary is resolved.

Superseding operator decision: the user subsequently granted the local account
Tailscale operator access and removed Funnel permission in tailnet policy.
Read-only checks confirmed no Funnel capabilities and no public exposure.
Authorized changes remain limited to private demo Serve, not DNS, SSH, exit
nodes, subnet routes, logout or unrelated routes. Manual-Serve implementation
is no longer required for this live slice. The isolated demo runtime is being
replaced using its existing subscription state (no credential copy); personal
`agc` is untouched. Owner bootstrap precedes enabling app consent.

Live checkpoint: the user successfully logged into native Control UI and sent
chat messages. A single real owner profile was observed, then explicitly bound
to the owner role and consent allowlist. The demo now has default-denied roles
and a dedicated application-tools-only agent; native tools remain denied.
Multi-agent configuration requires `agents.ownership: explicit` in this pin.
The consent-enabled host restarted successfully; actual private HTTPS OAuth
discovery returned 200. Existing subscription state was reused, not copied.
The Bookhand agent was notified that native OAuth is ready. Fresh app consent
and the Bookhand tool/artifact/follow-up acceptance still remain unproven.

Bookhand uses memory-only per-tab credentials, with pending PKCE/intent in
sessionStorage. One shared connection generation/getter spans features; book
conversations have independent lifetimes. Every request carries the full fixed
approved tool declarations. Refresh uses caller-owned atomic compare-and-swap;
cross-tab CAS alone does not serialize refresh requests. The required separate
AI SDK dependency patch and installation steps are in `connect-your-ai-sdk.md`.

For native app-only policy, use explicit `tools.deny: ["*"]`: an empty native
allowlist is permissive. Managed Tailscale owner authentication uses the actual
listener-attributed request; ordinary HTTPS owner login remains outside v0.
