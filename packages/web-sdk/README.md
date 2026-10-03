# `@open-agent-connect/web`

Browser SDK for lending a fixed set of application tools to a user-owned agent.
Version `0.1.0-alpha.1` prepares an **experimental ACP release**. ACP,
MCP-over-ACP and Agent Connect's `agent-connect.resume.v1` transport are unstable;
the resume protocol is a custom gateway extension, not an ACP standard.
This candidate does not accept proposed ADR 0016 or retire the previous published OpenClaw
plugin installation target. Publication is a separate release action.

After this prerelease is published, install it with an explicit version:

```sh
npm install @open-agent-connect/web@0.1.0-alpha.1
```

Use `@open-agent-connect/web/acp` for ACP integrations. The root entry point
continues to export every OpenClaw, Responses and Open Responses AI SDK helper;
those helpers are deprecated for new integrations and retained for compatibility.
No existing import needs to change in this alpha.

## ACP quickstart (experimental)

Connect from a user gesture to open the gateway owner's login and consent page.
The owner approves this application origin and its exact tool snapshot. The SDK
uses PKCE and stores the application grant in session-scoped browser storage.
Use HTTPS for the gateway and application; HTTP loopback is supported locally.

```ts
import {
  connectAgent,
  defineTool,
  AgentSession,
  captureAcpPairingCallback,
} from "@open-agent-connect/web/acp";

const tools = [
  defineTool({
    name: "read_selection",
    description: "Read the user's currently selected text",
    inputSchema: { type: "object", additionalProperties: false },
    execute: (_arguments, { signal }) => {
      signal?.throwIfAborted();
      return window.getSelection()?.toString() ?? "";
    },
  }),
];

// Run at page startup before loading other app assets. A popup callback reports
// to its opener, then closes; it must not exchange the same code itself.
const callbackUrl = captureAcpPairingCallback();
if (callbackUrl && window.opener) window.close();

// Call directly from a click handler, before awaiting any other work.
async function readWithAgent() {
  const provider = await connectAgent({
    gatewayUrl: "https://gateway.example",
    tools,
    pairing: {
      mode: "popup",
      redirectUri: `${location.origin}${location.pathname}`,
    },
  });
  const session = new AgentSession({ provider, tools });
  try {
    for await (const event of session.streamTask("Explain the selected text")) {
      if (event.type === "text.delta") console.log(event.delta);
      if (event.type === "task.failed") console.error(event.error);
    }
    // A deliberate follow-up on a completed turn:
    if (session.canContinueTask) {
      await session.continueTask("Give me a shorter explanation");
    }
  } finally {
    provider.close();
  }
}
```

For mobile browsers, use explicit `pairing: { mode: "redirect", redirectUri }`.
The SDK saves a finite-lived PKCE transaction before navigating to the gateway.
After the callback reload, capture and remove OAuth values immediately, then use
`pairing: { redirectUri, callbackUrl }` to complete pairing. Keep the captured
callback in memory and consume it once. A resumed page with no callback can call
`connectAgent({ gatewayUrl, tools, pairing: { redirectUri } })` to reuse its grant.
The default mode never opens consent; it throws `AcpPairingError` with code
`pairing_required` when the application needs an explicit Connect action.
Redirect navigation reports `pairing_redirected`; popup failures report
`popup_blocked`, `cancelled` or `timeout`.

Managed grants rotate automatically before access expiry. The resumable transport
detaches before rotation and reattaches the same session; it never resends an
acknowledged prompt or tool result. Revocation and absolute grant expiry clear
stored credentials and require explicit pairing again. A fresh provider starts
an independent conversation unless you supply its previously saved `sessionId`;
grants and conversation resumption are separate.

`createAcpPairing({ gatewayUrl, tools, redirectUri })` exposes `getGrant()`,
explicit `pair("popup" | "redirect")`, `clear()`, `revoke()` and `dispose()` for
applications that own a connection UI. `clear()` removes local credentials;
`revoke()` also calls the gateway's app-grant revocation endpoint. Disposal stops
owned requests and popup observers but leaves a stored grant available for reuse.
Storage is scoped to the exact gateway origin, application origin and approved
tool snapshot. The default `sessionStorage` avoids sharing rotated refresh
credentials between tabs. An injected storage adapter must preserve those
session boundaries. Browser credentials remain accessible to application
JavaScript: protect against XSS and do not log, publish, or place them in URLs.

