# Mission: application-owned tools for user-owned agents

## Objective

Build a web-first SDK and user-owned conductor that let an arbitrary application use a long-running agent as its intelligence provider while temporarily exposing typed, scoped application capabilities back to that agent.

The hackathon implementation uses Codex as the demonstrated downstream agent. Its application boundary should remain compatible with other ACP agents.

## Product promise

An application can:

1. connect to a runtime owned by its user;
2. create or resume an agent session;
3. supply a task and a fixed set of application-owned tools;
4. receive streamed progress and permission requests;
5. execute requested application operations locally;
6. return tool results without installing an MCP server into Codex;
7. recover an unresolved application action after a network interruption without blindly duplicating a mutation.

## Current strategy

- Give web applications a harness-neutral tool and task API.
- Use OmniGENT's existing HTTP/SSE Sessions API as the first transport and
  conductor implementation. OmniGENT selects and launches the user's underlying
  agent harness; the application does not depend on that choice.
- Supply a fixed tool snapshot on each task's first session message. Execute
  `action_required` calls in the application and return correlated results.
- Keep OmniGENT wire types behind a browser-safe adapter so ACP-over-WebSocket,
  MCP-over-ACP, or another conductor can implement the same public API later.
- Add the smallest durability extension necessary for unresolved application
  actions after the browser loop works; do not claim generic exactly-once
  execution.

## Hackathon acceptance boundary

The next accepted slice is a browser-safe client bound to one already-created,
online OmniGENT session. It streams one task, lends a fixed set of
application-defined tools, executes calls locally, returns correlated results,
and reaches the same turn's terminal event. Session provisioning, remote
pairing, durable reconnect, and mutations follow after this read-only loop.

## Non-goals for the first slice

- a finalized universal protocol;
- full MCP feature coverage;
- multiple applications, MCP servers, agents, or concurrent sessions;
- arbitrary device or Android control;
- production multi-tenancy or billing;
- importing normal Codex CLI history;
- replaying every streamed token;
- generic exactly-once side effects.
