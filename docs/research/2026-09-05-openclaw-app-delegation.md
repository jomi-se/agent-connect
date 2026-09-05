# Can OpenClaw replace the Agent Connect gateway?

Date: 2026-09-05. Status: investigation, not a cutover decision.

## Answer

**Yes: an owner-installed OpenClaw plugin can supply the missing application
delegation layer without a core patch or a separate Agent Connect server.** A
disposable implementation now executes against published OpenClaw 2026.9.1:
originless approval, app-specific native sessions, multiple Responses turns,
native tools alongside client tools, and revocation. This is executable
feasibility evidence, not a production-ready plugin or live migration.

OpenClaw is a good execution substrate, but its stock 2026.9.1 Responses ingress
does not provide the complete third-party browser delegation experience we want.
A genuine device token is rejected by `/v1/responses`; its WebSocket permissions
do not automatically become HTTP permissions. There is also no working ordinary
cross-origin browser preflight on that endpoint in the tested configuration.

This does **not** justify retaining our response engine. The missing responsibility
is application authorization and ingress integration, not another agent loop,
stream normalizer, conversation engine, or provider credential manager.

The product requirement clarified by José is: an app lends capabilities to the
user's normally capable agent. Web research and other owner-approved capabilities
should remain available. Restrict the application's control authority; do not
equate safety with disabling every agent tool. A capable agent still processes
untrusted app context: delegated credentials do not solve prompt injection.

## Evidence and limits

Inspected source archive: `/tmp/openclaw-contract.suVXov/openclaw-2026.9.1`.
Executed the published pinned OpenClaw 2026.9.1 with the existing isolated test
runtime and deterministic local inference. No real model allowance, personal
credentials, Bookhand actions, or live gateway configuration were used or changed.

The [probe](support/openclaw-delegation-probe.mjs) uses published internal pairing
functions to create/approve a disposable device and issue its token. This proves
token issuance/verification and the actual HTTP boundary, **not a browser pairing
ceremony or WebSocket handshake**. Internal chunk names and paths are pinned to
this VM's inspected artifact; it is a research probe, not a supported SDK example.

Executed output (2026-09-05):

```text
PASS genuine paired device token verifies; admin escalation denied
device-token Responses: 401 unauthorized
owner-token with read-only header: 200 completed
cross-origin preflight: 405; no Access-Control-Allow-Origin
PASS revocation enforced; inference was local deterministic fixture only
```

Successful log: `/tmp/agent-connect-command-logs/quiet-run.aUZytK.log`.
The first disposable attempt incorrectly omitted caller scopes on owner approval;
OpenClaw refused to issue a token. The corrected probe supplies owner admin scopes.
Fixture services were stopped in `finally`; temporary evidence/state was retained.
No secret values are in the checked-in probe or this report.

Reproduction on this VM:

```sh
./scripts/quiet-run.sh --detach "delegation auth probe" env \
  PATH=/tmp/agent-connect-openclaw-node/node_modules/.bin:/usr/bin:/bin \
  OPENCLAW_TEST_BIN=/tmp/agent-connect-openclaw-install-rehearsal.V25XnV/install/node_modules/.bin/openclaw \
  node docs/research/support/openclaw-delegation-probe.mjs
```

Current online docs were also checked. They can evolve independently of the pin.
No claims below imply that all role, proxy, and sandbox combinations were executed.

## 1. Can a scoped device token authenticate Responses?

Not through the stock path tested here.

- `src/infra/device-pairing-tokens.ts`: real random tokens, server-side approved
  scope baseline, revocation and scope checks. The record has no ordinary expiry
  timestamp; some browser tokens also bind to a shared-auth generation.
- `src/gateway/server/ws-connection/auth-context.ts`: WebSocket authentication
  invokes `verifyDeviceToken` with device identity, role and requested scopes.
- `src/gateway/http-auth-utils.ts`: selected Control UI read routes explicitly
  verify device tokens. This is not a universal HTTP bearer verifier.
- `src/gateway/openresponses-http.ts`: uses `handleGatewayPostJsonEndpoint` and
  `resolveOpenAiCompatibleHttpOperatorScopes` for `chat.send` permission.
- `src/gateway/auth.ts`: ordinary HTTP auth supports configured shared secret,
  trusted proxy or no-auth modes, not the WebSocket device-token fallback.
