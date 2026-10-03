# Plan: mobile-resilient sessions for the ACP gateway

Status: complete (2026-10-01): M1–M8 pass on both harnesses; the iOS Safari
check is not done. Follows the
[ACP gateway spike](acp-gateway-spike.md); results go to
[`docs/experiments/acp-gateway.md`](../../experiments/acp-gateway.md).

## Problem

The spike gateway ties one ACP chain, one adapter process and (when boxed) one
container to one WebSocket. When the socket closes, everything is torn down.
That was tested only for a deliberate reload in desktop Chromium at phone size.

Phones close sockets constantly:

- iOS Safari freezes background tabs within seconds, and the OS or a NAT then
  drops the TCP connection.
- A network change (Wi-Fi to cellular) kills the socket.
- After a long background period, the OS may discard the tab.
- After a resume, a socket can look open while being dead (half-open).

With the spike design, locking the phone during a 20-second turn loses the
turn. In the boxed variant it also loses the conversation, because the box's
tmpfs home goes with it.

## What exists (researched 2026-10-01)

- **ACP v1 remote transport RFD** (active since 2026-07-02): sessions should
  outlive connections, and a client resumes with `session/load`. In-flight
  messages emitted while disconnected are explicitly not redelivered. Message
  IDs, `Last-Event-ID`-style stream resumption and defined reconnection
  semantics are deferred to v2. "Reconnect and retry are up to the
  implementer."
- **ACP TS SDK 1.5.1** `createWebSocketStream` documents the same v1 recipe:
  new socket, `initialize`, `session/load`, no in-flight replay.
- **ACP v2 RFDs (drafts):** `session/resume` with a `replayFrom` cursor replaces
  `session/load`; prompt responses acknowledge insertion rather than turn end,
  and a lost prompt response is an ambiguous outcome that must not be retried
  blindly. The prompt RFD itself asks: "If you call load during a currently
  running session, how do you know that the turn is done?"
- **ACP UI** (formulahendry/acp-ui, MIT): "foreground reconnect". On
  `visibilitychange` (visible) or `online`, debounced, it opens a new socket,
  calls `initialize` and `session/load`, and shows "Reconnecting…". A `$/ping`
  heartbeat every 25 s keeps NAT and proxy mappings alive. Its transport
  deliberately does not auto-reconnect silently. It does not handle in-flight
  turns or client tools.
- **`@rebornix/stdio-to-ws` 0.2.0** (the bridge ACP UI recommends):
  `--persist --grace-period <s>` keeps the agent process alive after the socket
  closes, buffers agent output, and replays the buffer when a client reconnects
  with the `clientId` it was given. Gaps:
  - no sequence numbers or acknowledgements, so frames written into a dying
    socket are lost;
  - client-to-agent frames sent during the gap are lost;
  - the `clientId` is the only reattach credential;
  - the buffer is unbounded;
  - the reattach ID travels as an `X-Client-Id` header, which browsers cannot
    set.
- **General prior art:** Socket.IO connection-state recovery (server keeps
  packets for a bounded disconnection window; the client presents its session
  ID and last offset) and MCP Streamable HTTP resumability (`Last-Event-ID`).
  Both are the same shape: an offset-acknowledged log with a bounded window.

## Approach

Separate the session from the socket, at the transport layer, below ACP.

1. **Session host.** The gateway owns each chain (policy proxy, polyfill,
   adapter or box) in a host object that outlives its WebSocket. A socket is
   only an _attachment_.
2. **Resumable transport, opt-in.** A client that offers the WebSocket
   subprotocol `agent-connect.resume.v1` (with the bearer token) gets
   enveloped frames. A client that offers only `acp.v1` gets today's
   behavior, so standard ACP clients still work. The extension is Agent
   Connect's own and is labeled as such; it anticipates ACP v2 stream
   resumption rather than claiming to implement it.
3. **Envelope.** Every ACP JSON-RPC message carries a per-direction sequence
   number. Each side acknowledges the highest sequence received and keeps
   unacknowledged frames. On reattach, each side resends what the other has not
   acknowledged, and the receiver drops duplicates by sequence. This covers
   both directions and half-open sockets, which `stdio-to-ws` does not.
4. **Reattach credential.** The host issues a random resume token on first
   attach. A reattach must present the same grant's bearer token, an allowed
   `Origin`, and the resume token. A newer attachment takes over and the older
   socket is closed. The token lives in `sessionStorage` (per tab).
