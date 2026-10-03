# Current work

Updated: 2026-10-03

The ACP product candidate is **0.1.0-alpha.1**: packaged browser SDK and Rust
launcher/platform binaries, hosted owner sign-in/consent/grant management, dedicated login
helper (`agent-connect login`, harness selector and shared default homes), boxed sessions, resumable transport/recovery and AI SDK useChat.
The [artifact install guide](../install/README.md) works without a checkout.
The [release guide](../install/release.md) covers protected automation and local
validation. ADR 0016 remains proposed and no ACP artifact is published.

Local gates exercise real pinned adapters with deterministic inference. The
clean-room gate installs release tarballs in a fresh container, builds the
standalone sample against the packed SDK, and verifies owner consent/denial, refresh and revocation, app tools, ongoing
reconnect without duplication, cancellation and genuine browser back/forward
cache restoration, including a pending app tool. A separate boxed teardown gate
checks idle/active bye, expiry, shutdown and allocation failures before driver
cleanup; capacity remains held until cleanup completes. This is credential-free
composition evidence, not live subscription evidence. Native plan conversion
has contract coverage; the selected pinned harness fixtures expose no plan tool.

The OpenClaw plugin is the previous published installation target and remains
in the repository and on npm (`@open-agent-connect/openclaw-plugin@0.0.7`).
Its existing SDK imports remain functional with declaration-level deprecation
labels. No npm deprecation or plugin removal has occurred. Windows is not yet
supported by the ACP release matrix.

Local product parity is complete. `agent-connect setup` provides guided and
unattended planning/application, `doctor` supplies actionable human/JSON diagnosis,
and user-service commands manage systemd/launchd definitions. The owner console
includes health/problem guidance, live sessions/end-session, revoke-all,
forget-browser, immutable supported profiles, multiple entry points and offline
TOTP recovery. The sample automatically recovers interrupted transport without
replaying uncertain prompts or application effects.

`npm run verify` and `cargo test --locked --workspace` pass. The artifact-only
clean-room passes 26 checks, including real browser pairing, setup/doctor,
offline service lifecycle, sessions/end-session, revoke-all, app tools,
reconnect/cancel and browser back/forward cache restoration. All six owned hosts
are removed. The owner UI covers twenty states at desktop, phone and 320 px
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

1. **Remaining live credential checks.** The owner reported successful dedicated
   Codex device login and a sample chat with a completed `read_passage` call.
   Personal-session coexistence and dedicated-login
   revocation still require explicitly authorized owner-run checks. Claude subscription use
   remains unconfirmed against Anthropic terms; confirming that optional path
   requires provider/owner action. Automated checks remain credential-free;
   the owner initiated the successful live turn.
2. **First real release run.** Configure the protected GitHub environment,
   package ownership/trusted publishers and public GHCR visibility, push the
   reviewed source and version tag yourself, then inspect a manual dry run and
   approve publication. Verify anonymous image pulls, the complete native
   matrix (including native service operation on macOS and Codex filesystem
   policy on a compatible sandbox host) and the public artifact installation path. None of
   these account/GitHub/registry actions has been performed locally.
3. **ADR 0016 acceptance.** Decide whether the implemented hosted authorization and
   shared-home credential boundary are acceptable, and accept the decision
   explicitly before the publication workflow can proceed.

Earlier OpenClaw follow-ups retain their canonical architecture/future briefs;
this status page does not schedule downstream app migrations or plugin retirement.
