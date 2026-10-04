# Gateway session image and test fixtures

This directory contains the boxed session image, owned egress proxy and
deterministic integration fixtures for Agent Connect. Operators start with the
[install guide](../../docs/install/README.md); source builds and release pins
have their home in the [release guide](../../docs/install/release.md).
ACP, MCP-over-ACP and transport resumption remain experimental.

From the repository root, with the pinned Rust targets, Zig, cargo-zigbuild and
Docker buildx available:

```sh
./deploy/gateway/session/build-local.sh --native-only
```

This cross-builds both Linux static session runners and loads the host session
image. Omit `--native-only` to export a multiarch OCI archive as well. Builds
publish no images and perform no provider login. Target-specific npm dependencies
are installed on the builder architecture; this step needs no QEMU or host
binfmt changes. Cross-target gateway release-info execution has separate runner
requirements in the release guide.

The egress proxy validates DNS destinations and rejects private, reserved and
IPv4-mapped addresses. Each box owns its internal network and tmpfs workspace.
The dedicated shared harness home contains credentials, configuration and
transcripts; read the [credential boundary](../../docs/plan/credentials.md).

`npm run verify` runs host/boxed adapter scenarios, owner UI checks, teardown and
the [artifact-only clean room](test/clean-room/README.md). Fixtures use temporary
homes and deterministic inference. See the
[testing strategy](../../docs/architecture/testing-strategy.md) for evidence limits.
