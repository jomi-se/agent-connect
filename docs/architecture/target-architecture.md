# Target architecture

## Component map

```text
browser application
  @agent-connect/web
  ACP client + one embedded MCP server
             |
             | ACP over authenticated WebSocket
             | nested MCP-over-ACP messages
             v
OmniGENT ACP edge adapter
  connection and session mapping
  pending-action persistence
  ACP <-> OmniGENT event translation
             |
             | OmniGENT Sessions API / internal services
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

### ACP edge adapter

Owns upstream ACP semantics, authorization, mapping upstream session IDs to OmniGENT conversations, nested MCP routing, and durable pending application actions. It is the temporary compatibility conductor while native remote ACP and MCP-over-ACP support remain unstable.

### OmniGENT

Owns normalized conversation state, downstream harness processes, policy, streaming, and the selected agent environment. It must not delegate system-of-record responsibility to Codex session files.

### Application

Owns the actual side effect. It receives a stable action ID and must make consequential operations idempotent or journal their result. The conductor cannot infer whether an unacknowledged external side effect succeeded.

## Tool-call translation

```text
1. Browser declares MCP server in ACP session/new.
2. Edge adapter connects and performs MCP initialize + tools/list.
3. Fixed tool schemas are attached to the first OmniGENT turn.
4. Codex calls a tool through OmniGENT's downstream MCP relay.
5. OmniGENT emits action_required.
6. Edge adapter persists a pending action.
7. Edge adapter sends MCP tools/call to the browser over ACP.
8. Browser approves and executes the application handler.
9. Edge adapter posts function_call_output to OmniGENT.
10. Codex resumes and completes the turn.
```

## Fallback architecture

If step 4 or 5 cannot be made reliable with a narrow OmniGENT patch, replace the downstream half with a Codex app-server provider. The application-facing ACP and MCP-over-ACP surface remains unchanged; the provider maps listed tools to Codex `dynamicTools` and maps `item/tool/call` back to the pending-action broker.