- `resolveSharedSecretHttpOperatorScopes` deliberately restores full operator
  defaults on shared-secret auth. A caller-supplied read-only header cannot reduce
  that credential's authority, as the executed probe demonstrates.

Simply adding bearer acceptance would still be incomplete: authentication must
produce an application principal used for agent selection, session ownership,
sandbox provenance and revocation. HTTP proof semantics must be designed rather
than accidentally dropping the WebSocket device-key proof.

## 2. Do existing roles isolate applications?

They provide useful mechanisms, but currently model authenticated people, not
separate applications acting for the same person.

`src/gateway/operator-role-policy.ts` and `src/config/types.gateway.ts` define
agent allowlists, access to other people's sessions, operator scope ceilings and
required sandboxing. Roles require durable authenticated user profiles. A raw
device token does not automatically acquire a separate app profile or sandbox.
Identity-authenticated role configurations also intentionally restrict reuse of
device/bootstrap authentication without verified identity.

`operator.write` is broader than "run my app conversation": the documented scope
includes other gateway-wide mutations/tool invocation. `operator.read` includes
shared-domain diagnostics. Named roles explicitly are not hostile-tenant isolation.
Mapping every app to José's profile does not separate those apps from one another.

Responses already has useful ownership checks:
`resolveResponseSessionAuthSubject` binds continuation to trusted-proxy user or
bearer hash; scope additionally includes agent/user/requested session. The route
calls `authorizeGatewaySessionCreation` and
`authorizeOpenAiCompatibleHttpSession`. These are reuse points, not reasons to
reimplement session management. The continuation cache remains memory-only; auth
reuse does not fix reconnect/durability behavior by itself.

## 3. Can approval happen without revealing the owner secret?

Several ingredients exist: owner Control UI, pairing approval, setup/join codes,
trusted identity and credential revocation. The inspected code does not expose the
complete OAuth authorization-code/PKCE app-registration-and-consent flow described
by José. Provider OAuth and MCP-client OAuth are different directions of trust.

Tailscale matters, but is not automatically an HTTP app credential:
`shouldAllowTailscaleHeaderAuth` in `src/gateway/auth.ts` permits direct Tailscale
identity on `ws-control-ui` and the profile-avatar HTTP surface, **not ordinary
Responses HTTP**. A separately configured trusted proxy can authenticate HTTP
identities and apply role ceilings. It must overwrite identity/scope headers and
be the only permitted ingress; the browser cannot be allowed to assert its own
identity or scope ceiling. Authenticating the owner at consent is separate from
authenticating the app afterward.

A trusted proxy could map an approved owner/app grant to a distinct internal
identity and pin routing, but that would be our proposed delegation integration,
not a stock "just enable OAuth" feature. Session and sandbox creator propagation
through the plugin path is now execution-proven below.

## 4. Does pairing establish website identity?

Generic device identity establishes key continuity, not verified publisher/domain
identity. However, it would be incorrect to say OpenClaw has no origin-bound client
pairing at all:

- `connect-admission.ts` has a dedicated `openclaw-browser-copilot` client. It
  requires UI mode, run-tool-bindings/session-scoped-events capabilities and a
  canonical **Chrome extension** Origin.
- `connect-device-pairing.ts` records and checks that client's `browserOrigin`
  and dedicated paired client identity.
- `chat-send-request.ts` only accepts per-run tool bindings from that paired
  copilot, and requires an explicit browser binding. The browser plugin owns the
  binding schema. These bindings are not the same as arbitrary Responses function
  definitions and function outputs.

This is a relevant existing design to discuss with maintainers. It is not an
ordinary HTTPS-page API, not mobile Bookhand support, and not proof that changing
one client identifier makes it safe. The existing Chrome-extension restriction
would reject such a use. A generic app consent screen should identify the actual
origin, validate redirect destinations, and bind grants to the app; display names
are not enough. PKCE protects code exchange, not every form of phishing.

## Browser and plugin integration

The real endpoint rejects OPTIONS with 405 and does not provide CORS approval in
the tested stock setup. An origin allowlist alone does not implement CORS.
Browser private-network rules and Bookhand CSP also require final real-browser
verification; this probe used HTTP requests, not a browser.

