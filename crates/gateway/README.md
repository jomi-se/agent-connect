# Agent Connect Rust gateway

The gateway implements hosted owner sign-in, fixed-tool OAuth consent, ACP
session policy, resumable delivery, durable action journaling and owned Docker
cleanup. It is the native component of Agent Connect, packaged by the
[npm launcher](../../packages/gateway-npm/README.md).
ACP, MCP-over-ACP and `agent-connect.resume.v1` remain unstable. The product decision is
[accepted ADR 0016](../../docs/decisions/0016-acp-application-boundary.md).

For installation and normal operation, use the
[install guide](../../docs/install/README.md). Owner state and grants stay outside
the dedicated harness home. Production sessions are boxed with restricted owned
egress; [shared-home risks](../../docs/plan/credentials.md) remain explicit.
Applications must deduplicate consequential effects using stable action IDs.

From the repository root:

```sh
cargo build --locked --bin agent-connect
cargo test --locked
```

Setup builds the box locally from the installed npm context and matching static
Linux session-runner; optional owner tools use the XDG config `agent-connect/box/`
directory. See [ADR 0017](../../docs/decisions/0017-local-box-build.md).

The [release guide](../../docs/install/release.md) covers distribution builds.
`npm run verify` also exercises real pinned Codex and Claude ACP adapters with
deterministic inference, temporary homes and no provider login. See the
[testing strategy](../../docs/architecture/testing-strategy.md).
