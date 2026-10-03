# ACP gateway builds and deterministic tests

Unreleased implementation of proposed ADR 0016. The product consists of the ACP gateway and root browser SDK. ACP, MCP-over-ACP and the resume extension are unstable.
Operators start with the [artifact install guide](../../docs/install/README.md):
`agent-connect setup` creates a local runtime, or use
`agent-connect setup --origin https://gateway.example` behind your own HTTPS
proxy. Diagnose with `agent-connect doctor`, manage the user service with
`agent-connect service`, and pair applications through hosted owner consent.
The [configuration reference](../../docs/install/configuration.md#https-reverse-proxy)
has portable Caddy/nginx examples; [troubleshooting](../../docs/install/troubleshooting.md)
has recovery and doctor codes. This page covers source-build/test tooling.

`dist-workspace.toml` pins cargo-dist 0.33.0 and the three initial targets.
The cargo-dist configuration follows its [official reference](https://axodotdev.github.io/cargo-dist/book/reference/config.html).
Release automation is described in the [release guide](../../docs/install/release.md).
Do not create release tags, publish packages or push images during local checks.

The npm wrapper uses per-platform optional packages: one installed executable
for the host, with exact adapter and CLI versions in its manifest. Produce each
local platform package with `node scripts/package-acp-gateway.mjs <target> <binary>`;
`npm pack` can inspect it without publishing. The wrapper records adapter pins;
adapters run in the matching image. A local executable override supports launcher
smokes. Registry publication and the first complete platform-matrix run require
owner approval.

Build both Linux static session runners and a multi-architecture OCI archive:

```sh
# Prerequisites: Rust musl targets, Zig and cargo-zigbuild on PATH, Docker buildx.
./deploy/acp-gateway/session/build-local.sh
```

The build installs target-specific npm dependencies on the builder's own
architecture and copies cross-built runners into target images. It requires no
QEMU or host binfmt changes. It uses the local buildx driver.
The OCI output stays local, and only the host architecture is loaded into Docker
for deterministic smoke tests. No registry is contacted for publication.

A production session requires a dedicated private harness home and an
operator-selected egress proxy container. Each session gets its own internal
network; the egress proxy denies private and reserved destinations. The workspace
is tmpfs. The shared home includes credentials, configuration and transcripts.
Read the [accepted credential risk](../../docs/plan/acp-gateway-credentials.md)
before the owner runs `agent-connect login`. Claude Code remains
unconfirmed against Anthropic terms. Live login checks are never a build step.

The proxy conservatively permits IPv6 only within the currently allocated
[global unicast range](https://www.iana.org/assignments/ipv6-address-space),
excluding special-purpose blocks and IPv4-mapped addresses. DNS answers are
validated before connecting; reset clients cannot terminate the proxy.

## Verification prerequisites

`npm run verify` requires Node 24, Rust on PATH, the pinned ACP adapters,
Chromium installed for Playwright, Docker and the locally built
`agent-connect-session:0.0.1` image. Build the image with the command above
before the boxed gate. The runners create and remove only their own named
containers and networks, with private temporary homes and a deterministic model.
No credential/login or subscription-backed model is used. Run `cargo test
--locked` for the Rust-owned policy, journal, home and resume invariants.
