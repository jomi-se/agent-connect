# ADR 0001: Use ACP as the application boundary

Status: superseded as the application-facing direction by proposed ADR 0010;
ACP remains an optional harness-facing adapter

Date: 2026-07-13

Amendment (2026-08-27): ADR 0010 makes a bounded Open Responses profile the
leading proposed application boundary. New application-facing work should not
target ACP or unstable MCP-over-ACP. ACP remains available behind the gateway
where its stable harness-facing capabilities fit.

## Context

Codex app-server already has multiple clients, language SDKs, WebSocket bridges, and dynamic-tool wrappers. A new Codex client would not express the broader product idea and would duplicate existing protocol work.

ACP already models client-to-agent sessions, prompts, updates, cancellation, permissions, and session-provided MCP servers. Its draft MCP-over-ACP work models the reverse application-capability path.

## Decision

The durable application-facing boundary will use ACP and the draft MCP-over-ACP
shape. The web SDK's public API will remain harness-neutral and capable of
backing a browser-friendly ACP client with an embedded application-owned MCP
server.

For the hackathon, the wire below that public API will use the selected
provider's proven transport: Omnigent HTTP/SSE session events with
request-scoped tools. ACP-over-WebSocket and MCP-over-ACP remain an experimental
adapter until the application-to-Codex loop is complete. This avoids making two
draft transports prerequisites for proving temporary capability lending.

Custom methods are permitted only for remote ownership and durability behavior that ACP does not currently specify. They must not duplicate standard ACP session or prompt behavior.

## Consequences

- Applications do not depend on Omnigent or Codex types.
- Draft protocol changes are isolated inside an experimental adapter.
- The first implementation may require translation for downstream adapters that advertise `mcpCapabilities.acp: false`.
- Stable remote reconnect and pending-request recovery remain product work beyond ACP transport.
- The first gateway transport is provider-specific internally, but the browser
  API is not.
