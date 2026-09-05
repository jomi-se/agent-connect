# `@open-agent-connect/web`

Browser SDK to implement AI features leveraging a user owned AI agent behind an Agent Connect Gateway

The package provides:

- Signed runtime-card verification;
- Gateway authorization and token management;
- Open Responses (`/v1/responses`) HTTP/SSE communication with multi-turn response continuation (`previous_response_id`);
- Provider-neutral `AgentSession` and task event streaming;
- JSON Schema validation before browser tool execution;
- Correlated tool results returned to the same agent turn.

Communication with the gateway uses the standard Open Responses protocol profile. Harness orchestrators like Omnigent remain internal backends behind the user's Agent Connect gateway and are never exposed directly to the browser.

```ts
import {
  beginAgentAuthorization,
  completeAgentAuthorization,
  connectAgent,
  defineTool,
  parseRuntimeCard,
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

const runtimeCard = parseRuntimeCard(cardEnteredByTheUser);
const authorization = await beginAgentAuthorization({
  runtimeCard,
  appId: "my-spreadsheet",
  redirectUri: `${location.origin}${location.pathname}`,
  tools,
});

// Save authorization.transaction, navigate to authorization.authorizeUrl,
// then exchange the returned code with completeAgentAuthorization().

const connection = await connectAgent({
  baseUrl: runtimeCard.endpoint,
  appId: "my-spreadsheet",
  tools,
  accessToken: approvedGrant.accessToken,
});

for await (const event of connection.session.streamTask(
  "Clean up the selected table",
)) {
  renderAgentEvent(event);
}

for await (const event of connection.session.streamContinuation(
  "Keep the cleanup, but leave the totals row unchanged",
)) {
  renderAgentEvent(event);
}
```

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

### Study-note export

`exportAgentChatMarkdown(snapshot)` exports the displayed text and marks failed,
cancelled or unfinished turns. `{ includeToolActivity: true }` adds tool names and
statuses; tool arguments/results are never included. Saving or copying the string
is application-owned. It is **not** a session restore/checkpoint format. Content
is untrusted Markdown: sanitize it if you later render HTML.

See [the implementation and validation contract](../../docs/plan/headless-chat.md).

## Native WebMCP tools (experimental)

An application that already registers tools with `document.modelContext` can
reuse those tools through Agent Connect:

```ts
import {
  createWebMcpToolSnapshot,
  connectAgent,
} from "@open-agent-connect/web";

// Register your page's tools first. No iframe tools are included.
const snapshot = await createWebMcpToolSnapshot({
  toolNames: ["read_range"], // optional: otherwise all current-document tools
});
// Use snapshot.tools with beginAgentAuthorization for the normal consent flow.
// After a redirect, rediscover from the new document. The gateway still checks
// the definitions against the approved grant before admitting a session.
try {
  const connection = await connectAgent({
    baseUrl: runtimeCard.endpoint,
    appId: "my-spreadsheet",
    tools: snapshot.tools,
    accessToken: approvedGrant.accessToken,
  });
  await connection.session.runTask("Read the selected cells");
} finally {
  snapshot.dispose();
}
```

The snapshot deeply freezes definitions and uses native WebMCP execution.
Returned strings are passed intact to the existing tool-result loop. Invocation
rejections become ordinary application tool failures. Tool metadata such as
annotations/title is not added to the gateway's name/description/schema grant
contract and must not be treated as an extra permission.

`toolchange`, `pagehide`, explicit `dispose()`, or the optional caller
`signal` permanently invalidates the snapshot and requests cancellation of
pending local calls. Inspect `snapshot.signal.aborted` or listen for its abort
event to show reconnect UI. Rediscover and establish a new authorized connection
after a change; the adapter never adds tools to a live session. Disposal removes
listeners. Keep the snapshot alive for as long as you need completed-task
continuation, then dispose it when disconnecting. `connection.session.cancel()`
also signals the current native tool invocation, without invalidating the whole
snapshot. Disposing the snapshot alone does not cancel a gateway run and cannot
roll back a side effect; cancel the session too when ending the interaction.

Compatibility is deliberately narrow: native Chrome for Testing 153.0.8010.12
with experimental web platform features enabled, whose discovery schemas and
execution arguments use JSON strings. The current WebMCP CG draft uses objects;
that binding is not claimed here. Browsers without native discovery/execution
raise `webmcp_unavailable`. There is no testing API, navigator fallback, or
polyfill installed by this SDK. See [the compatibility plan](../../docs/plan/webmcp-tool-source.md).

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

## Current constraints

- One active task per application session and a linear completed-turn history
- A fixed tool snapshot per session
- No generic exactly-once execution

`connectAgent` with an application grant always starts a new independent
conversation: it provisions a new opaque application session and provider
session, and does not require reauthorization. Sessions run in parallel and are
independent.

To reconnect to a conversation rather than start one, pass that session's own
capability — the `accessToken` the previous connect returned — as
`accessToken`. Reconnecting is therefore something the application has to
prepare for: persist the session capability (and, for continuing a turn, its
checkpoint) somewhere that survives the reload. An application grant cannot
find a session for you. There is no key it could search by that is not shared
with every other tab of the same application, so a lookup would sooner or later
hand one tab another tab's conversation; a page reload that has kept nothing
simply starts a new session, and the old one ends on its own.

`freshSession` is deprecated and now has no effect, since presenting the
application grant already means "create".

The gateway holds at most eight live sessions per grant, application, and tool
snapshot. Beyond that it answers `429` with `Retry-After` and a `manageUrl`
pointing at the gateway's own session page, where the owner can end a session
to free a slot immediately. Slots also free themselves: a session is retired
after roughly fifteen minutes idle, after three minutes holding a function call
the application never answered, or after thirty minutes of a turn making no
progress. All three are configurable on the gateway.

A capability that still verifies but names a retired session is answered with
`401 {"error": "session_expired"}`, distinct from `invalid_session_capability`.
The correct response is to start a new session rather than refresh the token.