Plugins can register HTTP routes and own authentication (`auth: "plugin"`), but
those routes do not automatically inherit privileged runtime scopes. In
`src/gateway/server-http.ts`, enabled core Responses routes run before ordinary
plugin routes. Do not assume a plugin can transparently replace the existing
`/v1/responses` authentication by registering the same path. There are exceptional
dispatch paths; none establishes a supported general auth-replacement extension.

A separate plugin URL that authenticates then delegates to existing execution now
works in the prototype. A clean typed auth hook at the existing endpoint could
simplify it further. A plugin is trusted host code, not sandboxed
merely because the agent's tool execution is sandboxed.

## Fit and minimum additions

### Follow-up: device-style identity and in-process prototype

José clarified that verified website origins are not a universal requirement.
An explicitly approved installation key/device flow is acceptable, including
native/mobile clients and local forks; optional domain metadata must not be
mistaken for proof that a running binary belongs to that publisher. Reuse the
distinction in [native client identity](../future/native-client-identity.md):
pairing method and publisher assurance are separate axes. The preceding origin
discussion describes a browser option, not a mandatory prerequisite.

A further executable probe used trusted-proxy identities `app:a` and `app:b`,
with native roles restricting other-session access and agent choice. First-turn
admission succeeded and sibling access was denied. But testing a second turn
under **the same identity** exposed `200 -> 403`: the implicitly created Responses
session had not acquired the authenticated creator provenance. Evidence:
`/tmp/agent-connect-command-logs/quiet-run.Ea0vK1.log`. No live state was involved.

Source investigation found an executable remedy using a public SDK: an owner-installed plugin
can register its own public grant-authenticated ingress and a narrow native
gateway-authenticated session-provisioning route. The latter uses
`dispatchGatewayMethod('sessions.create', ...)` from
`openclaw/plugin-sdk/gateway-method-runtime`, with the declared
`contracts.gatewayMethodDispatch: ['authenticated-request']` entitlement, under
the same trusted-proxy app identity. It then forwards to existing Responses.
This retains native creator/sandbox enforcement without a separate process
or a new response engine. The plugin declares an authenticated-dispatch contract;
that is not a general grant of administrator authority to incoming app requests.

The [plugin fixture](support/delegation-plugin/README.md) and
[HTTP probe](support/openclaw-plugin-delegation-probe.mjs) demonstrate:

- An explicitly unverified, originless installation requests access; only the
  owner approves it. Pending, denied and revoked credentials cannot execute.
- Native session precreation stamps the app principal, allowing two subsequent
  turns through the existing JSON/SSE Responses implementation.
- A real native file-read tool executes while client function tools are offered;
  client output returns to the model. No new agent loop or response events are
  manufactured by the plugin.
- Native Responses rejects a sibling principal and a disallowed agent. Plugin
  forwarding reconstructs identity, scope and routing headers, rather than
  passing through the application's assertions.
- The [sandbox probe](support/openclaw-plugin-sandbox-probe.mjs) records the
  required-sandbox stamp before Responses. With Docker deliberately unavailable
  to the disposable service, it fails before inference and does not execute a
  host command. A separate unsandboxed positive control executes that command.
  This proves fail-closed behavior, not successful container execution.

These are **plugin-owned app grants**, not stock OpenClaw device tokens magically
becoming Responses credentials. Native identity roles provide session/agent
enforcement; the plugin provides the approval-to-identity mapping. Publisher
verification is optional future metadata, not something this fixture implements.

There is an important deployment constraint: expose only the public plugin
routes through existing ingress. Do not expose the ordinary trusted-proxy
listener's root through Tailscale Serve: caller-supplied identity headers could
then reach core routes as trusted assertions. The private provisioning route
lives outside the public prefix. A disposable exact-route proxy verifies this
boundary; actual Tailscale configuration has not been changed or validated.
Local processes able to reach the trusted listener remain trusted.

See [the feasibility scope and contracts](../plan/openclaw-delegation-spike/README.md).
The ordinary plugin SDK does not expose an arbitrary authority-minting Responses
delegate; this proposal composes existing authenticated routes instead.

