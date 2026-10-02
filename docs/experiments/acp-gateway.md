# ACP gateway spike: results

Status: complete, 2026-09-30; mobile follow-up 2026-10-01
([plan](../plan/acp-gateway-mobile-resume.md)). Experimental evidence for the
[spike plan](../plan/acp-gateway-spike.md), not an accepted decision. The
proposed decision is [ADR 0016](../decisions/0016-acp-application-boundary.md).
Code: [`experiments/acp-gateway/`](../../experiments/acp-gateway/).

## Verdict

The hypothesis holds. A browser application can speak ACP over WebSocket to a
Rust Agent Connect gateway and offer its own tools over MCP-over-ACP. The
gateway enforces the grant with generic ACP messages and forwards the session
through the official polyfill to **unmodified** `codex-acp` and
`claude-agent-acp`. Each session can run in its own disposable container.

Both harnesses:

- call application tools under their real names, with real schemas, within one
  turn;
- use their own native tools (web search, shell) alongside the application
  tools;
- resume a session after a browser reload;
- keep a turn running while a phone-like page is frozen and its socket is cut,
  then deliver everything it missed exactly once on reattach
  ([mobile resilience](#mobile-resilience-2026-10-01)).

Real-subscription runs of Codex and Claude Code each completed a reader-style
turn: application tool, native web search, application tool, cited answer.

Nothing in the chain translates to or from Open Responses, and no adapter was
patched.

The central open problem is the **credential boundary**: how a purpose-built,
per-session harness configuration uses the owner's subscription login without
copying it and without exposing it to the harness's own tools.

## Setup (as run on 2026-09-30)

- Host: Linux arm64. Rust 1.98.1. Node 24.20. Docker 29.2.
- ACP Rust SDK: `agent-client-protocol{,-conductor,-polyfill}` 2.2.0 and
  `agent-client-protocol-rmcp` 3.1.1, from crates.io, unpatched.
- Browser SDK: `@agentclientprotocol/sdk` 1.5.1.
- Adapters, unmodified: `@agentclientprotocol/codex-acp` 2.0.1 (Codex CLI
  0.159.2) and `@agentclientprotocol/claude-agent-acp` 0.84.0 (Claude Code
  2.1.284).
- Deterministic inference: `mock-model/server.mjs`, a scripted server that
  speaks the OpenAI Responses and Anthropic Messages streaming formats and logs
  every request. Each harness gets an isolated configuration directory.
- Real inference (phase 7 only): the owner's existing Codex (ChatGPT) and
  Claude logins, used in place on the host.

```text
browser page (TS ACP SDK; serves MCP tools "app" in the page)
  │  ACP over WebSocket, subprotocols acp.v1 + bearer.<token>, exact Origin
  ▼
gateway (Rust): per connection → PolicyProxy ─┬─ host:  McpOverAcpPolyfill → adapter
                                               └─ boxed: docker run -i … session_runner
                                                          [McpOverAcpPolyfill → adapter]
```

## Answers

### Q1: do application tools reach both harnesses in the same turn? Pass.

The mock model calls `read_passage`, then `highlight` with part of the result,
then answers. Both adapters, unmodified, completed call, result and final text
in one turn.

| Harness          | initialize | session ready | tool turn complete |
| ---------------- | ---------- | ------------- | ------------------ |
| codex-acp        | ~0.5 s     | ~0.8 s        | 0.5–1.1 s          |
| claude-agent-acp | ~0.4 s     | ~0.9 s        | ~2.8 s             |

### Q2: what does the model actually see? Real tools, not a dispatcher. Pass.

- **Codex** receives a Responses `namespace` tool named `mcp__app`. It contains
  ordinary function tools `read_passage`, `highlight` and `ask_reader`, next to
  Codex's native `exec_command`, `web_search` and others. Codex normalizes the
  schemas: it drops `$schema`, `title`, `format` and `minimum`.
- **Claude Code** receives `mcp__app__read_passage` and the others with the
  application's schemas verbatim. With the owner's real configuration, Claude
  Code deferred them behind `ToolSearch` and discovered them before calling;
  they were still individually named tools.

### Q3: can the proxy enforce the grant with generic ACP messages only? Pass.

`src/policy.rs` is default-deny in both directions. It matches ACP method names
and the inner method of `mcp/message`, and nothing harness-specific.

| Hostile application behavior                                        | Result on both harnesses                                       |
| ------------------------------------------------------------------- | -------------------------------------------------------------- |
| Advertise `fs` read/write and `terminal`                            | Downstream sees them `false`                                   |
| `session/new` with `cwd: "/"`                                       | Rewritten to the session workspace                             |
| Declare a `stdio` MCP server running a shell command                | Dropped. **Without the proxy, Codex executed it on the host.** |
| Declare an `http` MCP server at the cloud metadata address          | Dropped                                                        |
| `session/set_mode`, `session/set_config_option`, unknown `_` method | `-32601`                                                       |
| List a tool that is not in the consented snapshot                   | Removed from `tools/list`                                      |
| List a consented name with a changed schema                         | Removed from `tools/list`                                      |
| `session/load` of a session this grant did not create               | `Invalid params`                                               |
| Deny-all permission profile                                         | Harness reports the tool calls as refused                      |

### Q4: how long can a call stay open? Up to 300 s by default.

`ask_reader` holds its MCP call open before answering.

| Harness     | 50 s | 70 s | 130 s | 330 s                                         |
| ----------- | ---- | ---- | ----- | --------------------------------------------- |
| Codex       | ok   | ok   | ok    | fails at 300 s                                |
| Claude Code | —    | ok   | ok    | fails at 300 s; ok with the idle limit raised |

- **Codex:** `timed out awaiting tools/call after 300s`, a hard per-call limit.
  `codex-acp` builds each session's MCP configuration from the ACP declaration
  (URL and headers only), so the limit cannot be raised per session today.
- **Claude Code:** `sent no response or progress for 300s`, an idle limit.
  Setting `CLAUDE_CODE_MCP_TOOL_IDLE_TIMEOUT` raises it (a 330 s call then
  completed), and MCP `notifications/progress` resets it. The policy admits
  those notifications from the application.
- **Disconnect:** a pending call dies with the adapter process and is never
  replayed (see Q5).

### Q5: does a real browser connect, survive a reload and resume? Pass, on desktop Chromium.

Correction (2026-10-01): this question covered a deliberate reload in desktop
Chromium at a phone-sized viewport, not mobile lifecycle behavior. In this
design every socket close ended the turn, and in the boxed variant the
conversation too. [Mobile resilience](#mobile-resilience-2026-10-01) closes
that gap.

Covered in Playwright Chromium at phone size (`web/drive.mjs`):

- **Authentication.** The gateway checks the exact `Origin` and a bearer token
  offered as a WebSocket subprotocol, then selects `acp.v1`. A wrong origin
  (403) and a wrong token (401) were both refused before any process started.
- **Tools served by the page.** The TS SDK's generic
  `client().onRequest("mcp/message", …)` is enough to serve MCP from a page.
  The page implements `initialize`, `ping`, `tools/list` and `tools/call` in
  about 40 lines, and `highlight` inserts a real `<mark>`.
- **Tool turn.** Codex took 0.8 s and Claude Code 3.9 s, from connect to
  `end_turn`.
- **Human in the loop.** `ask_reader` waits for a click. A 5 s human answer
  completed on both harnesses.
- **Reload during a pending call.** The chain and adapter process are torn
  down, nothing is replayed, the next turn works, and no process leaks.
- **Resume.** After a reload, `session/load` in a fresh adapter process
  restored the conversation. The next model request contained the earlier
  tool results. This worked on both harnesses.

### Q6: is a container per session practical? Pass.

The gateway's "agent" is simply `docker run -i … session_runner`. Inside the
box, `session_runner` (Rust) owns the polyfill and the adapter, so the
polyfill's loopback MCP bridge never leaves the box. The box has a read-only
root, tmpfs `/work`, home and `/tmp`, runs as a non-root user with all
capabilities dropped, and is capped at 1.5 GiB of memory, 2 CPUs and 512 PIDs.
The harness runs in its full-access mode: the box is the boundary.

| Boxed harness | Ready to prompt | Tool turn done | Memory mid-call |
| ------------- | --------------- | -------------- | --------------- |
| Codex         | 0.6–1.1 s       | 0.8–1.3 s      | ~83 MiB         |
| Claude Code   | 1.3–1.5 s       | 1.8–2.0 s      | ~188 MiB        |

The image is 2.09 GB unpacked. Browser sessions through a boxed gateway pass
the tool and shell scenarios. Native shell commands report `/work`, and every
container is removed when its connection closes.

### Q7: does the network policy hold? Pass, 16 of 16 probes.

Boxes join an internal Docker network with no route out. Their only exit is
`sandbox/egress-proxy.mjs`. It resolves each destination, refuses the request
if any answer is private or reserved, and connects to the exact address it
checked.

| Probe from inside a box                                         | Result   |
| --------------------------------------------------------------- | -------- |
| Public HTTPS through the proxy                                  | 200      |
| Public HTTPS bypassing the proxy                                | no route |
| Mock model on the internal network                              | 200      |
| Metadata, RFC1918, tailnet MagicDNS, the host's tailnet address | 403      |
| Loopback IPv4 and IPv6 through the proxy                        | 403      |
| The host via each Docker bridge gateway, through the proxy      | 403      |
| The host via bridge gateways, direct                            | no route |
| A public name resolving to loopback                             | 403      |

### Q8: what does an application see? Generic progress, no harness knowledge needed.

Application and native tool calls both arrive as `session/update`
`tool_call` and `tool_call_update` items:

- Codex titles app tools `mcp.app.<tool>`, and titles shell calls with the
  command itself. Its hosted search appears as "Web search".
- Claude Code titles app tools `mcp__app__<tool>`, shell as `Terminal`, and
  also shows "Web search" and `ToolSearch`.

Text streams as `agent_message_chunk`. Both harnesses also emit
`usage_update`, `session_info_update` and `available_commands_update`. A reader
UI can render "reading chapter 1 → searching the web → highlighting" from these
items alone.

### Phase 7: real subscriptions, host loop. Pass.

Each harness ran once, on the host, with the owner's login in place and a
clean process environment. The prompt: read chapter 1 with the app tool, do
one web search, highlight the first sentence with the app tool, answer in three
sentences with a source.

| Harness     | Mode                                          | Duration | Sequence observed                                                              |
| ----------- | --------------------------------------------- | -------- | ------------------------------------------------------------------------------ |
| Codex       | `read-only`, gateway profile `app-tools-only` | 25 s     | `read_passage` → native Web search → `highlight` → cited answer                |
| Claude Code | default, gateway profile `app-tools-only`     | 19 s     | `ToolSearch` → `read_passage` → native Web search → `highlight` → cited answer |

Both highlighted exactly "Chapter 1: The validation set is not the test set."
Codex asked the gateway to approve each application tool call, and the proxy
allowed them as application tools. Claude Code asked nothing (finding 10).

## Mobile resilience (2026-10-01)

Mobile browsers freeze background tabs and drop their sockets, networks
change, and resumed sockets can be half-open. ACP v1 leaves this to
implementers: sessions should outlive connections and clients resume with
`session/load`, but messages emitted while disconnected are not redelivered;
stream resumption is deferred to v2. `session/load` during a running turn is
also ill-defined (the v2 prompt-lifecycle RFD asks this question itself).

Prior art used:

- ACP UI's foreground reconnect (`visibilitychange` and `online` triggers,
  `$/ping` heartbeat);
- `@rebornix/stdio-to-ws --persist` (process kept alive, output buffered and
  replayed to a returning client ID);
- the offset-acknowledged log of Socket.IO connection-state recovery and MCP
  `Last-Event-ID`.

### Design

- **Session host.** The gateway now owns each chain in a host that outlives
  its socket. A socket is only an attachment (`src/resume.rs`).
- **Opt-in transport extension.** A client that offers the
  `agent-connect.resume.v1` subprotocol gets enveloped frames. Each ACP
  message carries a per-direction sequence number; each side acknowledges and
  retains what is unacknowledged, resends it after a reattach, and drops
  duplicates by sequence. Plain `acp.v1` clients keep the old behavior. This is
  Agent Connect's own extension below ACP, not an ACP standard.
- **Reattach.** It needs the same grant's bearer token, an allowed `Origin`,
  and the host's random resume token. The newest attachment wins, and the older
  socket is closed with code 4409.
- **Limits.** A detached host keeps running for a grace period (default
  10 minutes) with bounded retained output. Past either limit, it is torn down
  through the existing teardown path (its chain's input ends). A later reattach
  gets code 4404, and the page falls back to ACP v1 `session/load`. The
  interrupted turn is reported as interrupted and is never re-sent.
- **Clean close.** A deliberate close sends `bye` and ends the host at once.
- **Browser.** `web/resumable-stream.js` presents the SDK's stream shape, so
  one ACP connection, and its pending `session/prompt` and tool calls, survives
  socket swaps. It reconnects on close (with backoff while visible), and on
  `visibilitychange`, `pageshow`, `online`, `focus` and Page Lifecycle
  `resume`. On those events it probes an apparently open socket and replaces it
  if no answer arrives within 2.5 s.
- **Discarded tab.** A fresh page has no JSON-RPC state to reattach, so it uses
  `session/load`. The gateway first ends any other live host of the grant that
  holds that session and waits for it to finish, so two adapter processes
  never drive one session.

### Method

Real Chromium at phone size (`web/drive-mobile.mjs`). The page reaches the
gateway through a fault-injecting relay (`web/relay.mjs`) that can reset
connections, refuse new ones, or blackhole open sockets (half-open).

"Going away" means: hide the page, pause its JavaScript with the DevTools
debugger, reset the socket, stay offline for 10–15 s, then resume. A real
frozen tab behaves the same way: events queue and run on resume.
`Page.setWebLifecycleState` "frozen" did not stop timers on a visible headless
page, so it was not used.

Mock scripts stream 30 numbered chunks (`SPIKE-SLOW`) or call `ask_reader`
after 6 s (`SPIKE-LATEASK`), so any gap, duplicate or repeated tool execution
is visible.

### Results

All on both harnesses, through unmodified adapters.

| Question                                                 | Codex | Claude Code | Evidence                                                                                                                                |
| -------------------------------------------------------- | ----- | ----------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| M1 turn survives freeze, cut and 10 s offline            | Pass  | Pass        | Same `session/prompt` resolved; 30 chunks exactly once, in order; 30 frames replayed                                                    |
| M2a tool call pending before the cut                     | Pass  | Pass        | Answered after return; `ask_reader` ran once                                                                                            |
| M2b tool call issued while the page was away             | Pass  | Pass        | Call held in the gateway log, delivered on reattach, answered once                                                                      |
| M2c answer written into a half-open socket               | Pass  | Pass        | Resent after reattach; the gateway dropped the duplicate; the model saw one result                                                      |
| M3 half-open socket during streaming                     | Pass  | Pass        | Foreground probe timed out, socket replaced, exact text                                                                                 |
| M4 grace expiry (5 s)                                    | Pass  | Pass        | Host ended, reattach refused (4404), page recovered with `session/load`, turn reported as interrupted                                   |
| M4 retained output bound (3 KB)                          | Pass  | Pass        | Host ended while detached, same recovery                                                                                                |
| M5 wrong bearer, wrong origin, wrong resume token        | Pass  | Pass        | Refused (401, 403, 4404)                                                                                                                |
| M5 takeover                                              | Pass  | Pass        | New attachment accepted; the first socket closed with 4409                                                                              |
| M6 tab discarded mid-turn, then `session/load`           | Pass  | Pass        | Detached host evicted first, then load and a tool turn                                                                                  |
| M7 boxed: M1, M2a–c                                      | Pass  | Pass        | Container kept alive while detached; none left afterward                                                                                |
| M8 boxed: conversation survives its box (per-grant home) | Pass  | Pass        | Without the volume, load fails (Codex `Internal error`, Claude `Resource not found`); with it, the earlier turn reaches the model again |

Plain `acp.v1` clients still pass the original browser scenarios. No adapter
process or container was left behind, apart from hosts deliberately inside
their grace period.

### Mobile findings

1. **Reattach must happen below ACP.** A v1 `session/load` cannot rejoin a
   running turn, and a lost prompt response is ambiguous. Only a
   transport-level reattach to the live chain keeps an in-flight turn and its
   tool calls.
2. **Acknowledge both directions.** `stdio-to-ws` buffers only agent output,
   without sequence numbers. Frames written into a dying socket are then lost,
   in either direction: M2c is exactly that case.
3. **Bound retention only while detached.** A single `initialize` response was
   about 10 KB, so a small bound applied while attached ended healthy hosts.
   The bound now applies while detached, with an 8× cap while attached.
4. **A deliberate close needs `bye`.** Otherwise every finished page leaves a
   host in its grace period.
5. **Harness tool ceilings still apply while away.** A page tool call held for
   longer than about 300 s times out in the harness (Q4). For phones, long
   human waits should return a receipt immediately rather than hold the call.
6. **Durable homes trade isolation for continuity.** A per-grant home volume
   lets a fresh box load the conversation, but every session of that grant can
   read the others' transcripts, as on the owner's own machine. The workspace
   stays on tmpfs and does not survive.
7. **Not yet seen on a real phone.** All results use desktop Chromium with
   emulated freezing and socket loss. iOS Safari's exact timing (how long
   before sockets drop, whether `pageshow` or `visibilitychange` fires first)
   still needs one manual check.

## Findings

1. **The official polyfill is the missing piece, and it works unmodified.**
   Neither adapter accepts ACP-transport MCP. `McpOverAcpPolyfill::http()`
   bridges it to loopback HTTP and advertises `acp: true` upstream. The July
   Omnigent adapter patch is not needed.
2. **The gateway must choose the harness mode.** In its default `agent` mode,
   `codex-acp` sends MCP tool calls to Codex's model-based guardian review.
   `read-only` and `workspace-write` route approval to the ACP client, and
   `agent-full-access` never asks. The operator chooses the mode, and the proxy
   denies mode changes from the application.
3. **MCP protocol generations collide.** Claude Code's MCP client probes with
   `server/discover` (MCP 2026-07-28). The SDK's `rmcp`-backed server treated
   that as fatal and tore down the whole ACP connection. Answering `-32601`,
   as the policy does, makes Claude fall back to `initialize`. Every
   application-side MCP server must do the same. This is worth reporting to
   the Rust SDK.
4. **Permission prompts cannot identify application tools generically.**
   Codex's MCP prompt has an empty title. The authoritative gate for
   application tools is therefore `tools/list` and `tools/call` against the
   snapshot. The host-only `app-tools-only` profile attributes prompts through
   adapter-specific titles.
5. **Permission prompts do not bound native actions.** Under
   `app-tools-only`, both harnesses still ran a shell command without asking:
   Codex's sandboxed commands, and Claude's commands classified as read-only.
6. **A harness does not confine itself to the session `cwd`.** Codex ran a
   shell command, issued without the optional `workdir`, in its process
   directory rather than the session `cwd`. Only a sandbox boundary confines
   native actions; in a box, that directory is `/work`.
7. **Browser connection failures are opaque.** Browsers hide the HTTP status
   of a failed WebSocket upgrade, and the SDK reports `[object Event]`. A
   production gateway should accept the upgrade and close with an application
   close code and reason.
8. **Harness-specific extensions exist.** Both adapters emit
   `_auth/status_update`, which the proxy drops without consequence.
9. **Tool-call ceilings are about five minutes** (Q4). Human-in-the-loop tools
   should send MCP progress while they wait, or return a receipt and deliver
   the answer as a later prompt.
10. **Using the owner's configuration in place imports their posture.** The
    owner's Claude Code settings select `auto` permission mode, so Claude
    approved application tools and web search itself and never asked the
    gateway. Codex, in the gateway-chosen mode, did ask. A production gateway
    must launch harnesses with a purpose-built configuration whose mode it
    controls, which leads directly to the credential boundary below.

## Open problems for a follow-up

- **Live credential validation.** The [credential plan](../plan/acp-gateway-credentials.md)
  now chooses one dedicated shared home per harness, including credentials and
  transcripts. Its filesystem and command boundaries are implemented; live login,
  concurrent refresh, revocation and personal-login coexistence remain untested.
- **Durable boxed sessions.** The shared home trades transcript and configuration
  isolation across grants for continuity. Workspace storage remains ephemeral.
- **Mobile.**
  - One manual check in iOS Safari.
  - Whether the gateway should keep held tool calls alive past the harness
    ceiling with progress notifications.
  - Proposing message IDs and stream resumption upstream, so the resume
    extension can be retired for ACP v2.
- **SDK ergonomics.** A small MCP-server helper for the browser SDK (tool
  registry, method-not-found for unknown methods, progress while waiting) and
  close-code errors instead of opaque events.
- **Upstream reports.** The `rmcp` pre-initialize failure (finding 3), and a
  way to pass MCP tool timeouts through `codex-acp` session setup.

## Reproduce

See [`experiments/acp-gateway/README.md`](../../experiments/acp-gateway/README.md).

## Product implementation (2026-10-02, unreleased)

Phase 1 moves the gateway, policy and resumable host into the root Cargo
workspace at `crates/gateway`, with binary `agent-connect-gateway`. The spike
retains its fixtures and compatibility entry points. The verification gate
uses pinned real adapters, deterministic inference and Chromium with isolated
temporary homes. Product policy also checks chain session ownership, rejects
concurrent prompts, removes unrecognized authority fields, and journals stable
action IDs before application delivery. Browser authorization failures use
4401/4403 close codes. ADR 0016 remains proposed; the OpenClaw plugin is intact.

Phase 2 adds shared harness homes and the interactive login helper. Tests confirm
private modes, host UID/GID mount behavior and absence of API-key variables in
box arguments, using no provider login. Production host launches are refused;
boxes receive a separate internal network per session, connected only to the
operator-selected egress proxy. Deterministic fixtures can explicitly attach a
mock model. Session capacity, WebSocket frame bounds and graceful shutdown are
also enforced. Live credential/refresh/terms checks remain open.

Phase 3 configures cargo-dist for the three initial targets, without release CI.
Both Linux musl gateway archives and static session runners build locally. The
npm comparison favors per-platform optional packages without runtime downloads;
the wrapper pins both adapters and their native CLIs. Local pack/install smokes
pass. The session OCI archive contains Linux ARM64 and AMD64 images, built without
host binfmt changes. Both installed CLIs start in an isolated, unauthenticated box.
macOS installation remains untested.

The deterministic boxed gate passes eight scenarios per adapter: application
and native tools, session/load, stream reattach, held human input, half-open tool
answers, expired transport recovery and discarded pages. This exposed a Codex
mode mismatch: boxed sessions now default to full access inside the container,
while explicit host fixtures use workspace-write. Proxy reset handling and
reserved-address filtering have regression tests, including mapped IPv6. These
checks spend no subscription allowance and prove no live credential behavior.

Phase 4 adds the unstable typed transport, connectAgent and AcpProvider. The
reader fixture now uses the SDK and AgentSession. Contract tests cover immutable
snapshots, one session/new, one active prompt, stable application actions,
thought/plan/native-tool events, cancellation, typed close failures, listener
cleanup and recovery without prompt replay. Real-adapter browser gates cover
these transport paths with deterministic inference; contract fixtures are not
claimed as provider compatibility evidence.

Expiry while a human handler was held exposed a missing interruption signal.
The provider now aborts cooperative handlers before reporting task_interrupted
and loads the owned session without re-sending the prompt. The pinned ACP SDK
also settles prompt/load responses before asynchronous notification middleware
has drained; the provider waits for that drain before finishing a turn or
leaving replay mode. Authorization failure and attachment takeover never load
a replacement session. Cancellation is checked against chain session ownership.

Phase 5 adds createAcpChatTransport and the typechecked React useChat example.
UI contracts cover last-user-only prompts, regeneration/foreign-chat rejection,
text/reasoning boundaries, plan data, provider-executed native progress, stable
application actions, abort, reconnect and interrupted-turn errors. The real
useChat browser flow passes tools, thoughts, same-session follow-up and Stop on
both adapters. The deterministic model now emits real provider reasoning events;
it does not inject ACP updates. Neither pinned CLI advertises a native plan tool
in the selected fixture configuration. Plan conversion has contract evidence,
not real-harness plan evidence. Existing OpenClaw exports and plugin stay intact.

Local packaging artifacts remain unpublished. Live credentials, Windows/macOS
installation, Safari, grant issuance/consent/revocation and release/ADR approval
remain open. No personal harness home was opened or modified, and no live model
turn or interactive login was run during implementation.

The session image also starts both exact pinned CLIs as an unnamed UID/GID
12345 with no network and temporary homes. Both harness configuration directories
are owned by that identity with mode 0700. This validates the non-node-1000 image
path without logging in or touching a host credential directory.

Final SDK review adds an optional original application result to the existing
provider string interface. ACP keeps image content, structured data and isError;
Responses keeps the same string wire output. Regression tests also verify that
an unread UI stream can be disposed without admitting a prompt and without
retaining its AbortSignal listener.

## Product artifact qualification (2026-10-02)

The ACP candidate is now version 0.1.0-alpha.1 across the SDK, Rust gateway,
npm launcher/platform packages and session-image manifest. SDK tarball checks
verify public ACP imports/types, retained deprecated legacy declarations, no
tests/maps/local-path leaks and browser-safe output. The launcher no longer
duplicates harness packages on the host: the exact adapter/CLI pins live in
its metadata and the matching session image. A fresh npm consumer runs npx help
and version through the packed platform executable.

Operator init validates and copies the snapshot, generates a private random
grant/config, and provides a dedicated shared home. Configuration supports
CLI/environment/file precedence; egress helpers manage only owned containers.
The artifact install guide covers the explicit manual grant handoff, login,
maintenance and accepted credential/transcript/config risks. This does not add
an OAuth portal or accept ADR 0016.

Both Linux cargo-dist archives, the shell installer, local npm publication dry
runs and the multiarch OCI/native session images build without publication.
All workflow files pass actionlint. The protected release workflow is authored,
with ADR/tag/reviewer gates, OIDC npm provenance and immutable image references;
it has not run on GitHub. Ordinary main/PR CI no longer publishes automatically.
macOS is a configured native release target, not locally executed evidence;
Windows is unsupported.

The clean-room gate receives only release tarballs and its deterministic fixture,
not a checkout or SDK build directory. It verifies artifact hashes, installs the
gateway/platform package, builds the standalone reader from the packed SDK's
public ACP subpath, and uses a real boxed Codex adapter. Read/highlight execute
once with visible effects; a held reader question reattaches on the same session
without duplicate model submission; Stop cancels a held tool without a follow-up
model request. Cleanup removes only that run's resources. The test-only trusted
runner has Docker access; the browser and session boxes do not receive its socket.

An initial driver assumption that adapter pins were launcher dependencies was
corrected to the metadata field. The clean-room Docker CLI is pinned to match
the current daemon API rather than using Debian's older client. These are
installation-test corrections, not mock ACP/provider behavior.

The remaining owner gates are live dedicated-login/refresh/revoke checks,
first actual release/account setup and ADR acceptance. No personal harness home,
live login, subscription-backed turn, remote ref, registry publication or npm
deprecation was performed. The previous OpenClaw plugin remains intact.

## Clear-context product review (2026-10-02)

An independent review of `6e9eb0b..775e996`, with selected underlying SDK
paths from `893c1a7..6e9eb0b`, identified three P2 findings:

- The standalone sample exposed no new-connection action after Stop or a
  terminal failure required a fresh AgentSession. It now retains the visible
  transcript and approved in-memory grant while allowing an explicit new
  connection. Earlier messages and tool effects are never replayed.
- A rejected `session/new` promise permanently poisoned later explicit
  provider attempts. Definite RPC rejection now clears that promise; ambiguous
  protocol/transport outcomes do not. Controlled regression tests cover both.
- The documented local acceptance sequence implied macOS support, although
  its container driver needs Linux temporary paths and platform artifacts.
  The guide now scopes that sequence to Linux; native macOS composition stays
  a first-release owner check.

The packed-artifact browser gate now continues after cancellation: it explicitly
connects again, retains the cancelled transcript, sends a new tool turn on a
different harness session and verifies the cancelled question is not replayed.
It uses one page with a one-host limit. Repeated scripted questions also exposed
and corrected a fixture bug: tool results must belong to the latest user turn,
rather than suppressing a new tool call because an earlier turn answered it.
The strengthened clean-room rerun passes, including explicit connection retry
when the single host slot is still closing and no duplicate archived transcript.
This review and its deterministic tests do not establish live authentication,
credential refresh, native macOS installation or gateway-only resource teardown.

## Browser lifecycle and boxed teardown hardening (2026-10-02)

A genuine Chromium back/forward-cache restoration exposed a sample lifecycle
bug: unconditional `pagehide` disposal destroyed the cached chat. The sample
now preserves chat, provider and grant when `event.persisted` is true. The
artifact-only browser gate verifies actual `pageshow.persisted`, the same session
and a usable chat both after a completed tool turn and while a reader question
waits. Model submissions and tool execution counts stay unchanged. A local
negative-control artifact with the preservation guard removed restores from
cache but cannot open the next reader question, confirming the gate catches
this failure. Full reload still requires authorization again.

The browser gate uses full Chromium's new headless mode; Playwright's default
headless shell did not permit this cache transition. Navigation waits for commit,
since cache restoration does not emit a new load event. These are test-driver
corrections, not evidence of mobile Safari behavior. See
[Playwright's browser modes](https://playwright.dev/docs/browsers#chromium-new-headless-mode)
and [the pagehide reference](https://developer.mozilla.org/en-US/docs/Web/API/Window/pagehide_event).
Default clean-room images now use per-run tags and captured immutable IDs to
avoid concurrent test runs swapping the image being executed; the test removes
only its own matching image tag after owned containers stop. An independent
review caught that deletion by shared image ID would fail for identical concurrent
builds; tag cleanup preserves the other run's reference.

Independent real-Docker probes also confirmed a private-network leak after idle
session disposal and during shutdown racing box allocation. Gateway teardown now
owns immutable, labelled resource IDs, retries container/network removal within
a bound, reconciles lost allocation responses, and tracks startup through rollback
before graceful shutdown exits. Shared peers are disconnected, never removed.
A failed cleanup retains its capacity slot for that process and reports owned
resource IDs for operator inspection; it does not admit replacement boxes above
the configured limit. SIGKILL remains outside graceful-cleanup guarantees.

The new `test:integration:acp:teardown` gate covers 12 real boxed cases: idle and
active bye, expiry and SIGTERM; cancel followed by bye; missing peer; rejected
box creation; lost successful box and network create responses; and SIGTERM
while Docker allocation is delayed. It asserts all owned resources are absent
before fallback cleanup and shared peers remain running. All cases pass against
the rebuilt gateway. Controlled Rust tests additionally cover retry races,
immutable-ID replacement safety, client timeouts and capacity retention.

These checks use deterministic inference and isolated temporary homes, with no
live login, personal service changes, subscription allowance or publication.

Final validation rebuilt both Linux release archives, shell installer and npm
artifacts locally. `npm run verify` passes with the strengthened clean-room and
12-case teardown gates; `cargo test --locked --workspace` and Rust formatting
pass. The clean-room installs the newly rebuilt gateway and packed SDK/sample,
with no checkout mounted. Independent final review reports no remaining
confirmed finding. macOS/native release and live credential evidence remain
owner gates, as listed in `docs/plan/current-work.md`.

## Convention-based login (2026-10-02)

The primary command is now `agent-connect login`. It presents the release
image's harness choices, defaults to Codex, labels Claude Code unconfirmed
against Anthropic terms, and supports cancellation before home creation or
Docker invocation. It uses a dedicated per-harness platform state home; new
init and production serve share that default. Existing config homes and explicit
home/image options retain precedence, with a harness/config mismatch rejected.
`agent-connect-gateway` remains a compatibility command in npm and native archives.

Regression coverage exercises the actual CLI in a pseudo-terminal with a fake
Docker executable: default and explicit selections invoke the correct provider
recipe, invalid input reprompts, and cancellation invokes nothing. It also checks
nonterminal rejection, private home modes, default-home agreement across setup
and serve, old relative config homes/images, and explicit overrides. No provider
login, credential files or live turn are involved.

Independent review found and corrected a login/config coupling: login must not
require server-only bearer, origin or egress fields supplied at serve time.
Private-file validation and relative path resolution are shared, while server
validation remains in serve. A metadata-only config regression verifies login
without those fields and prevents forwarding a server-environment bearer.

Both Linux native archives and npm tarballs rebuilt successfully with the primary
CLI and compatibility executable. An isolated installation from local wrapper
and platform tarballs passes `npx @open-agent-connect/gateway --help`; both native
archive command names also pass help checks. Final `npm run verify`,
`cargo test --locked --workspace`, CLI regressions, Rust formatting and packed SDK
smoke all pass. Clean-room acceptance now invokes the installed `agent-connect`
command and checks the default home remains inside its isolated test mount.
No interactive provider login or live model turn was performed.
