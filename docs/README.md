# Documentation

Start with the root [README](../README.md) for the product overview, current
installation, SDK example, supported platforms, and verification commands.

## Current sources of truth

- [ACP artifact installation](install/README.md): checkout-free setup, dedicated
  login, hosted app consent, Docker egress, sample chat and operator maintenance.
- [ACP release process](install/release.md): local acceptance artifacts and
  protected, owner-run OIDC/image publication.
- [ACP SDK](../packages/web-sdk/README.md): unstable provider, recovery and useChat.
- [Mission](mission.md): product promise, current strategy, acceptance boundary,
  and explicit non-goals.
- [Scope inventory](scope-inventory.md): implemented, deferred, and unsupported
  capabilities plus their evidence boundary.
- [Agent Connect plugin for OpenClaw architecture](architecture/agent-connect-openclaw-plugin.md): listener
  layout, trust boundaries, lifecycle, and supported host policy.
- [Target architecture](architecture/target-architecture.md): component and
  trust boundaries and future adapter seams.
- [Browser SDK building blocks](architecture/browser-sdk-building-blocks.md):
  headless chat and WebMCP tool-source contracts.
- [Testing strategy](architecture/testing-strategy.md): provider truth and the
  three evidence layers.
- [Current work](plan/current-work.md): the small set of genuine unfinished work
  and explicit non-gates.
- [Previous OpenClaw plugin setup](../deploy/openclaw-gateway/README.md): install the
  published plugin, configure the dedicated listener, run doctor, and forward
  public HTTPS safely.
- [Previous OpenClaw web application integration](guides/web-app-integration.md): install the
  published SDK, authorize a gateway, stream a task, handle browser-owned tools,
  and revoke access.
- [npm publication and release verification](guides/npm-publication.md):
  pack/release checks and the owner-controlled future publication procedure.
- [Firebase deployment](guides/firebase-demo-deployment.md): deploy the
  historical static Canvas demo without putting Firebase credentials on a
  gateway.
- [Local code-quality analysis](guides/code-quality-analysis.md): ESLint,
  dependency-cruiser, Knip, and jscpd commands and baseline policy.

[`plan/`](plan/) holds only active execution plans. Completed and superseded
plans, dated evidence ledgers and design material live under
[`archive/`](archive/README.md); they are provenance, and their commands and
gates are not current instructions.

## Accepted decisions

- [ADR 0015: Agent Connect plugin for OpenClaw host](decisions/0015-openclaw-plugin-host.md)
  is the active installation decision.
- [ADR 0005: Trusted transport profiles](decisions/0005-trusted-transport-profiles.md)
  and [ADR 0008: Control-plane and runtime confinement boundary](decisions/0008-control-plane-and-runtime-confinement-boundary.md)
  remain rationale for security and trust boundaries where they do not conflict
  with ADR 0015.

ADR 0001, 0002, 0004, 0006, 0007, and 0009–0013 are retained as superseded or
historical decision records; [ADR 0014](archive/decisions/0014-stock-openclaw-scoped-proxy.md)
is archived with the standalone proxy decision it replaced. Their history is
not erased, but they do not define today's installation or application routes.

## Deferred direction and dated evidence

The [north star](vision.md) is accepted product direction, not a finished
standard or implementation promise. The [narrow protocol profile](architecture/narrow-protocol-profile.md)
records the unstable protocol boundary. The ACP prerelease install path is
implemented; ADR 0016 remains proposed and publication remains owner-gated.
Future deployment, native-client identity, and multi-turn documents are
design exploration only. Dated research, reviews, experiments, and the
historical Canvas/Build Week material remain under their existing directories;
use the archive index and each document's date/status for provenance.