| Route                                          | Enough today?                              | Remaining responsibility                                                    |
| ---------------------------------------------- | ------------------------------------------ | --------------------------------------------------------------------------- |
| Trusted personal frontend + owner token        | Execution yes; cross-origin web needs work | Explicit broad trust and browser ingress                                    |
| Paired device + existing WebSocket client      | Trusted-client chat building blocks        | App isolation and general app-tool binding are not established              |
| Device bearer directly to Responses            | No, executed 401                           | Auth integration plus app principal/policy                                  |
| Trusted proxy + user roles                     | Promising enforcement substrate            | App grants, owner consent, app identity, browser ingress, composition tests |
| Native OpenClaw application-delegation feature | Best conceptual fit; not found shipped     | Consent/grants and app-aware enforcement on existing Responses              |

The minimum desired addition is an **application grant**, authenticated on the
Responses ingress, with owner/app identity, allowed agent, conversation ownership,
revocation and policy reference. Reuse existing sandbox/tool/approval policies:
the normal agent can retain web search or other owner-approved abilities. The app
must not gain administrative access just because the agent has useful tools.
Destructive actions still need the owner's chosen approval policy; approvals
delivered only through an untrusted app would not be independent owner approval.

A practical compatibility fallback is a narrow authorization proxy: terminate
app authentication, enforce ownership/routing, and forward Responses without a
second response state machine. That is still some gateway responsibility, but not
the custom implementation we currently have. Use of existing OpenClaw identity
roles is now demonstrated in the in-process spike above.

Next: productize the small plugin boundary only after reviewing its deployment
constraints; ask maintainers whether a direct app-principal ingress hook is
preferred. Do not repair the
entire replacement engine just to preserve it. Do not expose the owner bearer as
a supposedly restricted app token. Do not promise that existing roles are a
complete third-party-app security boundary.

## Roadmap/community findings

[PR #25736](https://github.com/openclaw/openclaw/pull/25736) proposed scoped,
expiring, individually revocable gateway tokens. GitHub API reports unmerged and
closed 2026-03-08. The author said they closed it to reduce the active queue and
would revisit token scoping. That is contributor intent, not an accepted roadmap
or implementation. Public issue/doc searches found no confirmed full app-consent
feature; absence from search is not proof none exists elsewhere.

The official [contribution guide](https://github.com/openclaw/openclaw/blob/main/CONTRIBUTING.md)
points questions to [Discord](https://discord.gg/clawd), especially #help and
#users-helping-users. No message or issue was posted.

Suggested maintainer question:

> We want third-party HTTPS apps to lend function tools to a user's normally
> capable agent through Responses. On 2026.9.1 our isolated probe shows a real
> scoped device token gets 401 at /v1/responses, and its CORS preflight gets 405.
> We found identity roles and the origin-bound Chrome browser-copilot pairing path.
> Is there a supported app-approval flow that issues a revocable credential for
> Responses, isolates the app's conversations/control authority, and retains the
> agent's normal owner-approved tools? Can existing pairing/roles compose into it,
> or is an HTTP auth/principal hook or generalization of browser-copilot planned?
> We'd rather contribute that missing part than maintain another agent gateway.

## Primary references

- [Responses](https://docs.openclaw.ai/gateway/openresponses-http-api)
- [Client pairing](https://docs.openclaw.ai/gateway/clients)
- [Operator roles](https://docs.openclaw.ai/gateway/operator-scopes)
- [Trusted proxy](https://docs.openclaw.ai/gateway/trusted-proxy-auth)
- [Sandboxing](https://docs.openclaw.ai/gateway/sandboxing)
- [Plugin HTTP routes](https://docs.openclaw.ai/plugins/architecture-internals)
- [Pinned source](https://github.com/openclaw/openclaw/tree/v2026.9.1)

## Still unproven or intentionally absent

The fixture has memory-only grants and sessions: production credential storage,
expiry, rate/capacity limits, fixed approved tool snapshots, concurrency and
disconnect policy remain work. It has no owner consent UI, device-key possession
ceremony, browser CORS/private-network validation, or publisher verification.
Revocation is checked on the next request; active-stream revocation was not proved.
Integrating this auth configuration with the owner's normal OpenClaw clients,
actual route-limited Serve deployment, successful sandboxed execution, and a
Bookhand/subscription hero still need validation. Unrestricted native host-file
tools can read secrets; app-token isolation is not tool sandboxing or a solution
to prompt injection. One native tool proves composition, not all capabilities.

Research establishes the plugin direction; it does not close the replacement's
release gate. The earlier real demo still has observed
multi-call rejection and swallowed stream errors, and remains unsuitable as
evidence of reliable end-to-end integration.
