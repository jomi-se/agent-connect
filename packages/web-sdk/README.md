# `@open-agent-connect/web`

Browser SDK for adding AI features backed by a user-owned agent. The current
published provider path is the Agent Connect plugin for OpenClaw; the application talks to
the gateway through the bounded Open Responses contract and keeps its own tool
implementations.

Install the published package in the web application:

```sh
npm install @open-agent-connect/web@0.0.6
```

The package provides:

- Agent Connect plugin for OpenClaw discovery, OAuth authorization and token management;
- Open Responses (`/v1/responses`) HTTP/SSE communication with multi-turn response continuation (`previous_response_id`);
- Provider-neutral `AgentSession` and task event streaming;
- JSON Schema validation before browser tool execution;
- Correlated tool results returned to the same agent turn.

For the Agent Connect plugin for OpenClaw, pass the path-bound provider URL
`https://<gateway-host>/agent-connect` to `discoverOpenClawProvider`. The SDK
uses RFC well-known discovery for that issuer and returns the namespaced
`/agent-connect/v1/responses` resource. A bare HTTPS origin is normalized to
that path as an input convenience; it does not select a different gateway
implementation. For a complete current setup and authorization example, see the
[web application integration guide](../../docs/guides/web-app-integration.md).

## Saved connections and scoped history

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

## Authorization and sessions

Applications discover the Agent Connect plugin for OpenClaw, authorize their fixed page-owned tool
snapshot, and then construct an `AgentSession` over the namespaced Responses
resource. The access-token getter refreshes through the same OAuth connection;
the application owns storage and compare-and-swap of the updated connection.

```ts
import {
  AgentSession,
  ResponsesProvider,
  beginOpenClawAuthorization,
  createOpenClawAccessTokenGetter,
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
const authenticatedFetch = async (
  input: RequestInfo | URL,
  init?: RequestInit,
) => {
  const headers = new Headers(init?.headers);
  headers.set("Authorization", `Bearer ${await getAccessToken(init?.signal)}`);
  return fetch(input, { ...init, headers, credentials: "omit" });
};
const session = new AgentSession({
  provider: new ResponsesProvider({
    baseUrl: connection.resource,
    fetch: authenticatedFetch,
    credentials: "omit",
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

See [the implementation and validation contract](../../docs/plan/headless-chat.md).

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
`createAiSdkApplicationTools()` for the current AI SDK integration.

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

The OAuth grant fixes the application identity, restricted profile, native
capabilities and page-owned tool snapshot. Changing those inputs requires new
consent. Access tokens rotate through the refresh authority; revocation ends
that authority immediately.

Conversation ownership remains application-scoped and process-local. Keep the
provider checkpoint returned by a completed task for an explicit follow-up, or
use the scoped conversation client for recent execution-history projections.
Those projections are not faithful human-chat transcripts and may become
unavailable after restart or policy change.
