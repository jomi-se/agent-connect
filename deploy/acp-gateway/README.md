# ACP gateway packaging dry run

Unreleased implementation of proposed ADR 0016. The OpenClaw plugin remains the
current release. ACP, MCP-over-ACP and the resume extension are unstable.

`dist-workspace.toml` pins cargo-dist 0.33.0 and the three initial targets.
The cargo-dist configuration follows its [official reference](https://axodotdev.github.io/cargo-dist/book/reference/config.html).
CI publishing is deliberately unconfigured. Do not create release tags, publish
packages or push images as part of these local checks.

The npm wrapper uses per-platform optional packages: one installed executable
for the host, with exact adapter and CLI versions in its manifest. Produce each
local platform package with `node scripts/package-acp-gateway.mjs <target> <binary>`;
`npm pack` can inspect it without publishing. A local override supports launcher
smokes before registry artifacts exist. Release installation and macOS validation
remain approval gates.

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
before the owner runs `agent-connect-gateway login`. Claude Code remains
unconfirmed against Anthropic terms. Live login checks are never a build step.

The proxy conservatively permits IPv6 only within the currently allocated
[global unicast range](https://www.iana.org/assignments/ipv6-address-space),
excluding special-purpose blocks and IPv4-mapped addresses. DNS answers are
validated before connecting; reset clients cannot terminate the proxy.

## Verification prerequisites

`npm run verify` requires Node 24, Rust on PATH, the pinned OpenClaw fixture,
Chromium installed for Playwright, Docker and the locally built
`agent-connect-session:0.1.0` image. Build the image with the command above
before the boxed gate. The runners create and remove only their own named
containers and networks, with private temporary homes and a deterministic model.
No credential/login or subscription-backed model is used. Run `cargo test
--locked` for the Rust-owned policy, journal, home and resume invariants.
