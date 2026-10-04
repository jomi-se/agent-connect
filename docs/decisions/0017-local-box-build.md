# 0017: Build the harness box locally from npm packages

Status: Accepted (2026-10-04)

Agent Connect setup builds `agent-connect-box:<gateway-version>` locally for the
owner's Docker architecture. This replaces the registry-image design completely:
there is no image publication, digest injection, pull fallback or second release
channel. The gateway npm launcher ships the versioned Dockerfile, adapter manifest
and lockfile, entrypoint and egress proxy. Each platform package ships its static
Linux session-runner; Apple Silicon ships the Linux ARM64 runner.

One self-contained package installation supplies the build recipe and executable
inputs. Setup explicitly explains the local build and its approximate size.
Docker build steps use normal network access to obtain the pinned Node base,
locked adapter dependencies and curated OS tools. Running sessions retain owned
proxy egress and dedicated homes. The alpha release favors a simple local build
and npm publication over separate image-registry operations.

The box uses a digest-pinned slim Node base and one pinned Claude binary, selected
explicitly by the real ACP adapter/SDK. Optional owner tools live in an isolated
XDG config `agent-connect/box/` build context. Setup wraps its FROM-free Dockerfile,
reasserts the session user, work directory and entrypoint, and selects a tag from
the gateway version and context hash. A failed build preserves the last configured
box. Doctor detects pending version or owner-context changes. Owner layers remain
local and are never published.

Local tags are version/hash identities rather than signed image attestations.
Native builds and npm artifact checks remain release gates. Live provider quality
and native platform acceptance remain separate from deterministic adapter tests.
