# Documentation

Start with the root [README](../README.md) for the product, public demo, real
connector, SDK example, supported platforms, and verification commands.

## Current sources of truth

- [Mission](mission.md): product promise, current strategy, acceptance boundary,
  and non-goals.
- [Scope inventory](scope-inventory.md): implemented, deferred, and explicitly
  unsupported capabilities plus their validation surfaces.
- [Target architecture](architecture/target-architecture.md): component and
  trust boundaries, current provider path, and future adapter seams.
- [Current work](plan/current-work.md): canonical unfinished work and bounded
  experiments.
- [Web application integration](guides/web-app-integration.md): package the SDK,
  authorize a connector, stream a task, handle browser-owned tools, and revoke
  access.
- [Real OmniGENT + Codex connector](../deploy/real-connector/README.md): install
  and operate the source reference profile.
- [Public judge appliance](../deploy/judge-demo/README.md): build, validate,
  expose, recover, and tear down the deterministic demo profile.
- [Firebase deployment](guides/firebase-demo-deployment.md): deploy the static
  Canvas without placing Firebase credentials on the connector.
- [Build Week submission](plan/openai-build-week-submission.md): presentation,
  judge instructions checklist, video outline, and deadline.

The [experimental ACP/MCP-over-ACP profile](architecture/narrow-protocol-profile.md)
documents an unstable prototype. It is not the default browser/gateway path.

## Active design investigations

- [AG-UI compatibility](plan/ag-ui-compatibility-spike.md)
- [Containerized connector appliance](plan/containerized-connector-appliance.md)

These are plans, not shipped capabilities.

## Accepted decisions

- [ADR 0001: ACP-first application boundary](decisions/0001-acp-first-application-boundary.md)
- [ADR 0002: OmniGENT as the first provider](decisions/0002-omnigent-conductor.md)
- [ADR 0003: Tailnet HTTPS gateway](decisions/0003-tailnet-https-gateway.md)
- [ADR 0004: Pairing and session broker](decisions/0004-pairing-and-session-broker.md)
- [ADR 0005: Trusted transport profiles](decisions/0005-trusted-transport-profiles.md)
- [ADR 0006: Explore AG-UI application boundary](decisions/0006-explore-ag-ui-application-boundary.md)
- [ADR 0007: Runtime card and connector OAuth](decisions/0007-runtime-card-and-connector-oauth.md)
- [ADR 0008: Control plane and runtime confinement boundary](decisions/0008-control-plane-and-runtime-confinement-boundary.md)

## Evidence and research

- [Original product/runtime handoff](../USER_OWNED_AGENT_RUNTIME_HACKATHON_HANDOFF.md)
- [OmniGENT/Codex nonce experiment](experiments/omnigent-codex-nonce.md)
- [Grant-route security retrospective](plan/grant-route-security-retrospective.md)
- [Landscape snapshot, 2026-07-13](research/2026-07-13-landscape.md)
- [Mutual runtime identity, 2026-07-14](research/2026-07-14-mutual-runtime-identity.md)
- [AG-UI fit, 2026-07-14](research/2026-07-14-ag-ui-fit.md)
- [Malicious-application threat model, 2026-07-14](research/2026-07-14-malicious-application-runtime-threat-model.md)
- [OmniGENT sandbox spike, 2026-07-14](research/2026-07-14-omnigent-vm-sandbox-spike.md)
- [Build Week requirements snapshot, 2026-07-14](research/2026-07-14-openai-build-week-refresh.md)
- [Live protocol animation research, 2026-07-18](research/2026-07-18-live-protocol-animation.md)

Research and handoff documents preserve dated evidence. Their recommendations
may be superseded by the mission, accepted decisions, architecture, or current
work.
