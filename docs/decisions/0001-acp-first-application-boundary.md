# ADR 0001: Use ACP as the application boundary

Status: accepted

Date: 2026-07-13

## Context

Codex app-server already has multiple clients, language SDKs, WebSocket bridges, and dynamic-tool wrappers. A new Codex client would not express the broader product idea and would duplicate existing protocol work.

ACP already models client-to-agent sessions, prompts, updates, cancellation, permissions, and session-provided MCP servers. Its draft MCP-over-ACP work models the reverse application-capability path.

## Decision

The application-facing boundary will use ACP and the draft MCP-over-ACP shape. The web SDK will be a browser-friendly ACP client with an embedded application-owned MCP server, not a proprietary agent session protocol and not a Codex app-server wrapper.

Custom methods are permitted only for remote ownership and durability behavior that ACP does not currently specify. They must not duplicate standard ACP session or prompt behavior.

## Consequences

- Applications do not depend on OmniGENT or Codex types.
- Draft protocol changes are isolated inside the SDK and edge adapter.
- The first implementation may require translation for downstream adapters that advertise `mcpCapabilities.acp: false`.
- Stable remote reconnect and pending-request recovery remain product work beyond ACP transport.
