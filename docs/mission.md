# Mission: application-owned tools for user-owned agents

## Objective

Build a web-first SDK and user-owned gateway that let an arbitrary application
use a long-running agent as its intelligence provider while temporarily
exposing typed, scoped application capabilities back to that agent.

The hackathon implementation uses Codex as the demonstrated downstream agent.
Its provider boundary should remain compatible with other agent harnesses. The
leading proposed simplification is to expose an OAuth-protected Open Responses
endpoint and bundle each harness's response translation with the runtime
supervision needed to deploy it. The proven Omnigent path remains the baseline
until that proposal passes its compatibility and authorization gates. See
[ADR 0010](decisions/0010-open-responses-gateway-pivot.md).

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

- Replace the custom web task/event wire with standard Open Responses semantics
  if the compatibility slice passes. A convenience `run()` may coordinate a
  chain of Responses, but must not become another public protocol.
- Use Omnigent's existing HTTP/SSE Sessions API as the first transport and
  runtime-supervision implementation. Omnigent selects and launches the user's underlying
  agent harness; the application does not depend on that choice.
- Supply a fixed tool snapshot on each task's first session message. Execute
  `action_required` calls in the application and return correlated results.
- Keep Omnigent wire types behind the gateway while evaluating a Codex backend
  that consumes and emits Open Responses types directly. Keep response
  translation and harness supervision bundled; separating them at deployment
  time would create another private protocol.
- Treat AG-UI as an optional future edge integration rather than the leading
  core protocol unless a concrete UI requirement is found that Open Responses
  cannot satisfy. Keep ACP and dynamic MCP as backend techniques, not mandatory
  application dependencies.
- Audit the existing gateway authorization mechanism against OAuth PKCE,
  protected-resource and authorization-server metadata, resource indicators,
  Client ID Metadata Documents, and Rich Authorization Requests. Preserve
  Agent Connect-specific consent policy only where standards do not replace it.
- Model remote connectivity as named transport trust profiles. Implement
  Tailscale Serve first, bind its selected endpoint to an enrolled gateway
  key, and keep hostname recognition out of the trust decision.
- Keep transport ingress, gateway-owner authentication, application
  authorization, and session authorization as separate mechanisms. Use one
  transport-independent grant/session core with interchangeable owner
  authenticators; profile-specific shortcuts must validate their prerequisites
  and state their local-process trust assumptions.
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
Omnigent/Codex session. The enrolled gateway slice is now implemented: the
SDK verifies a pinned gateway key before tool disclosure, the user enrolls a
browser device with a generated passphrase only on the gateway origin, and a
top-level gateway page issues a PKCE-protected revocable grant bound to the
exact origin, app id, scopes, and tool snapshot.

Raw Omnigent session identifiers are an internal provider detail. A user starts
the gateway once; normal application use must not require opening Omnigent,
copying a conversation id, or restarting a runner when the application tool
surface changes.

The reference gateway uses Omnigent, but applications integrate with Agent
Connect rather than Omnigent. Adding another agent harness should normally
require a bundled harness backend that owns both runtime supervision and direct
translation to Open Responses semantics; it must not require reimplementing
the shared OAuth, application grants, response transport, or recovery core.

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
