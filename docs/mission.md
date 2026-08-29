# Mission: application-owned tools for user-owned agents

## Objective

Build a web-first SDK and user-owned gateway that let an arbitrary application
use a long-running agent as its intelligence provider while temporarily
exposing typed, scoped application capabilities back to that agent.

The hackathon implementation uses Codex as the demonstrated downstream agent.
Its provider boundary is compatible with other agent harnesses. Agent Connect
exposes an OAuth-protected Open Responses endpoint (`POST /v1/responses`) and
bundles the harness's response translation with the runtime supervision needed
to deploy it. Omnigent is the first working bundled backend. See
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

Stable call IDs and persistence before publication ensure reliable multi-turn
continuation; applications remain responsible for idempotent operations.

## Current strategy

- Use standard Open Responses semantics (`POST /v1/responses`) as the sole public
  wire. A convenience `streamTask()` coordinates multi-turn response chains
  (`previous_response_id`) without creating a separate public protocol.
- Use Omnigent internally behind the gateway as the first runtime-supervision
  and execution backend; the application does not depend on that choice.
- Supply a fixed tool snapshot on the initial response request. Execute
  `function_call` requests in the application and return correlated outputs
  via response continuation.
- Keep Omnigent wire types behind the gateway while response translation and
  harness supervision remain bundled in the backend; separating them at
  deployment time would create another private protocol.
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
Omnigent/Codex session speaking the bounded Open Responses profile. The enrolled
gateway slice is implemented: the SDK verifies a pinned gateway key before tool
disclosure, the user enrolls a browser device with a generated passphrase only
on the gateway origin, and a top-level gateway page issues a PKCE-protected
revocable grant bound to the exact origin, app id, scopes, and tool snapshot.

Raw Omnigent session identifiers are an internal provider detail. A user starts
the gateway once; normal application use does not require opening Omnigent,
copying a conversation id, or restarting a runner when the application tool
surface changes.

The reference gateway uses Omnigent internally, but applications integrate with
Agent Connect's Open Responses endpoint. Adding another agent harness requires a
bundled harness backend that owns runtime supervision and direct translation to
Open Responses semantics; it does not require reimplementing OAuth, application
grants, response transport, or the recovery core.

The one-shot initializer uses the terminal once to export the gateway's runtime
card and enrollment passphrase, persists only a salted verifier, and thereafter
the terminal is needed only for recovery. Normal serving does not accept the
plaintext passphrase. New apps are approved through the
gateway's Tailscale-hosted OAuth-style page. The private Tailscale Serve flow
has passed from a remote mobile browser; the historically proven isolated
public Funnel profile was removed after the hackathon.
App-instance sender binding, recovery/key rotation, and durable provider mappings
remain outstanding.

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
