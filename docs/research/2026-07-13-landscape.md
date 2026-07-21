# Agent runtime landscape snapshot

Date: 2026-07-13

## Codex app-server

Codex app-server is a capable local JSON-RPC embedding surface. It provides sessions, turns, streaming, approvals, history, authentication, and experimental dynamic tools that call back into the hosting client. Its WebSocket listener and dynamic-tool surface are explicitly experimental.

Multiple third-party clients and SDKs already wrap app-server, including dynamic-tool implementations and stdio-to-WebSocket bridges. Building another generic app-server client is therefore not the product opportunity.

## Codex ACP adapters

Development moved from `zed-industries/codex-acp` to `agentclientprotocol/codex-acp`. The maintained adapter is built on Codex app-server and supports ChatGPT/API authentication plus session-provided stdio and HTTP MCP servers. At the inspected commit it advertised `mcpCapabilities.acp: false`.

## ACP and MCP-over-ACP

Stable ACP covers most application-to-agent session behavior. The ACP repository and official TypeScript SDK contain unstable MCP-over-ACP types and methods, including ACP MCP server descriptors and connect/message/disconnect operations. The feature remains outside the stable schema and is not supported by the maintained Codex ACP adapter.

The official TypeScript SDK already provides an experimental WebSocket client transport. Its own documentation notes that ACP v1 reconnect creates a new physical connection and does not replay in-flight messages.

## Omnigent

Omnigent can drive arbitrary configured ACP agents and supply tools through an ordinary per-session stdio MCP relay. It also accepts request-supplied client tool schemas and can surface `action_required` calls for application execution.

Its generic ACP relay captures and caches the tool set when the downstream session is created. That matches the proposed fixed-tools-per-session hackathon profile. The exact composition through the maintained Codex ACP adapter has not yet been proven live.

Omnigent's Sessions SSE is live-tail. Current source and tests state that `action_required` client calls are not persisted as conversation items. Durable pending interactions remain necessary for reconnect-safe mutations.

## Resulting hypothesis

The smallest differentiated project is not a Codex client. It is an ACP-first application SDK plus conductor translation that lets an arbitrary application lend temporary MCP tools to a user-owned agent and recover consequential pending calls across disconnects.
