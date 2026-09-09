# Documentation

Start with the root [README](../README.md) for the product overview, current
installation, SDK example, supported platforms, and verification commands.

## Current sources of truth

- [Mission](mission.md): product promise, current strategy, acceptance boundary,
  and explicit non-goals.
- [Scope inventory](scope-inventory.md): implemented, deferred, and unsupported
  capabilities plus their evidence boundary.
- [Stock OpenClaw architecture](architecture/stock-openclaw-plugin.md): listener
  layout, trust boundaries, lifecycle, and supported host policy.
- [Target architecture](architecture/target-architecture.md): component and
  trust boundaries and future adapter seams.
- [Testing strategy](architecture/testing-strategy.md): provider truth and the
  three evidence layers.
- [Current work](plan/current-work.md): the small set of genuine unfinished work
  and explicit non-gates.
- [Stock OpenClaw setup](../deploy/openclaw-gateway/README.md): install the
  published plugin, configure the dedicated listener, run doctor, and forward
  public HTTPS safely.
- [Web application integration](guides/web-app-integration.md): install the
  published SDK, authorize a gateway, stream a task, handle browser-owned tools,
  and revoke access.
- [npm publication and release verification](guides/npm-publication.md):
  pack/release checks and the owner-controlled future publication procedure.
- [Firebase deployment](guides/firebase-demo-deployment.md): deploy the
  historical static Canvas demo without putting Firebase credentials on a
  gateway.
- [Local code-quality analysis](guides/code-quality-analysis.md): ESLint,
  dependency-cruiser, Knip, and jscpd commands and baseline policy.

The [archive index](archive/README.md) lists completed and superseded execution
plans, dated evidence ledgers, and design material. Archived documents remain
useful provenance, but their commands and gates are not current instructions.

## Accepted decisions

- [ADR 0015: Stock OpenClaw plugin host](decisions/0015-openclaw-plugin-host.md)
  is the active installation decision.
- [ADR 0005: Trusted transport profiles](decisions/0005-trusted-transport-profiles.md),
  [ADR 0007: Runtime-card and gateway authorization](decisions/0007-runtime-card-and-gateway-authorization.md),
  and [ADR 0008: Control-plane and runtime confinement boundary](decisions/0008-control-plane-and-runtime-confinement-boundary.md)
  remain rationale for security and trust boundaries where they do not conflict
  with ADR 0015.

ADR 0001, 0002, 0004, 0006, and 0009–0013 are retained as superseded or
historical decision records; [ADR 0014](archive/decisions/0014-stock-openclaw-scoped-proxy.md)
is archived with the standalone proxy decision it replaced. Their history is
not erased, but they do not define today's installation or application routes.

## Deferred direction and dated evidence

The [north star](vision.md) is accepted product direction, not a finished
standard or implementation promise. The [narrow protocol profile](architecture/narrow-protocol-profile.md)
is an unstable ACP/MCP-over-ACP prototype, not the default browser/gateway path.
Future deployment, native-client identity, tunnel, and multi-turn documents are
design exploration only. Dated research, reviews, experiments, and the
historical Canvas/Build Week material remain under their existing directories;
use the archive index and each document's date/status for provenance.