5. **Grace window and bounds.** A detached host keeps running for a configured
   grace period (default 10 minutes). The turn continues, and its output is
   retained up to a size bound. When either limit is exceeded, the host is torn
   down through the existing teardown path, and a later reattach is refused
   with a distinct close code. The client then falls back to ACP v1 recovery:
   a new connection and `session/load`.
6. **In-flight application tool calls.** A harness tool call to the page that
   arrives while the page is away is held in the log and delivered on
   reattach. The page's answer is sent with its sequence number. The harness's
   own tool-call ceiling (about 300 s) still applies. Nothing is re-executed: a
   duplicate frame is dropped by sequence, and an expired call is never
   replayed.
7. **Client.** The browser keeps one ACP SDK connection over a resumable stream
   that swaps sockets underneath, so pending JSON-RPC requests (the prompt, a
   tool call) survive. It reconnects on socket close (with backoff while
   visible and online), and on `visibilitychange`, `pageshow`, `online`,
   `focus` and the Page Lifecycle `resume` event. On foreground with an
   apparently open socket, it sends a probe and replaces the socket if no
   answer arrives within about 2.5 s. It acknowledges and heartbeats every few
   seconds.
8. **Discarded tab.** A fresh page has lost its JSON-RPC state, so it cannot
   reattach to the old stream. It uses ACP v1 recovery. If a detached host
   still holds that session, the gateway ends the host before admitting the
   `session/load`, so two adapter processes never drive one session. The
   interrupted turn is reported as interrupted and is not replayed.

## Questions

- **M1.** Does a turn survive the socket being cut while the page is frozen,
  with every update delivered exactly once and the original `session/prompt`
  promise resolving?
- **M2.** Does a page tool call survive in each position: issued before the
  cut, issued while detached, and answered while detached?
- **M3.** Is a half-open socket detected on foreground and replaced?
- **M4.** After grace expiry or buffer overflow, is everything torn down
  without leaks, and does the client fall back to `session/load` cleanly?
- **M5.** Is reattach refused with a wrong grant, origin or resume token, and
  does a takeover close the older socket?
- **M6.** After a tab discard (reload), does `session/load` work while a
  detached host held the session?
- **M7.** Do M1 and M2 hold for boxed sessions?
- **M8.** Optional: with a per-session volume, does a boxed conversation
  survive the end of its box?

## Test method

- **Fault-injecting relay** (`web/relay.mjs`) between Chromium and the
  gateway, with a control endpoint. It can cut every connection with a reset,
  blackhole traffic while keeping sockets open (half-open), and refuse new
  connections for a while.
- **Page freezing** through the Chrome DevTools Protocol
  (`Page.setWebLifecycleState` frozen, then active), which is how Chromium
  models a background tab. Unfreezing fires the Page Lifecycle `resume` event.
- **Slow and late mock scripts:** `SPIKE-SLOW` streams 30 numbered chunks over
  about 9 s, and `SPIKE-LATEASK` waits before calling `ask_reader`. Exact
  expected text reveals any gap or duplicate.
- **Exactly-once checks:** the page counts each tool execution, and the mock
  log shows each tool result once.
- **Both harnesses** for M1 and M2, on the host and boxed variants.
- **Real phone:** one manual Safari check on a real iPhone, if the owner wants
  to expose a test gateway to their phone. This is not done automatically.

## Phases

1. Mock scripts, relay, and the plan's questions recorded (this document).
2. Gateway: session host, envelope transport, attach and takeover, grace,
   bounds, and teardown.
3. Browser resumable stream, lifecycle triggers, and fallback.
4. Scenarios M1–M6 on both harnesses (host variant).
5. Boxed M7, and optionally the per-session volume for M8.
6. Results, an ADR 0016 amendment, and correcting the Q5 claim in the spike
   results.

## Kill criteria

- The ACP SDK connection cannot survive a socket swap without forking the SDK.
- Holding frames breaks an adapter (for example, it times out on its own
  requests while the client is detached, with no recovery).
- The design needs adapter changes.

## Product SDK implementation (2026-10-02, unreleased)

The typed resume transport now lives in `packages/web-sdk`, reached through
`connectAgent`. It owns Page Lifecycle probes, bounded outgoing replay and
listener/timer disposal. The spike page uses this SDK. Session/load recovery
reports interrupted turns, aborts cooperative held application handlers and
never re-sends uncertain prompts/results. Deterministic Chromium scenarios are
part of verification; the manual Safari check remains open.
