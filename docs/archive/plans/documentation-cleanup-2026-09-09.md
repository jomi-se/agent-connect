# Documentation cleanup ledger (2026-09-09)

Status: complete. This bounded ledger records the docs-only cleanup scope; it
is not a product roadmap or an implementation gate.

## Scope

- Make the root and stock OpenClaw setup guides agree with the published
  `@open-agent-connect/web@0.0.4` and
  `@open-agent-connect/openclaw-plugin@0.0.2` packages.
- Keep `gateway`, `/agent-connect`, the stock OpenClaw host boundary, the
  `127.0.0.1:18790` application listener, and native `127.0.0.1:18789`
  distinction explicit.
- Separate deterministic package/host evidence from the owner's owner-reported
  live Bookhand vertical-slice success.
- Reduce active-plan clutter by archiving completed or superseded management
  plans while preserving dated rationale and useful evidence links.
- Keep the two deferred review debts (listener-port policy fingerprint and
  doctor's weak readiness identity) visible as non-gates.

## Constraints

Docs only: no implementation, service, auth, grant, ingress, Tailscale,
model, network deployment, package publication, push, or private state changes.
Personal hostnames, home paths, credentials, and secret state do not belong in
public documentation.

## Checkpoint ledger

- [x] Inventory canonical docs, active plans, archive, package manifests, and
      plugin setup/doctor implementation.
- [x] Update canonical README, mission/status inventory, and setup guidance.
- [x] Archive completed/superseded plans and repair their index links through
      status wrappers and the archive index, retaining source paths for evidence
      link stability.
- [x] Run narrow Markdown link and formatting checks; review the final diff.

## Evidence boundary

The published package versions and reference-deployment pin/install are recorded from the
release/deployment handoff and repository history. The complete live vertical
slice is an owner report, not an independently replayed edge-case certificate.

## Handoff

Review corrected historical source-map labels and the public Responses route,
restored the unfinished legacy/native-patch and personal-metadata cleanup tasks,
and distinguished the removed ADR 0014 scoped proxy from the older gateway code
still present. Historical documents are archived in place with status labels;
their rationale and existing links are retained.

No implementation, service, auth, grant, ingress, Tailscale, model, network
deployment, publication, push, or private state action was taken. The pending
Canvas migration remains owned by another session.
