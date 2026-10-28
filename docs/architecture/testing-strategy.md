# Testing strategy

Test against the real dependency we ship. If an ACP adapter or harness update
could invalidate an assertion, exercise that real pinned dependency rather than
an imitation of its events.

## Evidence layers

1. Agent Connect invariants: focused SDK and Rust tests exercise grants, fixed
   tools, argument validation, admission, continuation, cancellation, revocation,
   resume and owned resource cleanup. Controlled contract fixtures cover exact
   races and deliberate faults without claiming harness compatibility.
2. Real adapters with deterministic inference: `npm run verify` (in CI on every
   PR and push to main) runs the pinned
   Codex and Claude ACP adapters on host and in boxes with isolated HOME/XDG
   state. The clean-room gate installs packed artifacts in a fresh container,
   builds the public sample and exercises owner approval, tools, reconnect,
   cancellation and browser lifecycle. No personal login is involved.
3. Real-model application composition: opt-in runs use the packaged gateway and
   SDK, owner-run dedicated logins, real models and application-owned state.
   These prove meaningful tool use and user-visible behavior; deterministic
   inference does not substitute for them.

## Commands

Use Node 24 LTS >=24.15 and <25, Docker and the pinned ACP build tools. Boxed
gates build the box with the latest harnesses from npm, as owners get them; the
unboxed compatibility fixtures keep their own adapter pins. Native browser gates use
`config/webmcp-test-compat.json`.
The owner browser gate also requires the `openssl` command to generate a
temporary test certificate and key; CI uses Ubuntu 24.04. OpenSSL is a test
tool dependency, not a gateway runtime requirement.

```sh
npm run check                           # fast gates, after every change
npm run verify -- test:ui:owner         # only the box-backed steps you touched
npm run verify:full                     # everything; CI runs this
cargo test --locked --workspace
```

Keep all harness homes isolated. Never forward API-key environment variables,
invoke personal logins, or replay uncertain prompts/effects. Tests own their
containers, networks and processes; cleanup must leave shared peers alone and
retain capacity until owned resources are removed.

## Owner cookie and HTTPS evidence

The owner UI gate retains its HTTP loopback checks and adds an isolated gateway
fixture behind a Node standard-library HTTPS reverse proxy. Chromium exercises
the real gateway's anonymous and authenticated cookies, rejects attempts to
shadow the prefixed cookie with `Domain` or another path, and checks legacy
cookie pollution, session replacement and logout. Credentials and owner state
are synthetic; no personal login or provider subscription is used.

The proxy certificate and key are generated at runtime with OpenSSL and removed
during fixture cleanup. Chromium uses `ignoreHTTPSErrors` for this self-signed
certificate. The probe checks HSTS header emission, but cannot establish browser
HSTS learning or upgrade behavior with an untrusted certificate. Rust router
tests cover exact Host selection, forwarding-header spoofing, HTTP exclusion
and HSTS on success, errors and fallback responses.

The owner browser gate also follows the actual retry link after a failed
passphrase check, completes sign-in to the original consent, and checks the
original application callback and state after denial. A cookie removed before
submission exercises the missing-session explanation. Rust tests cover
continuation/issuer/expiry binding, spent CSRF, ambiguous cookies and persistence
failure without issuing owner authority.

Scoped tracing tests exercise real sign-in rejection boundaries, require one
event per failure, and verify secret-marker exclusion, strict entry-point
attribution, retention limits and pause expiry. The browser fixture leaves
`RUST_LOG` unset to check default audit output, owner-only history and actual
rate-limit pause presentation without changing the main fixture's budget.

## Fixture storage

Fixtures live under `deploy/gateway/test/fixtures`. Dependency trees and
per-run caches are removed after owned processes stop, on success and failure.
Diagnostic output lives outside repositories. `AGENT_CONNECT_KEEP_TEST_INSTALLS=1`
is an explicit debugging opt-in, never a default. Clean each temporary artifact
when no active work needs it. A disconnect proves neither that generation
stopped nor that an already-started application effect did not happen.

Setup acceptance installs the packed launcher and Linux platform package in an
isolated HOME/XDG environment, builds the local box from their files, and checks
owner-context hash changes, reuse and failed-build fallback. Box tests check the
curated tools, one Claude binary selected by the real adapter/SDK, the code-mode
host Codex uses for MCP tools, and Codex ACP turns without the optional voice
host. Runtime proxy and home boundaries remain the same; builds use normal
network access. See
[local box decision](../decisions/0017-local-box-build.md).

Native WebMCP gates allocate a free loopback port and a fresh results directory.
`WEBMCP_PORT` and `PLAYWRIGHT_OUTPUT_DIR` provide explicit overrides. The selected
values are shared with test workers, so gates can run alongside existing previews.
