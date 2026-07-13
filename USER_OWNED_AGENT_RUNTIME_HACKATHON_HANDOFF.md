# User-Owned Agent Runtime — Hackathon Handoff

**Research snapshot:** 2026-07-13
**Context:** This is a handoff for a new AI session in a new repository. This week is the OpenAI Hackathon, and the user is considering an MVP based on the idea below.

## Read this first

Do not assume the product architecture has already been decided. The original idea is broader than OmniGENT, ACP, MCP, or any one coding agent. Those projects are possible building blocks and prior art.

The core question is:

> Can an arbitrary application use an agent running on the user's own machine as its intelligence provider, while also giving that agent a safe way to call back into and operate the application?

For example, a spreadsheet app could send a task to a remote Codex or Claude Code session. During the task, the agent could invoke spreadsheet-specific operations—read cells, write cells, create formulas, format ranges—and report progress and results. The application supplies its capabilities; the remote agent supplies the intelligence.

The user imagines this as something like an **agent API**, **agentic API**, or **user-owned agent runtime protocol**: applications implement a relatively model-agnostic client, while users connect their own long-running agent environment.

## How the idea developed

The starting observation was that AI vendors tend to offer either:

- model APIs for developers, billed and managed separately; or
- their own applications and coding harnesses, such as ChatGPT, Codex CLI, Claude Code, Gemini, and similar products.

The harnesses are powerful but are not normally presented as a portable intelligence service that arbitrary third-party applications can use. The user wants an application to be able to connect to a user's existing agent environment instead of requiring the application developer to choose, host, and pay for a model API.

A power user might keep a VM or home server running Codex, Claude Code, or another agent. A browser extension, spreadsheet, phone app, or other application could connect to it. The agent could then act through capabilities explicitly exposed by that application.

An ambitious version could include a small Android application exposing carefully permissioned native capabilities. A remotely running agent could then automate selected phone actions through that app. This is conceptually possible, but it is much broader and riskier than the smallest hackathon MVP.

## The two protocol directions

The clean mental model discovered in the discussion is:

```text
application / UI
    |
    | task, prompts, progress, permissions, results
    | ACP-like agent connection
    v
user-owned agent runtime / orchestrator
    |
    | drives one selected downstream harness
    v
Codex / Claude Code / another agent
    |
    | tool calls back toward application capabilities
    | MCP-like tool connection
    v
application tools
```

ACP and MCP solve related but different halves:

- **ACP (Agent Client Protocol)** models communication between a client application and an agent: creating/resuming sessions, sending prompts, receiving streamed updates, requesting permissions, and related lifecycle operations.
- **MCP (Model Context Protocol)** lets an agent or model client discover and invoke tools/resources exposed by a server.

The desired system needs both directions. Sending a task to an agent is insufficient if the agent cannot act on the originating application.

ACP is bidirectional at the message layer. The client starts the agent process in the currently stable local transport, but the agent can send notifications and requests back over the same channel; it does not have to wait for the client to poll every action. Stable ACP is JSON-RPC over a persistent stdio/NDJSON connection. Remote network transports such as Streamable HTTP or WebSocket have been discussed/proposed, but should not be mistaken for the current stable baseline without rechecking the latest ACP specification.

## MCP over ACP

There is an ACP proposal commonly described as **MCP over ACP**. Its purpose is more substantial than a one-off callback such as “spell-check this text.” It defines how an ACP connection can carry robust MCP client/server interactions.

The proposed shape is roughly:

- establish one or more logical MCP connections over the existing ACP channel;
- multiplex MCP messages through ACP methods such as connect/message/disconnect operations;
- preserve MCP request/response/notification semantics;
- allow the application side to expose MCP servers or capabilities to the agent without requiring a separately reachable network endpoint for every client;
- address lifecycle, capability negotiation, multiple servers, failure handling, and cleanup.

At the network level, the important point is that the existing connection is already persistent and bidirectional. MCP-over-ACP is therefore not primarily about inventing a second socket. It is about specifying framing, ownership, routing, lifecycle, error behavior, and interoperability so the nested protocol remains reliable rather than becoming an ad hoc tunnel.

For a hackathon demonstration with one application, one connection, and one agent, a simplified version is entirely plausible. Frontier coding models should have no fundamental difficulty choosing and calling a small, well-described tool surface. The hard parts are lifecycle, permissions, reconnects, duplicate execution, and security—not whether the model can understand `write_cells`.

