# Documentation archive

Everything under `docs/archive/` is finished, superseded or abandoned material.
It is kept for provenance only: none of it is current setup, backlog or a
product guarantee, and its commands and gates are not current instructions.
Location is the archive boundary. Active execution plans live only in
[`docs/plan/`](../plan/); when a plan is completed or superseded, move it here
and update its inbound links. Contracts that remain true move to
[`docs/architecture/`](../architecture/) first. Git history is the recovery path
for removed executable implementations.

Historical test and review records keep the exact date and dependency context
under which they were produced. They do not become proof of current provider,
subscription, ingress or mobile behavior by remaining in the tree.

## ACP gateway milestones

- [ACP gateway product parity](plans/acp-gateway-parity.md): completed local
  install, operation, owner-console and independent-review qualification.

- [ACP gateway spike](plans/acp-gateway-spike.md) and
  [mobile resume](plans/acp-gateway-mobile-resume.md): completed experiments
  that led to the product gateway and ADR 0016 (proposed).

## Agent Connect plugin for OpenClaw (ADR 0015)

The plugin was the previous published installation target. Its source and
tests were removed from the repository once the ACP gateway replaced it; the
published versions remain on npm. Its architecture is
[agent-connect-openclaw-plugin.md](agent-connect-openclaw-plugin.md); these are
its completed build plans and ledgers.

- [OpenClaw plugin host](plans/openclaw-plugin-host.md): packaging, setup,
  coexistence and stock-host validation.
- [Delegated grants](plans/delegated-grants.md) and
  [grant-route security retrospective](plans/grant-route-security-retrospective.md).
- [Plugin SDK and Bookhand migration](plans/plugin-sdk-bookhand-migration.md).
- [Connect your AI: SDK](plans/connect-your-ai-sdk.md) and
  [OpenClaw connection client](plans/openclaw-connection-client.md).

## Browser SDK building blocks

Current contracts: [browser SDK building blocks](../architecture/browser-sdk-building-blocks.md).

- [Headless chat](plans/headless-chat.md), [WebMCP tool source](plans/webmcp-tool-source.md)
  and [CSP-safe SDK validation](plans/csp-safe-sdk-validation.md): plans and
  dated validation evidence.

## Superseded OpenClaw approaches

Proposals to patch OpenClaw or change it upstream, abandoned when the stock-host
plugin route was chosen.

- [Connect your AI: OpenClaw sequencing](plans/connect-your-ai-openclaw.md)
- [OpenClaw consent plugin](plans/openclaw-consent-plugin.md)
- [Native application-principal seam](plans/openclaw-native-application-principal-seam.md)
- [Patch proposal hardening](plans/openclaw-patch-proposal-hardening.md)
- [Upstream application-delegation proposal](plans/openclaw-upstream-application-delegation-proposal.md)
- [OpenClaw delegation spike](plans/openclaw-delegation-spike/README.md)
- [OpenClaw scoped proxy](plans/openclaw-scoped-proxy.md) and
  [ADR 0014](decisions/0014-stock-openclaw-scoped-proxy.md)
- [Stock OpenClaw vertical closeout](plans/stock-openclaw-vertical-closeout.md)

## Standalone gateway era

The pre-plugin Omnigent/Open Responses gateway and its replacement engine.

- [Parallel expiring sessions MVP](plans/parallel-expiring-sessions-mvp.md)
- [Open Responses vertical slice](plans/open-responses-vertical-slice.md): its
  historical validation records and protocol pin remain under
  `contract/` but are not current guarantees.
- [Multi-turn task continuation](plans/multi-turn-task-continuation.md)
- [OpenClaw replacement](plans/openclaw-replacement.md)

## Explorations not pursued

- [AG-UI compatibility spike](plans/ag-ui-compatibility-spike.md)
- [Containerized gateway deployment](plans/containerized-gateway-deployment.md)

## Event material and maintenance records

- [Build Week submission](plans/openai-build-week-submission.md),
  [project description](plans/build-week-project-description.md) and
  [video cue card](plans/build-week-video-cue-card.html)
- [Repository maintenance](plans/repository-maintenance.md) and
  [documentation cleanup 2026-09-09](plans/documentation-cleanup-2026-09-09.md)
- [Implementation brief](implementation-brief.md) and
  [hackathon handoff](hackathon-handoff.md): the earliest project documents.

## Superseded experiments, proposals and reviews

Moved here when the OpenClaw plugin and the legacy SDK were removed.

- Experiments: [ACP gateway spike results](experiments/acp-gateway.md) and
  [Omnigent–Codex composition](experiments/omnigent-codex-nonce.md).
- Proposals written for the plugin era:
  [deployment tiers](future/deployment-tiers-and-confinement.md),
  [Firebase canvas plugin migration](future/firebase-canvas-plugin-migration.md),
  [multi-turn task continuation](future/multi-turn-task-continuation.md),
  [owner console and profiles](future/owner-console-and-profiles.md),
  [provider-owned conversation recovery](future/provider-owned-conversation-recovery.md),
  [setup quality candidates](future/setup-quality-candidates.md) and
  [reusing existing gateway components](ideas/reuse-existing-gateway-components.md).
- Reviews: [consolidated repository review](reviews/2026-07-26-consolidated-repo-review.md),
  the Open Responses [design review](reviews/2026-08-26-ousterhout-open-responses-design-review.md),
  [implementation review](reviews/2026-08-28-open-responses-implementation-review.md)
  and [re-review](reviews/2026-08-29-open-responses-re-review.md),
  [plugin feasibility](reviews/2026-09-05-openclaw-plugin-feasibility.md),
  [OpenClaw replacement scrutiny](reviews/openclaw-replacement-scrutiny.md) and
  regressions [OC-SCR-004](reviews/regressions/OC-SCR-004.md) and
  [OC-SCR-005](reviews/regressions/OC-SCR-005.md).