Headless compatibility remains available as
`connectAgent({ grant: { gatewayUrl: "wss://gateway.example/acp", token }, tools })`.
The operator owns cwd, model, mode and the restricted agent profile; these are not
browser options. One provider owns one ACP session and allows one active prompt.
`AgentSession` validates arguments against CSP-safe JSON Schema before executing
an approved handler. Its tool definitions must match the provider's fixed snapshot.

Handlers may return text, no value, or `{ content, structuredContent?, isError? }`.
The context provides `actionId`, `toolName`, `connectionId`, `meta` and a cooperative
`AbortSignal`. For effects, use the stable action ID for application-owned
deduplication or make the operation idempotent. There is no generic exactly-once
execution guarantee. A handler remains responsible for its effects after cancel.
Native harness tools, thoughts, plans and progress are presentation events; only
approved application tools run in the page. Held MCP calls send progress when the
peer supplies a progress token, without promising to defeat every harness timeout.

`createAgentChat({ session })` provides in-memory messages, subscription, send,
stop and Markdown export for headless UIs. Execution history and Markdown export
are not resumable human-chat transcripts. Native WebMCP snapshots remain
experimental and require a browser that exposes that API.

## AI SDK `useChat` (experimental)

ACP uses the harness's tool loop. Use a `ChatTransport`, rather than an AI SDK
LanguageModel or another application `execute`/`onToolCall` loop. The transport
supports AI SDK 7; the typechecked [React example](examples/acp-use-chat.tsx) uses
`ai@7.0.93` and `@ai-sdk/react@4.0.96`.

```tsx
import { useMemo } from "react";
import { useChat } from "@ai-sdk/react";
import {
  createAcpChatTransport,
  type AcpProvider,
  type ApplicationTool,
} from "@open-agent-connect/web/acp";

function AgentChat({
  provider,
  tools,
}: {
  provider: AcpProvider;
  tools: readonly ApplicationTool[];
}) {
  const transport = useMemo(
    () => createAcpChatTransport({ provider, tools }),
    [provider, tools],
  );
  const { messages, sendMessage, stop, error } = useChat({
    id: "application-chat",
    transport,
  });
  return (
    <section>
      {messages.map((message) => (
        <p key={message.id}>
          {message.parts
            .map((part) => (part.type === "text" ? part.text : ""))
            .join("")}
        </p>
      ))}
      <button
        onClick={() => void sendMessage({ text: "Explain my selection" })}
      >
        Ask
      </button>
      <button onClick={() => void stop()}>Stop</button>
      {error && <p role="alert">{error.message}</p>}
    </section>
  );
}
```

One transport binds one chat ID to one provider-owned session. Only the last
explicit user's text is sent; prior UI messages, system prompts, model settings
and HTTP options are not forwarded. Files and regeneration are rejected.
Thoughts become reasoning parts, plans become `data-acp-plan`, and native tool
progress becomes dynamic tool parts with `providerExecuted: true`. Application
handlers execute through `AgentSession`; adding an AI SDK handler for the same
operation would duplicate effects. At least one application tool is required.

Stop or AbortSignal sends `session/cancel`. The mounting application owns cleanup:
call `await transport.close()` and `provider.close()` when relinquishing them.
Preserve provider, tools and transport identity across renders.

## Reconnect and recovery (experimental)

Page Lifecycle listeners probe or reattach the same sequence-acknowledged
transport. Grants and opaque reattach tokens stay in memory. Reattach within the
retention window can continue an active stream without issuing another prompt.
If retention expires or output overflows, the provider opens a new transport and
uses `session/load`; gateway restart recovery is not promised.

