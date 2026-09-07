# ADR 0013: Native provider delegation and AI SDK execution

Date: 2026-09-06.
Status: accepted direction; implementation and composition verification in progress.

Architectural hardening, 2026-09-07: native admission is the authority
linearization point. After plugin authentication and parsed-request authorization,
core fences the exact plugin lifecycle generation, resolves the current opaque
host-policy revision, and carries that immutable effective config through native
runtime preparation. Pre-admission retirement or revision denies; post-admission
revocation does not actively cancel. Agent Connect capability/strict/media/tool
recipe semantics remain in the plugin. Grant sessions use nonhuman application
creation provenance while reusing the profile store only as an internal ownership
key. Owner HTTP authentication is a separate generic verified-principal hook whose
current accepted method remains listener-proven Tailscale WhoIs.

## Decision

Follow the [OpenClaw-first plan](../plan/connect-your-ai-openclaw.md). Replace
the application-facing custom conversation/model loop with AI SDK and its Open
Responses provider. Put application grant verification inside OpenClaw through
a narrow native extension, not another permanently required proxy or Responses
engine. This supersedes ADR 0012's separate policy-gateway implementation
prescription, not its requirement for narrowly delegated application authority.

Owner authentication and application authorization are separate. Tailscale can
authenticate a configured owner through host-verified ingress identity. Ordinary
HTTPS can use another owner login. Both share grant issuance, verification,
expiry and revocation. Never infer ownership from arbitrary forwarded headers,
a hostname, or membership of a tailnet alone.

## Native enforcement boundary

The proposed core extension is limited to native Responses:

1. An owner-installed plugin authenticates its recognizable application bearer.
   Invalid claimed credentials deny terminally; they cannot fall through to
   shared owner authentication.
2. Core assigns a stable plugin-namespaced application identity and requires an
   explicit closed operator-configured policy. Missing policy cannot fall back
   to ambient owner authority. The plugin cannot accept client-selected native
   profile identifiers or routing headers.
3. A narrow post-parse authorization check verifies the approved application
   tool snapshot before media fetching, session creation or model execution.
4. Core carries the verified creator and required sandbox policy into native
   session creation and execution, and binds continuation to the application
   identity. Token refresh must not change that identity.

Use actual OpenClaw session/agent/tool policies for enforcement. Native tool
permissions are not synonymous with `operator.write`. Configured app execution
profiles must exclude personal bootstrap data and unrelated sessions. Optional
code execution means an isolated sandbox, never ambient host filesystem access.
Exact extension types and deployment patch are being validated, not asserted as
already available upstream APIs.

## Client boundary

The inference adapter receives an endpoint and bearer getter. It does not
interpret grant internals. Connection code owns OAuth/PKCE and renewal; AI SDK
owns streaming and the application tool loop. Existing page-owned fixed tools
remain usable directly, so mobile Bookhand does not depend on native browser
WebMCP discovery support. No tool-consent expansion is implied.

The pinned AI SDK Open Responses adapter currently lacks usable explicit
previous-response continuation. Implement a small reproducible additive adapter
patch and use public step hooks rather than private request-body interception
or a new loop. Preserve the source patch and exact dependency provenance in the
repository, and prove that Bookhand installs the same patched behavior. This is
a temporary downstream dependency change, not an upstream support claim.

## Validation and scope

The target is the actual Tailscale owner-consent -> app token -> AI SDK -> native
OpenClaw -> Bookhand tool/result/follow-up flow. Deterministic dependency checks
and one small real-subscription/browser composition prove different things.
Existing separate-gateway success does not close this architecture's gates.

No automatic transcript replay after ambiguous mutations, shared owner bearer
in the browser, implicit newest-session adoption, mandatory hosted relay,
compatibility-provider expansion or live cutover is introduced by this decision.
