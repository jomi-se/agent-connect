# 0006: Explore AG-UI as the application-facing boundary

- Status: superseded as the leading exploration by proposed ADR 0010; retained
  as historical analysis
- Date: 2026-07-14

## Context

Amendment (2026-08-27): the project selected a bounded Open Responses profile
as the leading proposed application-facing protocol in
[ADR 0010](0010-open-responses-gateway-pivot.md). The AG-UI spike is no longer
active. AG-UI may be reconsidered only as an optional edge adapter for a
concrete UI requirement that Open Responses does not cover.

ADR 0001 selected ACP as the preferred long-term application boundary because
ACP models agent sessions and its draft MCP-over-ACP work models
application-provided capabilities. The working hackathon path instead uses
Omnigent HTTP/SSE with request-scoped tools behind a custom browser API.

Subsequent investigation found that AG-UI directly targets the missing
frontend-to-agent layer and already models frontend-defined tools, streaming
runs, tool calls, and tool results. ACP remains valuable between the conductor
and coding-agent harness, but its normal trust model and editor-oriented
architecture are less directly aligned with an arbitrary hosted web
application.

AG-UI does not provide user-owned gateway enrollment, destination identity,
per-origin authorization, end-to-end channel binding, runner lifecycle, or
pending-action durability. Those remain Agent Connect responsibilities.

## Proposed direction

Run a bounded compatibility spike in parallel with the existing transport:

- keep the current Omnigent implementation as the passing baseline;
- expose a narrow AG-UI-compatible gateway endpoint;
- translate AG-UI runs, frontend tools, events, cancellation, and tool results
  to the existing Omnigent provider path;
- preserve Agent Connect enrollment, authorization, opaque sessions, tool-hash
  policy, stable action IDs, and recovery outside AG-UI message schemas;
- verify the same live browser-to-Omnigent-to-Codex dynamic-tool round trip;
- adopt AG-UI only if the spike passes the decision gates in the exploration
  plan.

If accepted after the spike, AG-UI supersedes only the application-facing
portion of ADR 0001. ACP remains the preferred gateway-to-agent adapter, and
the experimental direct ACP-over-WebSocket path may remain available for ACP
clients.

## Why this is a profile, not a fork

Agent Connect should use standard AG-UI run, message, and tool representations
unchanged. Gateway enrollment and authorization should be a separate
pre-session security layer, with standard HTTP metadata or headers where
possible. Agent Connect-specific durability metadata must use documented
extension points or remain gateway-internal.

The project must not describe its security extension as part of the AG-UI
standard unless it is accepted upstream.

## Consequences if adopted

- The application-facing wire gains an existing ecosystem and vocabulary.
- Omnigent and `codex-acp` continue to perform Codex orchestration.
- The browser package no longer contains an Omnigent provider.
- Agent Connect's differentiated work becomes secure runtime ownership,
  authorization, reliability, and adapters rather than custom agent event
  semantics.
- Full AG-UI compatibility is not implied; the supported profile and protocol
  version must be explicit and tested.

## Decision gate

This proposal becomes accepted only after the spike demonstrates:

1. official AG-UI client interoperability through a real browser;
2. request-scoped frontend tool execution in the same live Codex turn;
3. no Omnigent or Codex types in the browser-facing transport;
4. no weakening of Agent Connect's enrollment or per-app authorization model;
5. stable action correlation and a credible pending-action recovery mapping;
6. a smaller or more interoperable public protocol surface than the current
   custom dialect.
