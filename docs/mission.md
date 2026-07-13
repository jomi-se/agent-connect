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

- Use ACP for application-to-conductor session lifecycle and events.
- Use the draft MCP-over-ACP shape for one application-provided MCP server.
- Add the smallest durability extension necessary for unresolved application actions; do not duplicate ACP session and prompt methods.
- Evaluate a narrow OmniGENT fork as the conductor. OmniGENT would terminate upstream ACP, map prompts and events to its Sessions API, and drive Codex through its generic ACP harness.
- Keep direct Codex app-server integration as a fallback if the exact OmniGENT client-tool composition spike fails.

## Hackathon acceptance boundary

The target demonstration is a browser spreadsheet application with one active session and a small set of read/write tools. A successful end-to-end slice visibly proves application-defined tool discovery, a Codex-requested mutation, user approval, live application state change, and recovery of a pending mutation request after reconnect.

## Non-goals for the first slice

- a finalized universal protocol;
- full MCP feature coverage;
- multiple applications, MCP servers, agents, or concurrent sessions;
- arbitrary device or Android control;
- production multi-tenancy or billing;
- importing normal Codex CLI history;
- replaying every streamed token;
- generic exactly-once side effects.
