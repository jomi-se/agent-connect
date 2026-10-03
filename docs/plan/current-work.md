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

Hosted authorization and review hardening pass targeted local gates: optional
TOTP, exact-origin S256 PKCE, rotating grants, bounded policy state, terminal
transport faults, egress preflight and release-image verification. The fresh
artifact-only clean-room passes all 16 checks with actual browser owner approval,
denial, refresh and revocation. Earlier static-bearer evidence remains separate.
`npm run verify` and `cargo test --locked --workspace` pass, including the new
consent-based clean-room gate. The owner-page browser gate additionally covers
14 states at desktop, phone and 320 px reflow widths, with keyboard/touch checks
and private screenshots. These completed gates do not establish install and
operation parity with the plugin. The active
[ACP gateway parity plan](acp-gateway-parity.md) tracks guided setup, doctor,
service management, console sessions/profiles/recovery and expanded clean-room
acceptance. That product work remains before the owner-required items below.

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
   matrix (including macOS) and the public artifact installation path. None of
   these account/GitHub/registry actions has been performed locally.
3. **ADR 0016 acceptance.** Decide whether the implemented hosted authorization and
   shared-home credential boundary are acceptable, and accept the decision
   explicitly before the publication workflow can proceed.

Earlier OpenClaw follow-ups retain their canonical architecture/future briefs;
this status page does not schedule downstream app migrations or plugin retirement.
