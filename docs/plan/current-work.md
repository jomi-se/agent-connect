# Current work

Updated: 2026-10-28

Gateway **0.0.1** and root browser SDK **0.0.10** were published to npm on
2026-10-04: Rust launcher/platform binaries, hosted owner sign-in/consent/grant management, dedicated login
helper (`agent-connect login`, harness selector and shared default homes), boxed sessions, resumable transport/recovery and AI SDK useChat.
The [artifact install guide](../install/README.md) works without a checkout.
The [release guide](../install/release.md) covers protected automation and local
validation. [ADR 0016](../decisions/0016-acp-application-boundary.md) was
accepted on 2026-10-04: ACP is the product vision and chosen open standard.
ACP, MCP-over-ACP and the resume extension remain unstable. [ADR 0017](../decisions/0017-local-box-build.md) replaces registry
boxes with a smaller local setup build from npm-shipped files and optional owner
tools; the release has only native builds and npm publication.

Local gates exercise real pinned adapters with deterministic inference. The
clean-room gate installs release tarballs in a fresh container, builds the
standalone sample against the packed SDK, and verifies owner consent/denial, refresh and revocation, app tools, ongoing
reconnect without duplication, cancellation and genuine browser back/forward
cache restoration, including a pending app tool. A separate boxed teardown gate
checks idle/active bye, expiry, shutdown and allocation failures before driver
cleanup; capacity remains held until cleanup completes. This is credential-free
composition evidence, not live subscription evidence. Native plan conversion
has contract coverage; the selected pinned harness fixtures expose no plan tool.

The browser SDK is **0.0.10** at `@open-agent-connect/web`; gateway, native
platform packages and box are **0.0.4**, prepared on 2026-10-24 to ship the
Brotli decoder fix (CVE-2026-111497), resolve open dependency advisories and let
the box take the latest harnesses with owner pins (ADR 0018). Versions are independent and
remain on 0.0.x until the shape is final. Applications import the ACP browser API from the package root.

Local product parity is complete. `agent-connect setup` provides guided and
unattended planning/application, `doctor` supplies actionable human/JSON diagnosis,
and user-service commands manage systemd/launchd definitions. The owner console
includes health/problem guidance, live sessions/end-session, revoke-all,
owner sign-out, immutable supported profiles, multiple entry points and offline
TOTP recovery. The sample automatically recovers interrupted transport without
replaying uncertain prompts or application effects.

