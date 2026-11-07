# Current work

Updated: 2026-11-07

Where the project stands. What comes next is in [plans](README.md), what is
broken in [issues](../issues/), and what nobody has accepted yet in
[ideas](../ideas/). What each release changed is in the
[gateway](../../packages/gateway-npm/CHANGELOG.md) and
[browser SDK](../../packages/web-sdk/CHANGELOG.md) changelogs.

## Releases

On npm: the browser SDK `@open-agent-connect/web` **0.0.10**, and the gateway,
its native platform packages and the box **0.0.6** (2026-11-06). Versions are
independent and stay on 0.0.x until the shape is final; nothing an owner
installed is kept compatible before 1.0.

0.0.6 gives Podman session networks no DNS, so the egress resolves names again;
logs OpenTelemetry-shaped JSON with no session content
([ADR 0021](../decisions/0021-structured-logs.md)); adds a live canary that
runs real Codex turns through a boxed gateway; and keeps Claude Code out of
auto mode in the box, since auto mode's classifier would answer permission
requests in place of the gateway's profiles. 0.0.5 brought container engines
(Podman as well as Docker, [ADR 0020](../decisions/0020-container-engines.md)),
the gateway-owned egress and background box refresh.

Releases publish automatically from `main`, only for a commit CI verified
([release process](../install/release.md)).

## What CI proves

Every push to main runs every `verify:full` gate and the Rust workspace tests,
as parallel jobs, reusing a job whose inputs were already verified green. The
gates run real adapters against deterministic inference, with no real logins:
gateway scenarios, boxed scenarios and teardown, the owner UI at desktop, phone
and 320 px widths, and the artifact-only clean room, which installs the release
tarballs in a fresh container and checks pairing, setup and doctor, the service
lifecycle, sessions, revocation, app tools, reconnect and cancellation, and
browser back/forward cache restoration.

That is composition evidence, not live subscription evidence. What CI cannot
prove (real credentials, macOS service operation, Codex's filesystem policy on
a host that supports its sandbox) is in
[release qualification](release-qualification/spec.md).

## Decisions in force

ACP is the application boundary
([ADR 0016](../decisions/0016-acp-application-boundary.md)). The box is built
locally from npm-shipped files ([ADR 0017](../decisions/0017-local-box-build.md))
and takes the latest harness releases
([ADR 0018](../decisions/0018-floating-harness-versions.md)) until
[pinning](harness-pinning/spec.md) is painless. ACP, MCP-over-ACP and the
resume extension remain unstable upstream.
