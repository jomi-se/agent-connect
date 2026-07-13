# Hackathon implementation plan

## Guiding demo

A spreadsheet web application connects to the user's runtime, exposes safe range operations, asks Codex to clean and augment a table, previews mutations, survives a deliberate disconnect with one pending write, and completes without applying the demonstrated write twice.

## Milestone 0: repository and web SDK foundation

Deliverables:

- npm-workspaces TypeScript monorepo;
- browser-safe `@agent-connect/web` package;
- ACP WebSocket transport composition point;
- one-server MCP-over-ACP descriptor and handler;
- fixed tool registration and `tools/call` execution;
- unit tests and public example documentation.

Exit criteria:

- clean install, typecheck, tests, build, and formatting checks;
- public imports work from built output;
- unsupported methods and unknown connections/tools fail explicitly.

## Milestone 1: OmniGENT composition spike

Time box: one focused day.

Deliverables:

- exact OmniGENT version and fork baseline pinned;
- maintained `@agentclientprotocol/codex-acp` configured as the downstream agent;
- fake application MCP server with `get_magic_number`;
- one live Codex prompt that must call the tool and repeat its unguessable result;
- captured trace covering session creation, MCP discovery, downstream call, `action_required`, result submission, and completion.

Exit criteria:

- go: the exact path works or needs only a narrow patch with an identified owner;
- no-go: record the failure and switch the conductor implementation without changing the web SDK contract.

## Milestone 2: upstream ACP edge adapter

Deliverables:

- authenticated WebSocket ACP endpoint;
- `initialize`, new/load session, prompt, cancel, update, and permission mappings;
- one MCP-over-ACP connection routed to the browser SDK;
- deterministic cleanup when the connection or turn ends.

Exit criteria:

- browser SDK drives a live Codex session through the conductor;
- text and tool progress arrive on the browser surface;
- one read-only browser tool completes.

## Milestone 3: durable pending actions

Deliverables:

- persisted pending-action record and state transitions;
- stable action ID propagated to the application;
- reconnect/load flow that resurfaces an unresolved call;
- duplicate completion returns the recorded result or a deterministic conflict;
- audit events for requested, approved, completed, rejected, and expired actions.

Exit criteria:

- disconnect before execution recovers the pending action;
- disconnect after execution but before acknowledgement does not produce a second demonstrated spreadsheet write;
- conversation completion resumes after result recovery.

## Milestone 4: spreadsheet demonstration

Initial tools:

- `get_selection`
- `read_range`
- `write_range`
- `set_formula`
- `format_range`
- `add_comment`

Deliverables:

- seeded inconsistent table;
- visible agent progress;
- mutation preview and approval;
- live spreadsheet updates;
- reconnect scenario;
- concise audit trail and final explanation.

Exit criteria:

- fresh browser run proves the full actor workflow;
- console and network inspection show no unexpected errors;
- recorded demo can be reproduced from documented setup.

## Stretch work

- upstream an ACP server surface or pending-action persistence patch to OmniGENT;
- replace the temporary downstream relay with native Codex MCP-over-ACP support;
- add a second ACP agent only after the Codex slice is stable;
- publish the web package after protocol disclaimers and compatibility policy are complete.
