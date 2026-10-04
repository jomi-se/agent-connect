# Testing strategy

Test against the real dependency we ship. If an ACP adapter or harness update
could invalidate an assertion, exercise that real pinned dependency rather than
an imitation of its events.

## Evidence layers

1. Agent Connect invariants: focused SDK and Rust tests exercise grants, fixed
   tools, argument validation, admission, continuation, cancellation, revocation,
   resume and owned resource cleanup. Controlled contract fixtures cover exact
   races and deliberate faults without claiming harness compatibility.
2. Real adapters with deterministic inference: `npm run verify` runs the pinned
   Codex and Claude ACP adapters on host and in boxes with isolated HOME/XDG
   state. The clean-room gate installs packed artifacts in a fresh container,
   builds the public sample and exercises owner approval, tools, reconnect,
   cancellation and browser lifecycle. No personal login is involved.
3. Real-model application composition: opt-in runs use the packaged gateway and
   SDK, owner-run dedicated logins, real models and application-owned state.
   These prove meaningful tool use and user-visible behavior; deterministic
   inference does not substitute for them.

## Commands

Use Node 24 LTS >=24.15 and <25, Docker and the pinned ACP build tools. Adapter
pins live in the gateway and box manifests. Native browser gates use
`config/webmcp-test-compat.json`.

```sh
npm run verify
npm run verify:full
cargo test --locked --workspace
```

Keep all harness homes isolated. Never forward API-key environment variables,
invoke personal logins, or replay uncertain prompts/effects. Tests own their
containers, networks and processes; cleanup must leave shared peers alone and
retain capacity until owned resources are removed.

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
curated tools, one Claude binary selected by the real adapter/SDK, and Codex ACP
turns without optional voice/code-mode hosts. Runtime proxy and home boundaries
remain the same; builds use normal network access. See
[local box decision](../decisions/0017-local-box-build.md).
