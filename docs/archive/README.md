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
  that led to the product gateway and ADR 0016 (accepted 2026-10-04).

## Browser SDK building blocks

Current contracts: [browser SDK building blocks](../architecture/browser-sdk-building-blocks.md).

- [Headless chat](plans/headless-chat.md), [WebMCP tool source](plans/webmcp-tool-source.md)
  and [CSP-safe SDK validation](plans/csp-safe-sdk-validation.md): plans and
  dated validation evidence.

## Standalone gateway era

The pre-plugin Omnigent/Open Responses gateway and its replacement engine.

- [Open Responses vertical slice](plans/open-responses-vertical-slice.md): its
  historical validation records and protocol pin remain under
  `contract/` but are not current guarantees.
- [Multi-turn task continuation](plans/multi-turn-task-continuation.md)

## Explorations not pursued

- [AG-UI compatibility spike](plans/ag-ui-compatibility-spike.md)
- [Containerized gateway deployment](plans/containerized-gateway-deployment.md)

## Event material and maintenance records

- [Build Week submission](plans/openai-build-week-submission.md),
  [project description](plans/build-week-project-description.md) and
  [video cue card](plans/build-week-video-cue-card.html)
- [Repository maintenance](plans/repository-maintenance.md)
- [Hackathon handoff](hackathon-handoff.md): the earliest project document.

## Superseded experiments, proposals and reviews

Moved here when the legacy SDK was removed. The OpenClaw-era plugin, plans,
decisions and reviews were deleted on 2026-11-25; Git history keeps them.

- Experiments: [ACP gateway spike results](experiments/acp-gateway.md) and
  [Omnigent–Codex composition](experiments/omnigent-codex-nonce.md).
- Proposals from before the ACP gateway:
  [deployment tiers](future/deployment-tiers-and-confinement.md),
  [multi-turn task continuation](future/multi-turn-task-continuation.md) and
  [setup quality candidates](future/setup-quality-candidates.md).
- Reviews: [consolidated repository review](reviews/2026-07-26-consolidated-repo-review.md),
  the Open Responses [design review](reviews/2026-08-26-ousterhout-open-responses-design-review.md),
  [implementation review](reviews/2026-08-28-open-responses-implementation-review.md)
  and [re-review](reviews/2026-08-29-open-responses-re-review.md).

## Retired product proposals

- [Connect your AI vision](vision.md): Open Responses profile; the current north star lives in [mission](../mission.md).
- [Native client identity](future/native-client-identity.md): research against the removed HTTP gateway; requires a new ACP decision.
