# Target architecture

## Component map

```text
browser application
  @agent-connect/web
  define tools, run task, events, approve
             |
             | authenticated gateway channel
             v
Agent Connect gateway
  connection and session mapping
  pending-action persistence
  fixed tool snapshot + provider adapter
             |
             | OmniGENT HTTP/SSE Sessions API
             | request-scoped client tools
             v
OmniGENT conductor
  normalized sessions, policy, harness lifecycle
             |
             | generic ACP harness
             v
@agentclientprotocol/codex-acp
             |
             | Codex app-server
             v
Codex
```

## Ownership boundaries

### Web SDK

Owns browser transport setup, ACP client handlers, application tool registration, the single MCP server implementation, application approval hooks, and reconnection orchestration. It does not know OmniGENT or Codex message shapes.

### Gateway

Owns authorization, mapping application sessions to OmniGENT conversations,
request-scoped tool-schema injection, normalized events, and durable pending
application actions. Its provider interface contains no browser-facing
OmniGENT types.

### OmniGENT

Owns normalized conversation state, downstream harness processes, policy, streaming, and the selected agent environment. It must not delegate system-of-record responsibility to Codex session files.

### Application

Owns the actual side effect. It receives a stable action ID and must make consequential operations idempotent or journal their result. The conductor cannot infer whether an unacknowledged external side effect succeeded.

## Tool-call translation

```text
1. Browser registers a fixed tool snapshot for the application session.
2. Gateway validates and records the snapshot.
3. OmniGENT provider attaches the schemas to the first session message event.
4. Codex calls a tool through OmniGENT's downstream MCP relay.
5. OmniGENT emits action_required.
6. Gateway persists a pending action.
7. Gateway sends the normalized tool call to the browser.
8. Browser approves and executes the application handler.
9. Gateway posts the correlated tool result to OmniGENT.
10. Codex resumes and completes the turn.
```

## Fallback architecture

If the proven OmniGENT path regresses or blocks the browser slice, replace the
provider with a Codex app-server dynamic-tool adapter. The application API and
pending-action broker remain unchanged.

## Deferred ACP adapter

ACP-over-WebSocket plus MCP-over-ACP remains the preferred future standardized
wire candidate. It implements the same gateway/application API after the first
working browser slice; it is not required to demonstrate the hackathon product.