When a page enters the browser back/forward cache, keep the provider, transport
and chat state alive: do not dispose them on `pagehide` when `event.persisted`
is true. The transport's lifecycle listeners handle socket suspension and
reattachment. Dispose only on an ordinary departure or an explicit close.
A full reload creates a new page and requires authorization again. See the
[pagehide lifecycle reference](https://developer.mozilla.org/en-US/docs/Web/API/Window/pagehide_event)
and the sample's cleanup handler.

```ts
const provider = await connectAgent({
  grant,
  tools,
  // Optional saved opaque session ID from the same grant's ownership:
  sessionId: savedSessionId,
  onSession: (id) => saveSessionId(id),
  onUpdate: (notification, replay) => renderUpdate(notification, { replay }),
  onRecovery: (recovery) => showRecoveredSession(recovery.sessionId),
});
// For an idle known session, explicitly load history on a new transport:
const recovery = await provider.recover(); // AcpRecovery
```

Replayed history reaches `onUpdate(notification, true)`, not new task deltas.
Recovery reports `task_interrupted`, discards held result resolvers, and never
resends an uncertain prompt or application result. Observe the handler's signal.
After an interrupted `AgentSession`, construct a new session over the recovered
provider before a deliberate follow-up. A saved session ID only helps while the
gateway recognizes ownership under the same grant.

AI SDK active-stream reconnect probes the same resumable connection. A locked UI
stream cannot acquire a second reader. Idle reconnect preserves a healthy live
host and returns `null`; an ended recoverable transport loads history. It cannot
safely reconstruct an interrupted UI stream. Let the user send
a new message deliberately. Do not automatically resend, regenerate or retry
uncertain application effects.

## Error codes and alpha risks

`AgentConnectError.code` is the public failure category.
`AcpTransportError` additionally exposes `closeCode` and `reason`:

| WebSocket close  | Error code               | Meaning / response                                                                  |
| ---------------- | ------------------------ | ----------------------------------------------------------------------------------- |
| 4400             | `protocol_error`         | Invalid frame; inspect client/gateway compatibility.                                |
| 4401             | `invalid_app_grant`      | Explicitly reconnect to approve a new grant.                                        |
| 4403             | `authorization_denied`   | Origin denied; authorization must be resolved.                                      |
| 4404, 4410, 4413 | `session_expired`        | Expired, ended or overflowed transport; history load may recover the known session. |
| 4409             | `session_superseded`     | Another attachment took over; do not take it back automatically.                    |
| 1009             | `frame_too_large`        | Reduce the message or tool result; the frame was not queued or resent.              |
| 4415             | `session_superseded`     | Host was evicted; start a new conversation explicitly.                              |
| 4414             | `invalid_app_grant`      | Grant revoked, expired or policy changed; explicitly reconnect.                     |
| 4418             | `session_capacity`       | Owner must release capacity.                                                        |
| 4500             | `agent_execution_failed` | Gateway could not launch the adapter.                                               |

`task_busy` rejects concurrent prompts, `continuation_unavailable` rejects invalid
continuation/recovery, and `task_interrupted` means the turn was not safely
completed. `unknown_tool`, `invalid_tool_arguments` and `tool_execution_failed`
identify application tool failures. Authorization denial and takeover do not
trigger history recovery.

ACP/MCP-over-ACP support depends on the selected adapter, not merely its ACP
label. This alpha requires the gateway's pinned compatible adapter and restricted
profile; it does not claim general MCP-over-ACP interoperability. API shapes,
resume framing and adapter support can change in later prereleases. Scope is one
application conversation, one active request and a fixed approved tool snapshot.

## OpenClaw / Responses compatibility (deprecated)

The retained OpenClaw plugin path uses discovery, delegated authorization,
Open Responses and scoped execution history. Existing exports and behavior remain
available at `@open-agent-connect/web`. ACP uses its own browser pairing or an explicitly issued headless grant;
there is no automatic OAuth-to-ACP migration. See the
[OpenClaw integration guide](../../docs/guides/web-app-integration.md).

### Saved connections and scoped history

Applications may store the delegated `OpenClawConnection` inside their own
versioned, origin-local envelope. Restore the inner record through the SDK so
the provider layout, application identity, CSP-safe tool schemas and approved
tool hash are checked consistently:

```ts
import {
  createOpenClawConversationClient,
  getOpenClawConnectionProviderUrl,
  parseOpenClawConnection,
  serializeOpenClawConnection,
} from "@open-agent-connect/web";

const connection = await parseOpenClawConnection(savedConnectionJson, {
  clientId: location.origin,
});
const conversations = createOpenClawConversationClient({
  connection,
  // Resolve on every request; the application still owns refresh locking/CAS.
  getAccessToken,
});
const recent = await conversations.list({ signal });
const history = await conversations.history(recent[0].conversationId, {
  signal,
});

localStorage.setItem(
  "my-app.connection",
  serializeOpenClawConnection(connection),
);
showProviderAddress(getOpenClawConnectionProviderUrl(connection));
```

Parsing is local and immutable; it performs no discovery, refresh or storage.
An expired access token is accepted while the refresh authority remains live,
so the caller's existing refresh path can rotate it. The SDK does not extend an
application's consent lifetime or prove that a stored grant has not been
revoked. Keep any stricter app-owned absolute expiry and lifecycle checks.

`normalizeOpenClawProviderUrl` accepts a bare HTTPS origin or the Agent Connect plugin's
`/agent-connect` issuer and always returns the Agent Connect plugin form. On an OAuth
callback, rediscover using the saved transaction's verified `issuer`.

Conversation history is a bounded execution projection, not a faithful human
chat transcript. The client derives the scoped history URLs from the validated
connection, requests a fresh bearer through `getAccessToken`, never retries, and
never stores credentials. A strict native missing/expired or changed outcome is
reported as `OpenClawConversationUnavailableError`; authentication, transport,
abort and invalid-response failures remain distinct.

Communication with the gateway uses the standard Open Responses protocol profile.
Harness orchestrators like Omnigent remain internal backends behind the user's
Agent Connect gateway and are never exposed directly to the browser.

## OpenClaw authorization and sessions (deprecated)

Applications discover the Agent Connect plugin for OpenClaw, authorize their fixed page-owned tool
snapshot, and then construct an `AgentSession` over the namespaced Responses
resource. The access-token getter refreshes through the same OAuth connection;
the application owns storage and compare-and-swap of the updated connection.

```ts
import {
  AgentSession,
  beginOpenClawAuthorization,
  createOpenClawAccessTokenGetter,
  createOpenClawResponsesProvider,
  defineTool,
  discoverOpenClawProvider,
} from "@open-agent-connect/web";

const tools = [
  defineTool({
    name: "read_range",
    description: "Read cells from the current spreadsheet",
    inputSchema: {
      type: "object",
      properties: { range: { type: "string" } },
      required: ["range"],
      additionalProperties: false,
    },
    execute: ({ range }) => JSON.stringify(sheet.read(range)),
  }),
];

const provider = await discoverOpenClawProvider({
  providerUrl: "https://gateway.example/agent-connect",
  experience: "https",
});
const authorization = await beginOpenClawAuthorization({
  provider,
  redirectUri: `${location.origin}${location.pathname}`,
  tools,
});

// Save authorization.transaction, navigate to authorization.authorizationUrl,
// and complete the callback as shown in the integration guide. With the saved
// `connection`, create an authenticated fetch and session:
const getAccessToken = createOpenClawAccessTokenGetter({
  getConnection: () => connection,
  saveConnection: (updated, expected) => saveIfCurrent(updated, expected),
});
const session = new AgentSession({
  provider: createOpenClawResponsesProvider({
    connection,
    getAccessToken,
  }),
  tools,
});

for await (const event of session.streamTask("Clean up the selected table")) {
  renderAgentEvent(event);
}

for await (const event of session.streamContinuation(
  "Keep the cleanup, but leave the totals row unchanged",
)) {
  renderAgentEvent(event);
}
```

The OpenClaw-specific factory derives both the namespaced provider URL and the
required model alias from the validated connection. Do not pass
`connection.endpoint` into the low-level `ResponsesProvider`: that class appends
`/v1/responses` itself and requires an explicit model for non-OpenClaw gateways.
The provider repeats the session's fixed, owner-approved tool snapshot on every
initial, conversational-continuation, and function-output request. Applications
should not construct those continuation payloads themselves.

## Headless conversations

`createAgentChat` provides conversation state and controls, not a UI or a second
agent loop. It consumes an existing connected `AgentSession`; React, Vue, plain
DOM and optional component packages can render the same immutable snapshots.

```ts
import {
  createAgentChat,
  exportAgentChatMarkdown,
} from "@open-agent-connect/web";

const chat = createAgentChat({ session: connection.session });
render(chat.getSnapshot());
const unsubscribe = chat.subscribe(() => render(chat.getSnapshot()));

try {
  await chat.send("Explain this passage");
  await chat.send("Give me a worked example");
  const studyNotes = exportAgentChatMarkdown(chat.getSnapshot());
  // Save studyNotes in your app; this library does not write storage or files.
} catch (error) {
  // Failed turns retain partial content and typed error details in the snapshot.
  showError(error);
}

// A stop button calls await chat.stop(). Handle rejection; requesting stop is
// not proof that a remote run or arbitrary local JavaScript has stopped.
unsubscribe();
await chat.dispose();
```

- `getSnapshot()` has stable identity between changes. `subscribe(callback)`
  notifies changes only and returns an unsubscribe function. Subscriber failures
  cannot break the agent loop; use `onSubscriberError` to report them (default:
  `console.error`). Snapshots, messages, parts and tool arguments are immutable.
- `messages` contain stable ids, roles and status. Ordered text/tool parts
  preserve interleaving; the final aggregate text is not appended again. Tool
  parts expose activity and failures, **not result bodies**. An invalid call can
  appear as a failed tool part without arguments; a tool failure need not fail
  the assistant turn. Unsettled tools become `interrupted` when the turn ends.
- `send(text)` selects initial-task or completed-task continuation. It sends
  only that prompt, never the displayed history. It resolves with the completed
  or cancelled assistant message and rejects on failure. Empty/overlapping sends
  are rejected before appending messages. Check `canSend` and `needsNewSession`;
  there is no automatic reconnect or replay when a checkpoint is unavailable.
- `stop()` coalesces repeated requests for the active turn. `stopping` lasts
  until the stream settles; a completion racing stop stays completed. A stop
  failure is exposed in `snapshot.error` and rejects the control promise without
  releasing the active-turn lock. Cancellation remains best effort at the
  transport layer; it cannot prove rollback or remote delivery.
- Local handlers receive optional `context.signal`. Stop prevents not-yet-started
  tools and suppresses submission of late results. A cooperative handler should
  observe the signal. A handler that ignores it can keep the turn pending.
  Native WebMCP execution receives both task cancellation and snapshot lifetime
  signals, so stopping a turn does not itself invalidate the approved snapshot.
- `dispose()` immediately detaches observers, rejects new sends and requests
  cancellation; its promise is the cancellation request, not a guarantee that
  arbitrary local work has drained. Repeated disposal returns the same promise.
  It does not revoke grants, delete sessions or dispose caller-owned WebMCP tools.
- The helper is the exclusive consumer of its session. Do not call session task
  methods from another owner while it is attached. Attaching a previously
  completed session permits a follow-up, but does not reconstruct old messages.

The helper does not own authentication, connection setup, durable storage,
restoration, message editing, branching, images/files or model configuration.
The transcript is display state, not the agent's authoritative conversation.
`session.canStartTask` and `session.canContinueTask` expose local readiness without
revealing checkpoints; the gateway can still reject an expired session.

Known preadmission HTTP 4xx refusals (except ambiguous 408 and invalid continuation)
preserve retry readiness. Unknown network/5xx failures do not prove that nothing
ran, so they invalidate readiness rather than silently replaying a side effect.
Responses admission is observed before text; custom providers can emit
`task.admitted`, with the first other event serving as a compatibility fallback.
Terminal agent failures preserve the gateway's sanitized distinction:
`agent_authentication_failed` tells the application that the user-owned agent
cannot authenticate with its model provider, while `agent_execution_failed`
covers another underlying agent failure. Both are admitted terminal failures,
require a new session, and are never replayed automatically.

### Study-note export

`exportAgentChatMarkdown(snapshot)` exports the displayed text and marks failed,
cancelled or unfinished turns. `{ includeToolActivity: true }` adds tool names and
statuses; tool arguments/results are never included. Saving or copying the string
is application-owned. It is **not** a session restore/checkpoint format. Content
is untrusted Markdown: sanitize it if you later render HTML.

See [the headless chat contract](../../docs/architecture/browser-sdk-building-blocks.md#headless-chat).

## Content Security Policy and tool validation

Tool schemas and arguments are checked by a CSP-safe interpreter; neither
AgentSession nor WebMCP discovery requires `unsafe-eval`. Invalid definitions
fail during setup, and invalid arguments are rejected before calling a handler.
Validation does not coerce input, apply defaults, or strip extra properties.

Importing the package configures the shared Zod v4 runtime with `jitless: true`
before AI SDK schemas load. Zod otherwise probes dynamic function construction
even when that probe is caught, which violates a restrictive `script-src` policy.
The package therefore favors CSP-safe imports over Zod schema-JIT performance;
this setting also affects other Zod v4 users in the same page.

The supported boundary is self-contained draft-7 schemas (or no `$schema`),
including local references and the existing `nullable` extension. Formats remain
annotations, matching earlier SDK behavior; this is not complete Ajv parity.
Later-draft keywords previously ignored by the SDK remain ignored: do not use
them to express required constraints. Other declared dialects, unresolved refs,
`id`, `$async`, and `multipleOf` are rejected. The latter is deliberately disabled
because the interpreter's numeric tolerance can accept invalid multiples. Use
`type: "integer"` for integral values; do not omit required divisibility checks.

## Native WebMCP tools (experimental)

An application that already registers tools with `document.modelContext` can
reuse those tools through Agent Connect. Pass the snapshot's tools to the
Agent Connect plugin authorization and `AgentSession` flow above, or to
`createAiSdkApplicationTools()` for the retained Open Responses AI SDK integration.

```ts
import { createWebMcpToolSnapshot } from "@open-agent-connect/web";

// Register your page's tools first. No iframe tools are included.
const snapshot = await createWebMcpToolSnapshot({
  toolNames: ["read_range"], // optional: otherwise all current-document tools
});
// Use snapshot.tools with beginOpenClawAuthorization for the normal consent
// flow. After the callback, create the AgentSession as shown above. The gateway
// checks the definitions against the approved grant on every request.
try {
  const session = createAuthorizedSession(snapshot.tools, connection);
  await session.runTask("Read the selected cells");
} finally {
  snapshot.dispose();
}
```

The snapshot deeply freezes definitions and uses native WebMCP execution.
Returned strings are passed intact to the existing tool-result loop. Invocation
rejections become ordinary application tool failures. Tool metadata such as
annotations/title is not added to the gateway's name/description/schema grant
contract and must not be treated as an extra permission.

`toolchange`, `pagehide`, explicit `dispose()`, or the optional caller `signal`
permanently invalidates the snapshot and requests cancellation of pending local
calls. Inspect `snapshot.signal.aborted` or listen for its abort event to show
reconnect UI. A changed snapshot requires fresh consent; the adapter never adds
tools to a live grant. Disposal removes listeners. Keep the snapshot alive for
as long as you need completed-task continuation, then dispose it when
disconnecting. `session.cancel()` also signals the current native tool
invocation, without invalidating the whole snapshot. Disposing the snapshot
alone does not cancel a gateway run and cannot roll back a side effect; cancel
the session too when ending the interaction.

Compatibility is deliberately narrow: native Chrome for Testing 153.0.8010.12
with experimental web platform features enabled, whose discovery schemas and
execution arguments use JSON strings. The current WebMCP CG draft uses objects;
that binding is not claimed here. Browsers without native discovery/execution
raise `webmcp_unavailable`. There is no testing API, navigator fallback, or
polyfill installed by this SDK. See [the WebMCP contract](../../docs/architecture/browser-sdk-building-blocks.md#webmcp-tool-source).

WebMCP descriptors identify tools by document/name, not immutable registration
ID. Observed registry changes stop dispatch, but native same-name replacement
can race notification. This adapter freezes approved definitions; it does not
attest handler identity or turn a page into a sandbox. Calls are never retried
automatically using a different argument format.

Run `npm run test:webmcp` from the repository root for real native browser
coverage. Set `WEBMCP_CHROMIUM_EXECUTABLE` to a compatible Chrome executable
if Playwright's default Chromium lacks this experimental binding. Missing native support fails
the suite instead of silently skipping it. `verify:full` includes this gate.

See the repository's complete
[web application integration guide](https://github.com/jomi-se/agent-connect/blob/main/docs/guides/web-app-integration.md)
for callback handling, transaction storage, package installation, revocation,
and the real gateway setup.

## OpenClaw compatibility constraints

- One active task per application session and a linear completed-turn history
- A fixed tool snapshot per session
- No generic exactly-once execution

The OAuth grant fixes the application identity, restricted profile, native
capabilities and page-owned tool snapshot. Changing those inputs requires new
consent. Access tokens rotate through the refresh authority; revocation ends
that authority immediately.

Conversation ownership remains application-scoped and process-local. Keep the
provider checkpoint returned by a completed task for an explicit follow-up, or
use the scoped conversation client for recent execution-history projections.
Those projections are not faithful human-chat transcripts and may become
unavailable after restart or policy change.
