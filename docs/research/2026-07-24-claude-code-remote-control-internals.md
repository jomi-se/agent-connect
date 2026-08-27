# Claude Code Remote Control — internals teardown (for agent-connect comparison)

> 🎮 AI-authored (Claude Fable 5, 2026-07-24). Compiled from the official docs
> (code.claude.com/docs/en/remote-control) plus `strings`-level inspection of the
> shipped Claude Code binary (v2.1.218, bun-compiled, ~258MB). Items marked
> **[binary]** are reverse-engineered observations, not documented behavior — treat
> them as accurate-as-of-today, not contractual.

## What it is

Remote Control (research preview) bridges a **local** Claude Code session to
claude.ai/code and the Claude mobile apps. The phone/browser becomes a remote
steering wheel; execution, filesystem, and local MCP servers never leave the
machine. Anthropic's cloud is a relay + transcript store, nothing more.

Internally the feature is codenamed **CCR** **[binary]** (log lines like
`[bridge:session] CCR v2: registered worker sessionId=... epoch=...`), managed by a
`RemoteSessionManager` class.

## Transport

- **Outbound-only** from the CLI — no listening ports on the user's machine.
- Primary channel: persistent bidirectional WebSocket at
  `wss://api.anthropic.com/v1/session_ingress/ws/{session_id}`.
- **HTTP polling fallback** if the socket drops (interval/backoff undocumented).
- The `session_ingress` API family **[binary]** also includes:
  - `session_ingress/session/` — fetch session logs/transcript;
  - `session_ingress/mcp/ws/` and `session_ingress/shttp/mcp/` — **MCP tunneled
    over the ingress** (WebSocket and streamable-HTTP variants). Remote clients can
    apparently reach the local session's MCP surface, not just chat frames. This is
    the closest thing to agent-connect's "third-party surface talks to your local
    agent" idea inside RC.
- WebSocket envelope/message schema exists but is undocumented.
- Unrelated but easy to confuse: `wss://bridge.claudeusercontent.com` in the same
  binary is the claude-in-chrome extension bridge, a separate channel.

## Auth & access control

- Requires full **claude.ai OAuth** (`/login`). API keys rejected; long-lived
  `claude setup-token` tokens rejected. Pro/Max/Team/Enterprise only.
- Hard-disabled when `ANTHROPIC_BASE_URL` points anywhere but `api.anthropic.com`
  — no Bedrock, Vertex/GCP Agent Platform, or Microsoft Foundry. (i.e. the feature
  is deliberately welded to Anthropic's own relay.)
- Connection uses **multiple short-lived single-purpose credentials** that expire
  independently. **[binary]**: a rotating `session_ingress_token`, hot-swapped on
  refresh (`updateAccessToken(ke.session_ingress_token)`).
- Enterprise controls: org-level admin toggle (Team/Enterprise, owner-enabled),
  `disableRemoteControl` managed setting for IT, grayed out entirely for
  Zero-Data-Retention orgs.
- **Trusted Devices (beta, Team/Enterprise)**: per-device short-lived credential
  enrolled at full sign-in + recent sign-in (≤18h) required; biometric step-up
  (FaceID/WindowsHello/passkey) refreshes the session; only device public key +
  metadata stored server-side; devices revocable from claude.ai account settings.
- Workspace trust dialog must have been accepted locally at least once (home dir
  trust is never saved).

## Session model **[binary]**

- Worker-registration model: sessions register with the ingress with a
  `sessionId` + `epoch`.
- Four spawn modes as string constants: `remote-control-repl`,
  `remote-control-cli`, `remote-control-sdk`, `remote-control-auto`. The `-sdk`
  mode strongly suggests remote sessions can be backed by the Agent SDK headlessly
  rather than a full terminal REPL.
- `ccr-mirror` mode = mirroring an existing interactive session (what typing
  `/remote-control` in a REPL does), vs. the standalone `claude remote-control`
  server mode which keeps a pool and spawns fresh sessions on demand (this is how
  they get multiple concurrent remote sessions; interactive mode allows only one).
- Failure state `bridge-failed`: "disabled after repeated failures — restart to
  retry."

## State & sync

- While connected, the **transcript is mirrored to and stored on Anthropic's
  servers** — that's what enables reconnect-with-history and cross-device sync.
  Retention follows their data-usage policy.
- **Permission approvals sync across all connected devices in real time** — a tool
  call can be approved from terminal, phone, or browser interchangeably. Session
  reminders surface the remote URL when approval would help most (long turns,
  repeated prompts).
- Local process must stay alive; terminal closes ⇒ session ends. Network outage
  beyond ~10 min ⇒ timeout and process exit.
- Some slash commands don't work remotely (`/plugin`, `/resume`); text-output ones
  mostly do (`/model`, `/effort`, `/config`, `/mcp`).

## Comparison with agent-connect

Topologically it is the same drawing: **client ↔ relay ↔ locally-running agent**,
outbound-only from the agent host, short-lived scoped credentials (rotating
ingress token ≈ runtime card + enrollment passphrase), approval flow at the
boundary. Independent convergence on the same architecture.

Every difference is about who owns each vertex:

|                     | Remote Control                                                   | agent-connect                                     |
| ------------------- | ---------------------------------------------------------------- | ------------------------------------------------- |
| Relay               | Anthropic's cloud (`api.anthropic.com`); transcript stored there | User-owned gateway (e.g. over the user's tailnet) |
| Client              | Only Anthropic's apps (claude.ai/code, mobile)                   | Any third-party web app via the browser SDK       |
| Agent               | Only Claude Code                                                 | Anything speaking ACP (currently Codex)           |
| Direction of intent | Anthropic's app drives _your agent_                              | Arbitrary apps get to _use_ your agent            |
| Lock-in mechanism   | OAuth-only auth + relay welded to `api.anthropic.com`            | None by design; gateway is self-hosted            |

Ideas worth stealing / watching:

1. **MCP-over-ingress** (`session_ingress/shttp/mcp/`) is the convergence risk:
   if Anthropic opens the local session's MCP surface to arbitrary remote clients,
   the gap to agent-connect's use case narrows a lot. Conversely, it validates
   exposing the agent as a _tool endpoint_, not just a chat stream.
2. **Transcript mirrored server-side** is what makes their reconnect/multi-device
   UX seamless. agent-connect's equivalent question: where does session history
   live when the browser tab dies? A user-owned store at the gateway would match
   the ownership story.
3. **Approval sync as a first-class cross-device primitive** (approve from any
   connected surface, reminders when approvals are blocking) is a genuinely good
   UX detail worth replicating.
4. **Multiple independently-expiring single-purpose credentials** rather than one
   session token — narrower blast radius per credential.
5. **WebSocket + HTTP-polling fallback** as the transport pair; also their
   spawn-mode split (mirror an interactive session vs. pool of headless
   SDK-backed workers) maps nicely onto agent-connect's Omnigent orchestration.

Sources: official docs at `code.claude.com/docs/en/remote-control.md`; binary
strings from `~/.local/share/claude/versions/2.1.218`; a third-party teardown at
frr.dev corroborates the WebSocket details.
