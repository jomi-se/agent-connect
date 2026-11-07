# Current work

Updated: 2026-11-06

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
platform packages and box are **0.0.5**, prepared on 2026-11-05 to ship
container engines (Podman as well as Docker, ADR 0020), gateway-owned egress,
background box refresh, and the removal of `init`, the `egress` command and the
durable-home option. Versions are independent and
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

Optional [client-address policies](../install/configuration.md#trusted-client-addresses-for-admission-limits)
partition admission behind trusted proxies using exact configured origins and
actual transport peers. Untrusted forwarding headers are ignored; unusable trusted
headers share a bounded fallback group. Source request/sign-in limits retain the
global ceilings and existing owner-session exemption without address-binding
cookies or CSRF. Focused real HTTP coverage exercises trust, source isolation,
shared fallback, pending-session preservation, address changes and audit redaction.

Fixture cleanup checks exact recorded session ownership before removing immutable
Docker IDs. Shutdown waits for observed child exit before removing its files,
and CLI tests clean their own roots after success or assertion failure. A linked
worktree also uses the repository's shared secret scanner installation. Signal
cancellation during allocation remains separate unfinished work.

CI acceptance now supports explicit reuse of release artifacts with a clean-source
receipt, complete checksums and strict platform payload validation. All gateway
binary consumers use the selected native executable; the test box uses the
separately selected Linux runner. Repository checks and real artifact-mode Node,
owner UI, complete adapter/boxed, teardown and clean-room gates pass without a
Cargo rebuild or debug-binary fallback. The [release guide](../install/release.md)
describes the opt-in mode and its trusted-workflow evidence boundary; publication
still builds separately.

CI runs every `verify:full` gate and `cargo test --locked --workspace` on every push to main, as parallel jobs reused when their inputs were already verified green, and the release workflow publishes only that verified commit. The artifact-only
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
  in [the credential model](credentials.md). A [research proposal](../research/2026-10-28-browser-grant-dpop.md) compares browser proof transports; transport, recovery and migration decisions remain open.
- Replace TOTP with passkeys, as a second factor after the passphrase for
  sign-in and approvals. [ADR 0019](../decisions/0019-owner-passkeys.md) is
  proposed; migration policy and library compatibility remain unresolved.
  Allow one passkey per entry
  point address, since a passkey is bound to its domain. The first enrollment on
  each address is first-come, so operators enroll right after exposing an
  address. Recovery is a host-side `reset-passkey`, matching `reset-totp`. The
  owner pages' CSP needs a nonce for the WebAuthn script.
- Require Podman 5 and remove the egress keepalive container
  (`keepalive_name` in `crates/gateway/src/sandbox.rs`). It exists only
  because Podman 4 tears down the shared rootless network when the last
  session disconnects the egress from it. First confirm on Podman 5 that the
  network survives that disconnect without it. Setup and `doctor` then refuse
  Podman 4, and the Podman 4 notes in the install docs go too (the 4.9 test
  floor, the layer copy across id mappings).
- Pin the box's harness versions, once updating them is quick and painless.
  Until then they float, as [ADR 0018](../decisions/0018-floating-harness-versions.md)
  decided, and CI is the early warning. That warning depends on timing:
  claude-agent-acp 0.101.0 started Claude Code sessions in auto mode, whose
  classifier answered permission requests itself, so the Claude profiles
  stopped applying. CI caught it only because a push happened to build a
  box twenty minutes after the release. Pinning needs, first:
  1. One step (a command or a scheduled bot PR) that finds new releases of
     the four harnesses, bumps the pins and says what changed upstream.
  2. A battery of tests that the bump runs by itself, which shows whether
     each harness still behaves the way the gateway relies on: permission
     requests reach the profiles, app tools, cancellation, resume, boxed
     and clean-room gates, plus an opt-in real-model canary, since the
     deterministic model cannot exercise a harness's own model calls.
  3. A pass that is cheap to merge and a failure that names the harness and
     the behaviour that changed.

  Then a new ADR supersedes 0018. Owners keep `versions.json` to move ahead
  of, or back from, the pins.

- Interrupted or hung test runs can leave a test gateway, `quiet-run` sessions
  and gigabytes of temporary folders behind for days. Make teardown survive
  interruption.
- Continue reducing CI time without dropping gates. Release-artifact reuse
  removes the acceptance runner/gateway rebuilds, and CI runs static, Rust,
  web and gateway jobs in parallel, reusing any whose inputs were already
  verified green. The gateway builds once with cached Rust dependencies and
  runs its gates in four parallel jobs. Remaining possibilities are:
  1. Cache Docker box layers between runs.
  2. Run the gateway scenarios concurrently; today the longest gate job runs
     them one after another.
  3. Maybe shorten the test-only waits in `*-cut`, `expire` and `overflow`
     (8 to 17 seconds each), keeping the timeout behaviour they prove.
