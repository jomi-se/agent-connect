# Documentation

Start with the root [README](../README.md) for the product, Canvas app, real
gateway, SDK example, supported platforms, and verification commands.

## Current sources of truth

- [Mission](mission.md): product promise, current strategy, acceptance boundary,
  and non-goals.
- [Scope inventory](scope-inventory.md): implemented, deferred, and explicitly
  unsupported capabilities plus their validation surfaces.
- [Target architecture](architecture/target-architecture.md): component and
  trust boundaries, current provider path, and future adapter seams.
- [Testing strategy](architecture/testing-strategy.md): rule for provider truth,
  three evidence layers, and verification commands.
- [Current work](plan/current-work.md): canonical unfinished work and bounded
  experiments.
- [Web application integration](guides/web-app-integration.md): package the SDK,
  authorize a gateway, stream a task, handle browser-owned tools, and revoke
  access.
- [Real Omnigent + Codex gateway](../deploy/real-gateway/README.md): install
  and operate the source reference profile.
- [Firebase deployment](guides/firebase-demo-deployment.md): deploy the static
  Canvas without placing Firebase credentials on the gateway.
- [Local code-quality analysis](guides/code-quality-analysis.md): ESLint,
  dependency-cruiser, Knip, and jscpd commands, scope, and baseline policy.
- [Build Week submission](plan/openai-build-week-submission.md): historical
  presentation, judge instructions checklist, video outline, and deadline.

The [experimental ACP/MCP-over-ACP profile](architecture/narrow-protocol-profile.md)
documents an unstable prototype. It is not the default browser/gateway path.

## Current design direction

- [ADR 0010: Open Responses at the application boundary](decisions/0010-open-responses-gateway-pivot.md)
  is the leading proposed protocol direction and defines its evidence gates.
- [Containerized gateway deployment](plan/containerized-gateway-deployment.md)
  remains supporting packaging research, not a required architecture.

The older [AG-UI compatibility spike](plan/ag-ui-compatibility-spike.md) is
historical. AG-UI is no longer an active core-protocol experiment.

## Current accepted decisions

- [ADR 0002: Omnigent as the first provider](decisions/0002-omnigent-conductor.md)
- [ADR 0003: Tailnet HTTPS gateway](decisions/0003-tailnet-https-gateway.md)
- [ADR 0005: Trusted transport profiles](decisions/0005-trusted-transport-profiles.md)
- [ADR 0007: Runtime card and gateway authorization](decisions/0007-runtime-card-and-gateway-authorization.md)
- [ADR 0008: Control plane and runtime confinement boundary](decisions/0008-control-plane-and-runtime-confinement-boundary.md)

## Proposed decisions

- [ADR 0009: Separate ingress, owner authentication, and application authorization](decisions/0009-separate-ingress-owner-authentication-and-application-authorization.md)
- [ADR 0010: Open Responses at the application boundary](decisions/0010-open-responses-gateway-pivot.md)

## Future work

- [Multi-turn task continuation](future/multi-turn-task-continuation.md):
  letting an application continue a finished task instead of restarting it.
  Proposed, not started; requires changes to the response chain lifecycle.

## Superseded and historical decisions

- [ADR 0001: ACP-first application boundary](decisions/0001-acp-first-application-boundary.md)
- [ADR 0004: Pairing and session broker](decisions/0004-pairing-and-session-broker.md)
- [ADR 0006: Explore AG-UI application boundary](decisions/0006-explore-ag-ui-application-boundary.md)

## Evidence and research

- [Original product/runtime handoff](../USER_OWNED_AGENT_RUNTIME_HACKATHON_HANDOFF.md)
- [Omnigent/Codex nonce experiment](experiments/omnigent-codex-nonce.md)
- [Grant-route security retrospective](plan/grant-route-security-retrospective.md)
- [Landscape snapshot, 2026-07-13](research/2026-07-13-landscape.md)
- [Mutual runtime identity, 2026-07-14](research/2026-07-14-mutual-runtime-identity.md)
- [AG-UI fit, 2026-07-14](research/2026-07-14-ag-ui-fit.md)
- [Malicious-application threat model, 2026-07-14](research/2026-07-14-malicious-application-runtime-threat-model.md)
- [Omnigent sandbox spike, 2026-07-14](research/2026-07-14-omnigent-vm-sandbox-spike.md)
- [Build Week requirements snapshot, 2026-07-14](research/2026-07-14-openai-build-week-refresh.md)
- [Live protocol animation research, 2026-07-18](research/2026-07-18-live-protocol-animation.md)
- [Claude Code Remote Control internals, 2026-07-24](research/2026-07-24-claude-code-remote-control-internals.md)
- [Open Responses and WebMCP handoff, 2026-08-27](research/2026-08-27-open-responses-webmcp-handoff.md)
- [Ousterhout review of the Open Responses pivot, 2026-08-26](reviews/2026-08-26-ousterhout-open-responses-design-review.md)

Research and handoff documents preserve dated evidence. Their recommendations
may be superseded by the mission, accepted decisions, architecture, or current
work.
