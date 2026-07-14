# Hackathon implementation plan

Submission positioning, Build Week rules, primary Codex session evidence, demo
storyboard, and the final checklist live in the
[OpenAI Build Week submission guide](openai-build-week-submission.md).

## Guiding demo

A spreadsheet web application connects to the user's runtime, exposes safe range operations, asks Codex to clean and augment a table, previews mutations, survives a deliberate disconnect with one pending write, and completes without applying the demonstrated write twice.

## Milestone 0: conductor composition proof — complete

Deliverables:

- OmniGENT 0.5.1 and published Codex ACP 1.1.2 pinned;
- one fresh nonce supplied as a request-scoped client tool;
- live local Codex turn through OmniGENT's generic ACP harness;
- captured exact-once callback and same-turn completion.

Exit criteria:

- **passed 2026-07-13** without an OmniGENT or Codex ACP fork;
- compatibility code is limited to session-message schema injection;
- OmniGENT selected as the first internal provider.

## Milestone 1: harness-neutral web SDK and provider contract

The existing `@agent-connect/web` ACP/MCP prototype remains useful protocol
research, but the stable public API must not require that draft wire.

Deliverables:

- browser-safe `defineTools`, `connect`, `runTask`, event, approval, and close API;
- fixed tool snapshot per application session;
- internal gateway/provider contract derived from the passing trace;
- OmniGENT provider adapter for create session, prompt/events, tool result, cancel,
  and close;
- explicit separation between browser package and Node gateway code.

Exit criteria:

- clean install, typecheck, unit tests, build, and formatting checks;
- public imports work from built output;
- provider types do not leak into the browser package.

## Milestone 2: loopback browser-to-Codex slice — complete

Deliverables:

- loopback gateway transport;
- one browser session that lends a read-only nonce tool;
- normalized text, status, and tool-call events;
- deterministic cancellation and cleanup;
- real-browser smoke test and sanitized end-to-end trace.

Exit criteria:

- **passed 2026-07-13** in a real Chromium run;
- browser SDK drove a live Codex session through OmniGENT;
- the request-scoped browser tool executed once;
- the same Codex turn included its unpredictable result;
- console and asserted network flow were clean.

## Milestone 3: tailnet HTTPS application slice — complete

Deliverables:

- loopback-only Agent Connect gateway;
- Tailscale Serve HTTPS endpoint without disturbing existing Serve routes;
- exact Firebase preview Origin and Tailscale login allowlists;
- one-time pairing and tool-scoped expiring capability;
- gateway-owned OmniGENT conversation and runner provisioning;
- dedicated Firebase Canvas demo deployed without VM-held credentials;
- remote page-write proof from the Firebase Hosting URL.

Exit criteria:

- allowlisted remote browser completes the same nonce flow over HTTPS;
- mixed-content, CORS preflight, SSE, and event POST checks pass;
- unlisted Origin and Tailscale identity probes are rejected;
- raw OmniGENT and Codex endpoints remain unexposed.

Observed result: the Firebase Canvas completed the remote tool loop on
2026-07-13. The session broker and pairing follow-up then provisioned a fresh
live `codex-acp` runner and completed `set_page_message` using only an opaque
Agent Connect id. Independent mobile network capture remains useful evidence,
but raw provider session configuration is no longer part of the demo UX.

## Milestone 3.5: Tailscale transport identity

Turn the working tailnet deployment into an explicit trust profile. Tailscale
authenticates node transport and the requesting user, while Agent Connect binds
the selected endpoint to a connector key and separately approves the app.

Deliverables and adversarial cases are defined in the
[Tailscale transport identity plan](tailscale-transport-identity.md).

Exit criteria:

- the browser verifies connector-key continuity before prompt ingress;
- the gateway verifies private Serve posture, loopback isolation, allowed
  Tailscale requester, exact Origin, and scoped application grant;
- `.ts.net` suffix recognition, Funnel, a substituted connector, wrong user,
  wrong Origin, changed tools, and replayed enrollment cannot pass as trusted;
- the successful profile still completes the live OmniGENT/Codex tool loop.

## Milestone 4: durable pending actions

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

## Milestone 5: spreadsheet demonstration

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

- implement a named experimental ACP-over-WebSocket/MCP-over-ACP adapter;
- upstream the SessionsChat request-scoped-tools API gap;
- upstream pending-action persistence improvements to OmniGENT;
- replace the temporary downstream relay with native Codex MCP-over-ACP support;
- add a second ACP agent only after the Codex slice is stable;
- publish the web package after protocol disclaimers and compatibility policy are complete.