## What OmniGENT contributes

[OmniGENT](https://github.com/omnigent-ai/omnigent) is an Apache-2.0 open-source meta-harness for running and supervising multiple agent harnesses. It provides a terminal/browser/mobile-accessible UI, session management, policies, sandboxing, and adapters for several coding agents.

It is relevant because it can plausibly serve as the **user-owned orchestration layer** between an application and Codex/Claude Code/etc.

### What was verified

The source was inspected at commit `6e3c77855b08c9b612bf20763fe14f57a7ff9ad4` dated 2026-07-10.

1. **OmniGENT can drive downstream ACP agents.**

   Merged [PR #2152](https://github.com/omnigent-ai/omnigent/pull/2152), titled `feat(acp): generic ACP harness + Omnigent-tool MCP bridge for all ACP harnesses`, added a generic ACP harness. OmniGENT acts as the ACP client and launches an ACP-capable agent command.

2. **It exposes OmniGENT tools to those downstream agents using ordinary MCP.**

   The generic ACP executor supplies `session/new.mcpServers`. A stdio MCP relay exposes OmniGENT's tool dispatch to the downstream ACP agent. This is conventional MCP configured through ACP session creation; it is **not** the proposed MCP-over-ACP transport.

3. **OmniGENT itself is not exposed as a generic upstream ACP agent.**

   External applications currently integrate through OmniGENT's HTTP APIs and SSE streams, not by treating OmniGENT as an ACP server. PR #2152 points ACP in the other direction: OmniGENT is the client of the downstream agent.

4. **OmniGENT has an official Python client SDK.**

   The `omnigent-client` package provides typed HTTP/SSE access to sessions. Its session stream is a live SSE tail.

5. **It supports application/client-executed tools.**

   An agent YAML tool can be declared with `runtime: client` and no server-side callable. The Python SDK accepts local `tool_callables`. When the runtime emits a function call with `status: action_required`, the SDK executes the matching application-side callable and posts a `function_call_output` back to the session.

6. **The pieces appear to compose into the desired callback path.**

   Based on the source, this path should be possible:

   ```text
   app SDK over HTTP/SSE
       -> OmniGENT session
       -> generic ACP adapter
       -> Codex/Claude/etc ACP agent
       -> OmniGENT MCP relay
       -> runtime:client tool becomes action_required
       -> app SDK executes local callable
       -> function_call_output is posted
       -> downstream agent resumes
   ```

   This is a strong source-based inference. A targeted end-to-end test combining all of these exact pieces was not found during the investigation, so the hackathon project should prove this path immediately with a minimal spike.

### The major reliability gap

OmniGENT persists normalized session/conversation state in SQLite or Postgres and can return a session snapshot. Its session SSE endpoint is live-tail only: it does not replay missed history. The documented reconnect pattern is:

1. reconnect to the SSE stream;
2. fetch the current session snapshot;
3. reconcile/deduplicate using stable item IDs.

This is adequate for durable conversation items, but transient token/progress events may be lost.

The particularly important concern for this product is a client-side tool request that arrives while a mobile client disconnects. In the inspected Sessions API path, `action_required` dispatch occurs inline from the live stream. The project should verify whether outstanding client actions are currently recoverable from a session snapshot. Prior source inspection suggested they were not durably rediscoverable in the relevant path. Since this is fast-moving alpha software, verify against the exact commit used rather than treating this sentence as permanent truth.

The robust design is not necessarily a replay log of every token. It can be a durable **pending interaction store**:

```text
pending_action
  id
  session_id
  call_id / idempotency_key
  tool_name
  arguments
  status: pending | claimed | completed | rejected | expired
  created_at / expires_at
  result or error
```

The orchestrator persists the action before notifying the application. A reconnecting application lists outstanding actions, claims one, executes it at most once, and submits an idempotent result. The agent then resumes. This makes reconnect behavior mostly transparent to both the application and the downstream coding agent.

### Session/config isolation

OmniGENT largely keeps its state separate under `~/.omnigent`, so trying it should not heavily pollute or overwrite the user's normal agent configuration.

For Codex specifically:

- authentication may be shared from the normal Codex home;
- configuration may be copied into an OmniGENT-managed Codex home;
- native Codex sessions are kept in an OmniGENT-specific persistent Codex home;
- the direct Codex harness can use a temporary private Codex home;
- existing normal `~/.codex/sessions` are therefore not automatically visible to OmniGENT's resume flow.

This isolation is probably intentional: it avoids conflicts and ambiguous ownership, at the cost of not sharing ordinary Codex CLI session history.

### Adapter portability

OmniGENT has a common executor shape and a plugin/registry concept, so the architecture is modular. However, its native Codex and Claude integrations are not tiny standalone libraries: they depend on OmniGENT session state, server routes, terminal/tmux machinery, private homes, tool bridges, and runner services.

If building a small independent gateway, using existing ACP adapters such as `codex-acp` or `claude-code-acp` is likely easier than extracting OmniGENT's native adapters. If the product can build on OmniGENT, extending its client-tool reliability is likely less work than forking and recreating its orchestration layer.

## What OpenClaw contributes

[OpenClaw](https://docs.openclaw.ai/) is relevant prior art for personal automation:

- a Gateway with a persistent WebSocket protocol;
- the ability to invoke external coding agents through an ACP plugin/path;
- an `attach` workflow that launches Claude Code with a scoped Gateway MCP surface;
- an Android node exposing permission-gated capabilities such as camera, screen, location, notifications/actions, app listing, photos, contacts, calendar, call logs, SMS, motion, canvas, and voice.

This demonstrates that “a user-owned always-on gateway plus an agent plus phone capabilities” is practical.

It does **not** appear to provide the neutral interoperability layer imagined here. Its Gateway protocol is its own application protocol, and its ACP bridge did not, at the time investigated, simply accept arbitrary per-session client `mcpServers`. It is best understood as a strong existing personal automation product and architectural reference, not as confirmation that the general app-to-user-owned-agent standard already exists.

## First-party Codex/mobile background

The discussion began with remote-controlling a Codex CLI session from mobile without relying on the desktop app. No suitable first-party, general-purpose mobile remote-control surface was identified. That motivated looking at OmniGENT's web/mobile UI.

This status is time-sensitive. Before making it a claim in a hackathon submission, recheck current official Codex documentation.

## Suggested OpenAI Hackathon MVP

This section is a recommendation, not part of the original requirement.

The smallest compelling demo is **one app, one remote agent, and a handful of safe app tools**. Do not begin with Android-wide automation or a new universal standard.

### Demo concept: agent-enabled spreadsheet

A browser spreadsheet-like application exposes tools such as:

- `get_selection`
- `read_range`
- `write_range`
- `set_formula`
- `format_range`
- `add_comment`

The user connects the app to an OmniGENT instance running on their VM and selects Codex as the downstream agent. They ask:

> Clean this table, fix inconsistent dates, add formulas for totals, and highlight suspicious rows. Explain each class of change.

The visible demo should show:

1. the application creates or resumes a remote agent session;
2. the task and relevant context are sent;
3. progress streams back to the application;
4. the agent discovers and invokes application-owned tools;
5. consequential writes require explicit permission or are previewed as a diff;
6. the spreadsheet changes live;
7. a deliberate network interruption occurs;
8. the client reconnects, reconciles session state, recovers any pending action, and continues without duplicating a write.

That last step makes the project more than a thin chat integration. It demonstrates the architectural seam needed for real mobile and intermittent clients.

### A pragmatic implementation strategy

1. **Prove the existing OmniGENT path first.** Build a tiny Python SDK client with one `runtime: client` tool and run it through the generic ACP harness to Codex. Confirm the full round trip.
2. **Put a thin gateway/client library in front of it.** Give the app a small, model-agnostic interface for session creation, event consumption, client-tool registration, results, cancellation, and reconnect reconciliation.
3. **Use HTTP/SSE for the MVP.** Do not block on implementing the proposed network ACP or MCP-over-ACP standards. Keep the internal interfaces shaped so those transports could replace the custom edge later.
4. **Add durable pending actions.** If OmniGENT does not already persist and expose them on the chosen API path, implement the smallest correct persistence/claim/result mechanism.
5. **Make security visible.** Tool allowlists, schemas, scoped session tokens, origin/pairing, approval for writes, and an audit trail should be part of the demo rather than a verbal footnote.

### Proposed MVP boundary

In scope:

- one OmniGENT server owned by the user;
- one downstream agent, preferably Codex;
- one web application;
- one active session at a time;
- 4–6 application tools;
- streamed progress;
- permission prompts for mutations;
- reconnect plus snapshot reconciliation;
- idempotent recovery of pending tool calls;
- a clean adapter interface that does not expose OmniGENT-specific details to app code.

Out of scope for the first demo:

- a finalized universal protocol;
- arbitrary MCP server multiplexing;
- many simultaneous applications or agents;
- generalized Android device control;
- importing existing normal Codex CLI session history;
- replay of every token delta;
- production-grade multi-tenant hosting;
- billing or marketplace design.

## Questions the new session should answer first

1. Can the exact OmniGENT version selected run the complete `runtime: client` callback path through the generic ACP adapter and Codex?
2. Does the current session snapshot include unresolved `action_required` function calls, or is a persistence patch needed?
3. Which Codex ACP adapter is reliable enough for the demo, and how does it authenticate using the user's existing subscription/login?
4. What is the narrowest app tool schema that still produces a visually convincing demo?
5. Should the persistence work live as a small upstreamable OmniGENT patch, or in a separate edge gateway for hackathon speed?
6. What exact reconnect/idempotency invariant will be demonstrated and tested?
7. Which claims are safe to make about ACP/MCP interoperability today, versus proposals or future compatibility?

## Product framing options

Possible ways to describe the project without claiming a new standard prematurely:

- **Bring-your-own-agent runtime for applications**
- **A user-owned intelligence backend for apps**
- **A bidirectional bridge between apps and coding agents**
- **An app capability bridge for remote personal agents**
- **A model-agnostic agent connector with client-side tools**

A concise pitch:

> Applications normally bring their own model API. This prototype reverses that relationship: users bring their own running agent. An app can send it a task, stream its work, and temporarily expose safe, typed capabilities that let the agent act back on the app—even across a reconnect.

## Important design principles

- The application decides which capabilities exist; the agent never receives ambient control of the device.
- Tool calls are typed, scoped, auditable, permissionable, and revocable.
- The orchestrator, not Codex or the mobile client, owns durable conversation and pending-interaction state.
- The downstream agent should not need special reconnect logic.
- At-most-once side effects require idempotency; reconnecting and replaying a message is not enough.
- Progress streaming and durable state are different layers. It is acceptable to lose token deltas; it is not acceptable to lose an unresolved mutation request.
- Protocol compatibility claims must distinguish stable ACP/MCP behavior from RFDs and project-specific bridges.
- The client-facing abstraction should be model/harness agnostic even if the hackathon implementation initially supports only Codex.

## Risks and traps

- **Calling a bridge a standard.** A useful MVP can use custom HTTP/SSE while presenting a standard-shaped API. Be precise about what is implemented.
- **Assuming bidirectional transport means durable delivery.** WebSocket/SSE/stdio persistence does not solve disconnect recovery or duplicate side effects.
- **Overbuilding protocol machinery before proving the UX.** First prove one task and one callback tool.
- **Exposing excessively powerful tools.** Prefer semantic operations such as `write_range` over raw shell/device control.
- **Treating coding-agent session files as the system of record.** Let the orchestrator own normalized sessions and pending actions.
- **Forking too much of OmniGENT.** Its native adapters are coupled. Extend or consume the public surfaces first.
- **Building a generic phone agent as the first demo.** It creates major permission, security, UX, and judging complexity.
- **Relying on a live-only tool request.** Explicitly test disconnect before execution, during execution, and after execution but before result acknowledgement.

## Starting references

- [OmniGENT repository](https://github.com/omnigent-ai/omnigent)
- [OmniGENT PR #2152: generic ACP harness and MCP bridge](https://github.com/omnigent-ai/omnigent/pull/2152)
- [Agent Client Protocol](https://agentclientprotocol.com/)
- [ACP protocol repository](https://github.com/agentclientprotocol/agent-client-protocol)
- [Model Context Protocol specification](https://modelcontextprotocol.io/specification/)
- [OpenClaw documentation](https://docs.openclaw.ai/)

The next session should refresh these sources before settling architecture because ACP, OmniGENT, Codex, and their adapters are evolving quickly.

## Original user intent, in their own register

The user is not primarily trying to build another generic agent framework. The idea is that an arbitrary application could implement a common client and let its user plug in their own running Codex, Claude Code, or similar environment as the application's intelligence provider. The application also needs to grant the agent a way back into the app so it can do useful work there. OmniGENT may supply much of the server-side orchestration, but the interesting product seam is the simple, reusable, bidirectional app connection—and making it dependable enough for a phone or other intermittently connected client.
