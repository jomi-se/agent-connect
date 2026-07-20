# Mission: application-owned tools for user-owned agents

## Objective

Build a web-first SDK and user-owned conductor that let an arbitrary application use a long-running agent as its intelligence provider while temporarily exposing typed, scoped application capabilities back to that agent.

The hackathon implementation uses Codex as the demonstrated downstream agent.
Its provider boundary should remain compatible with other agent harnesses. ACP
is the current preferred downstream harness interface; AG-UI is now the leading
pending candidate for the application-facing standard.

## Product promise

An application can:

1. connect to a runtime owned by its user;
2. create or resume an agent session;
3. supply a task and a fixed set of application-owned tools;
4. receive streamed progress, lifecycle events, and application-tool requests;
5. execute requested application operations locally;
6. return tool results without installing an MCP server into Codex;
7. revoke the application's gateway grant without knowing provider session
   identifiers.

The target reliability layer will also recover an unresolved application
action after a network interruption without blindly duplicating a mutation.
That behavior is not part of the current MVP.

## Current strategy

- Give web applications a harness-neutral tool and task API.
- Use OmniGENT's existing HTTP/SSE Sessions API as the first transport and
  conductor implementation. OmniGENT selects and launches the user's underlying
  agent harness; the application does not depend on that choice.
- Supply a fixed tool snapshot on each task's first session message. Execute
  `action_required` calls in the application and return correlated results.
- Keep OmniGENT wire types behind a browser-safe adapter so ACP-over-WebSocket,
  MCP-over-ACP, or another conductor can implement the same public API later.
- Evaluate AG-UI as the standardized browser/gateway run and frontend-tool wire.
  Keep the passing OmniGENT path until an official AG-UI client completes the
  same live Codex tool round trip without weakening security or recovery.
- Model remote connectivity as named transport trust profiles. Implement
  Tailscale Serve first, bind its selected endpoint to an enrolled gateway
  key, and keep hostname recognition out of the trust decision.
- Bootstrap that gateway identity once with a runtime card exported through
  the trusted operator channel. Authorize later web apps through a
  gateway-hosted OAuth/PKCE page; routine use must not require SSH, terminal
  access, or gateway restart.
- Add the smallest durability extension necessary for unresolved application
  actions after the browser loop works; do not claim generic exactly-once
  execution.
- Treat an authenticated application as an adversarial principal. Require the
  selected runtime to enforce an application-tools-only profile by default,
  while Agent Connect prevents policy expansion and separates approvals. Add
  gateway-level ceilings and posture reporting before claiming resistance to
  subscription abuse or verified confinement; report the configured evidence
  source, and relevant observations without claiming independent verification.
  Keep the filesystem, network, persistence, and sandbox mechanism inside the
  runtime adapter.

## Current acceptance boundary

The browser tool loop has passed against an automatically provisioned
OmniGENT/Codex session. The enrolled gateway slice is now implemented: the
SDK verifies a pinned gateway key before tool disclosure, the user enrolls a
browser device with a generated passphrase only on the gateway origin, and a
top-level gateway page issues a PKCE-protected revocable grant bound to the
exact origin, app id, scopes, and tool snapshot.

Raw OmniGENT session identifiers are an internal provider detail. A user starts
the gateway once; normal application use must not require opening OmniGENT,
copying a conversation id, or restarting a runner when the application tool
surface changes.

The reference gateway uses OmniGENT, but applications integrate with Agent
Connect rather than OmniGENT. Adding another agent harness should normally
require only a narrow runtime adapter; it must not require reimplementing
enrollment, OAuth, application grants, or recovery.

The terminal is used once to export the gateway's runtime card and enrollment
passphrase and thereafter only for recovery. New apps are approved through the
gateway's Tailscale-hosted OAuth-style page. The private Tailscale Serve flow
and isolated public Funnel flow have both passed from remote mobile browsers.
App-instance sender binding, recovery/key rotation, durable provider mappings,
and durable unresolved-tool delivery remain outstanding.

## Non-goals for the first slice

- a finalized universal protocol;
- full MCP feature coverage;
- multiple users, hosts, agents, or concurrent tasks;
- arbitrary device or Android control;
- production multi-tenancy or billing;
- importing normal Codex CLI history;
- replaying every streamed token;
- generic exactly-once side effects;
- production identity federation, account recovery, or a public relay;
- arbitrary custom URLs treated as verified user-owned runtimes.
