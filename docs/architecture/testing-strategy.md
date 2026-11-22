# Testing strategy

Test against the real dependency we ship. If an ACP adapter or harness update
could invalidate an assertion, exercise that real dependency rather than an
imitation of its events.

## Evidence layers

1. **Agent Connect invariants (fast, offline):** SDK and Rust unit tests
   exercise grants, fixed tools, argument validation, admission, continuation,
   cancellation, revocation, resume, OTel log formatting, per-address owner
   factors (with real `SoftPasskey` signatures and TOTP codes) and owned
   resource cleanup. Controlled contract fixtures cover exact races and
   deliberate faults without claiming harness compatibility.
2. **Real adapters with deterministic inference (`npm run verify`):** CI runs
   every gate on every PR and push to `main` (reusing green jobs whose inputs
   did not change). Boxed gates build the box with the latest harnesses from
   npm ([ADR 0018](../decisions/0018-floating-harness-versions.md)); unboxed
   compatibility fixtures keep their own adapter pins. The clean-room gate
   installs packed release tarballs in a fresh container, builds the standalone
   sample and exercises setup, doctor, pairing, service lifecycle, tools,
   reconnect, cancellation and BFCache restoration. No personal login is used.
3. **Live egress canary (`test:live`, opt-in):** Runs a few short real Codex
   turns through a scratch boxed gateway and its egress proxy against a real
   provider, using `ACP_LIVE_HARNESS_HOME` pointing at a dedicated signed-in
   harness home. Because routine gates use a mock model reached without the
   egress, run this after container-engine, OS, box-image, egress or harness
   changes. It spends tokens and needs credentials, so CI never runs it.
4. **Real-model application composition (opt-in):** Packaged gateway + SDK +
   dedicated logins + real models + application state prove useful behavior
   beyond deterministic inference; see
   [release qualification](../plan/release-qualification/spec.md).

## Commands

Use the Node in `.node-version`, a container engine (rootless Podman on Linux
or Docker; [ADR 0020](../decisions/0020-container-engines.md)) and the Rust
toolchain. Native WebMCP gates use `config/webmcp-test-compat.json`. The owner
UI gate requires `openssl` to generate a temporary self-signed certificate for
its HTTPS cookie fixture (a test-only dependency; CI runs on Ubuntu 24.04).

```sh
npm run check                           # fast gates, after every change
npm run verify -- test:ui:owner         # only the box-backed steps you touched
npm run verify:full                     # full suite (CI runs the same gates in parallel)
ACP_LIVE_HARNESS_HOME=<home> npm run verify -- test:live   # real provider + egress
cargo test --locked --workspace
```

When the egress check or a container engine changes, run the impostor matrix
against each supported engine. It starts containers carrying the egress owner
label and proxy arguments with one weakening each (privileged, unconfined
seccomp or AppArmor, host namespaces, mounts, a device, a published port, a
larger limit, an extra variable, a capability) and requires the gateway to
refuse every one after its own egress passes:

```sh
ACP_BOX_IMAGE=<box image> AGENT_CONNECT_CONTAINER_ENGINE=podman \
  cargo test -p agent-connect-gateway --test egress_impostors -- --ignored
```

Keep all harness homes isolated. Never forward API-key environment variables,
invoke personal logins, or replay uncertain prompts or effects. Tests own their
containers, networks and processes; cleanup leaves shared peers alone and
retains capacity until owned resources are removed.

## Owner auth and browser evidence

Rust tests verify real WebAuthn registration and assertion (`SoftPasskey`) and
TOTP codes, exact-origin and cross-port cookie isolation, session/purpose/CSRF/
expiry binding, replay, concurrent enrollment, no-downgrade (TOTP never removes
a passkey), per-address grant revocation on Security removal, all-grant
revocation on offline recovery (`remove-factor` / `reset-passphrase`),
persistence failure, strict `Host` selection and HSTS headers. Scoped tracing
tests verify one sign-in audit event per failure with no leaked secrets, strict
entry-point attribution, guess vs request-rate budgets and bounded history.

The owner UI browser gate (`test:ui:owner`) runs the real gateway in Chromium
with CSP enforced and a virtual authenticator:

- **`localhost`:** passkey enrollment, sign-in, consent approval, Security
  factor removal (verifying that removing another address's factor revokes
  grants approved there while preserving grants on `localhost`), and runtime
  health banners.
- **`127.0.0.1`:** IP-literal explanation, TOTP enrollment and per-approval
  fresh codes, failed sign-in retry preserving pending consent, and missing
  cookie diagnostics.
- **Isolated HTTPS reverse-proxy fixture:** temporary OpenSSL certificate with
  TOTP (Chromium refuses WebAuthn on untrusted certificates), exercising
  `__Host-` cookie hardening, legacy cookie rejection, HSTS header emission
  (not browser HSTS learning), and default sign-in audit presentation with
  `RUST_LOG` unset.

Virtual authenticators prove the protocol, not mobile or password-manager
devices; real-device checks stay in
[release qualification](../plan/release-qualification/spec.md).

## Fixture storage and cleanup

Fixtures live under `deploy/gateway/test/fixtures`. Per-run mock model config
belongs only to test inputs and disposable harness homes; the production
launcher and base image carry no mock provider configuration. Clean-room checks
that the packed launcher archive excludes fixtures and builds the local box
from the installed package ([ADR 0017](../decisions/0017-local-box-build.md)).

Per-run installs, caches, temporary certificates and test box images are
removed on success and failure. Diagnostic output stays outside repositories;
`AGENT_CONNECT_KEEP_TEST_INSTALLS=1` is an explicit debugging opt-in. Native
WebMCP gates pick a free loopback port and fresh results directory (overridable
via `WEBMCP_PORT` and `PLAYWRIGHT_OUTPUT_DIR`) so they can run alongside active
previews.