HTTPS entry points now use prefixed owner cookies with consistent issuance,
acceptance and logout, and the complete hosted router emits HSTS for the exact
configured HTTPS Host. HTTP loopback keeps its plain cookie policy. The
[credential model](credentials.md) describes fresh owner sign-in after upgrading
from legacy cookies; [configuration](../install/configuration.md#https-reverse-proxy)
documents HSTS scope and first-visit limits. Repository checks, the owner UI
gate and gateway integration scenarios pass. The TLS browser probe verifies
cookie enforcement and HSTS emission; it does not establish HSTS learning.

Failed owner sign-in now preserves a validated pending application approval
through the retry link, rechecking its entry point and expiry with fresh CSRF.
Missing and duplicate session cookies receive specific, non-secret explanations.
Repository checks, the owner UI gate and gateway integration scenarios pass.

The gateway publication script streams npm output, requires a successful
registry version listing before upload and confirms each published version.
Ambiguous results stop without repeating an upload; only bounded read-only
confirmation is retried. Repository checks and injected/fake-npm publication
tests pass.

Failed sign-in auditing and owner Activity pause/history summaries use fixed
reason codes and bounded ephemeral retention. Default audit output, owner-only
history and actual pause deadlines pass the browser gate; repository checks and
gateway integration scenarios pass.

Mock Codex provider configuration now comes only from test fixtures seeded into
owned disposable homes, rather than the production launcher or box. Fresh local
package builds, boxed scenarios, teardown and artifact-only clean-room pass,
including actual archive/image exclusion and default/seeded-config checks.

CI runs `npm run verify:full` and `cargo test --locked --workspace` on every push to main, and the release workflow publishes only that verified commit. The artifact-only
clean-room passes 26 checks, including real browser pairing, setup/doctor,
offline service lifecycle, sessions/end-session, revoke-all, app tools,
reconnect/cancel and browser back/forward cache restoration. All six owned hosts
are removed. The owner UI covers twenty-five states at desktop, phone and 320 px
reflow widths, with keyboard/touch checks. The completed
[parity checklist](../archive/plans/acp-gateway-parity.md) records each capability
and independent-review outcome.

Qualification limits remain explicit: native systemd/launchd operations have
isolated manager-contract coverage and offline unit validation; macOS execution
awaits first-release platform validation. Codex read-only mode is correctly
configured and approved app tools succeed, but the tested Docker environment
refuses nested namespace creation before native tool execution. A prevented
write is fail-closed evidence, not independent filesystem-policy qualification;
the first-release platform matrix must check a host supporting that sandbox.
Per-app box isolation is deferred, Windows is unsupported, and mobile approval
and recovery codes remain future work; owner TOTP and offline recovery exist.

Owner-required work:

1. **Dedicated credential qualification.** Personal-session coexistence and
   dedicated-login revocation require explicitly authorized owner-run checks.
   Confirm the provider terms for optional subscription harnesses before release.
   Default automated gates use deterministic inference without real logins;
   opt-in real-model acceptance requires owner-prepared dedicated harness homes.
   Keep login status and live-run evidence in private artifacts, outside this
   product repository.
2. **Platform validation.** Releases publish automatically from `main`
   ([release process](../install/release.md)); the first one is out. Verify the complete native
   matrix (including native service operation on macOS and Codex filesystem
   policy on a compatible sandbox host) and the public artifact installation path.

Backlog:

- Bind grants to the browser that paired, using sender-constrained tokens (for
  example DPoP, RFC 9449, with a non-extractable WebCrypto key). Today the only
  binding is the `Origin` header, which a non-browser client sets freely. A
  copied refresh token therefore works from anywhere until the grant expires or
  reuse detection revokes it. The current bearer-token theft risk is documented
  in [the credential model](credentials.md).
- Replace TOTP with passkeys, as a second factor after the passphrase for
  sign-in and approvals. [ADR 0019](../decisions/0019-owner-passkeys.md) is
  proposed; migration policy and library compatibility remain unresolved.
  Allow one passkey per entry
  point address, since a passkey is bound to its domain. The first enrollment on
  each address is first-come, so operators enroll right after exposing an
  address. Recovery is a host-side `reset-passkey`, matching `reset-totp`. The
  owner pages' CSP needs a nonce for the WebAuthn script.
- Interrupted or hung test runs can leave a test gateway, `quiet-run` sessions
  and gigabytes of temporary folders behind for days. Make teardown survive
  interruption.
- Tell clients apart behind a reverse proxy. Every proxied request reaches the
  gateway from loopback, so all visitors share one sign-in budget, one anonymous
  request budget and one pending-sign-in cap, and anyone can exhaust them. Let an
  entry point name a trusted client-address header (for example
  `CF-Connecting-IP`), honoured only for that entry point's Host, with a shared
  fallback bucket when the header is missing. Key the sign-in budget, anonymous
  limits and pending-sign-in sessions on it.
- CI takes about 25 minutes, roughly half of it build overhead. Speed it up
  without dropping gates, cheapest first:
  1. The release build compiles the gateway three times and `verify.mjs`
     compiles it twice more for the test box (about two minutes each). Let
     verify reuse the release artifact, which also tests the shipped binary.
  2. Cache Rust dependencies and Docker box layers between runs.
  3. Split one serial job into a build job plus parallel jobs for owner UI,
     gateway scenarios, boxed scenarios with teardown, and clean-room.
  4. Maybe shorten the test-only waits in `*-cut`, `expire` and `overflow`
     (8 to 17 seconds each), keeping the timeout behaviour they prove.
