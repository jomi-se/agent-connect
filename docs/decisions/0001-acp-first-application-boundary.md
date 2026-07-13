# ADR 0001: Use ACP as the application boundary

Status: accepted as a long-term boundary; deferred from the hackathon critical path

Date: 2026-07-13

## Context

Codex app-server already has multiple clients, language SDKs, WebSocket bridges, and dynamic-tool wrappers. A new Codex client would not express the broader product idea and would duplicate existing protocol work.

ACP already models client-to-agent sessions, prompts, updates, cancellation, permissions, and session-provided MCP servers. Its draft MCP-over-ACP work models the reverse application-capability path.

## Decision

The durable application-facing boundary will use ACP and the draft MCP-over-ACP
shape. The web SDK's public API will remain harness-neutral and capable of
backing a browser-friendly ACP client with an embedded application-owned MCP
server.

For the hackathon, the wire below that public API will use the selected
provider's proven transport: OmniGENT HTTP/SSE session events with
request-scoped tools. ACP-over-WebSocket and MCP-over-ACP remain an experimental
adapter until the application-to-Codex loop is complete. This avoids making two
draft transports prerequisites for proving temporary capability lending.

Custom methods are permitted only for remote ownership and durability behavior that ACP does not currently specify. They must not duplicate standard ACP session or prompt behavior.

## Consequences

- Applications do not depend on OmniGENT or Codex types.
- Draft protocol changes are isolated inside an experimental adapter.
- The first implementation may require translation for downstream adapters that advertise `mcpCapabilities.acp: false`.
- Stable remote reconnect and pending-request recovery remain product work beyond ACP transport.
- The first gateway transport is provider-specific internally, but the browser
  API is not.
