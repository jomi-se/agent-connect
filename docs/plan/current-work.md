# Current work

Updated: 2026-10-04

The ACP product candidates are gateway **0.0.1** and root browser SDK
**0.0.10**: Rust launcher/platform binaries, hosted owner sign-in/consent/grant management, dedicated login
helper (`agent-connect login`, harness selector and shared default homes), boxed sessions, resumable transport/recovery and AI SDK useChat.
The [artifact install guide](../install/README.md) works without a checkout.
The [release guide](../install/release.md) covers protected automation and local
validation. [ADR 0016](../decisions/0016-acp-application-boundary.md) was
accepted on 2026-10-04: ACP is the product vision and chosen open standard.
ACP, MCP-over-ACP and the resume extension remain unstable. No ACP artifact
is published. [ADR 0017](../decisions/0017-local-box-build.md) replaces registry
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
platform packages and box are **0.0.1**. Versions are independent and
remain on 0.0.x until the shape is final. Applications import the ACP browser API from the package root.

Local product parity is complete. `agent-connect setup` provides guided and
unattended planning/application, `doctor` supplies actionable human/JSON diagnosis,
and user-service commands manage systemd/launchd definitions. The owner console
includes health/problem guidance, live sessions/end-session, revoke-all,
owner sign-out, immutable supported profiles, multiple entry points and offline
TOTP recovery. The sample automatically recovers interrupted transport without
replaying uncertain prompts or application effects.

Release qualification reruns `npm run verify:full` and `cargo test --locked --workspace` against the exact reviewed ACP-only candidate. The artifact-only
clean-room passes 26 checks, including real browser pairing, setup/doctor,
offline service lifecycle, sessions/end-session, revoke-all, app tools,
reconnect/cancel and browser back/forward cache restoration. All six owned hosts
are removed. The owner UI covers twenty-four states at desktop, phone and 320 px
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
2. **First real release run.** Releases publish automatically from `main`
   ([release process](../install/release.md)). After the first run, verify the complete native
   matrix (including native service operation on macOS and Codex filesystem
   policy on a compatible sandbox host) and the public artifact installation path.
