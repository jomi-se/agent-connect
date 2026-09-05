# Integrate Agent Connect into a web application

This guide connects an arbitrary HTTPS web application to the real
Omnigent/Codex reference gateway. The app declares tools implemented in its
own JavaScript, asks the user to authorize their gateway, and sends tasks
through an Agent Connect session.

## Install the package

`@open-agent-connect/web` is published to npm:

```sh
cd /path/to/your-web-app
npm install @open-agent-connect/web
```

The package ships browser ESM and TypeScript declarations. It is versioned
`0.0.x` while the wire format settles, so `^0.0.2` resolves to that exact
version and every upgrade has to be requested deliberately.

### Installing from source instead

To develop against unreleased changes, build a tarball from the repository and
install that:

```sh
cd /path/to/agent-connect
npm install
npm run build --workspace @open-agent-connect/web
mkdir -p .agent-connect/packages
npm_config_cache=.agent-connect/npm-cache \
  npm pack --workspace @open-agent-connect/web \
  --pack-destination .agent-connect/packages

cd /path/to/your-web-app
npm install /path/to/agent-connect/.agent-connect/packages/open-agent-connect-web-0.0.2.tgz
```

The tarball filename tracks the version in `packages/web-sdk/package.json`.

## Declare an application-owned tool

```ts
import {
  AgentConnectError,
  beginAgentAuthorization,
  completeAgentAuthorization,
  connectAgent,
  defineTool,
  parseAuthorizationTransaction,
  parseRuntimeCard,
  revokeAgentAuthorization,
  serializeAuthorizationTransaction,
  type AgentConnection,
} from "@open-agent-connect/web";

const APP_ID = "my-shopping-list";
const REDIRECT_URI = `${location.origin}${location.pathname}`;
const TRANSACTION_KEY = "agent-connect.authorization-transaction";
const GRANT_KEY = "agent-connect.app-grant";
const RUNTIME_CARD_KEY = "agent-connect.runtime-card";

const tools = [
  defineTool({
    name: "add_list_items",
    description: "Add several items to the current shopping list",
    inputSchema: {
      type: "object",
      properties: {
        items: {
          type: "array",
          items: { type: "string" },
          minItems: 1,
        },
      },
      required: ["items"],
      additionalProperties: false,
    },
    execute: async ({ items }) => {
      for (const item of items as string[]) await shoppingList.add(item);
      return {
        content: [
          { type: "text", text: JSON.stringify({ added: items.length }) },
        ],
      };
    },
  }),
];
```

The tool name, description, and input schema are the app’s permission request.
The gateway shows them to the user before approval and ties the auth grant to
those exact definitions. If the app changes a definition, it must ask for
permission again.

## Authorize the user's gateway

The user supplies a public runtime card exported by their gateway. The card
contains an endpoint and public identity key. It allows the app to reach the
gateway and verify that it holds the expected private key.

```ts
async function connectRuntime(
  runtimeCardText?: string,
): Promise<AgentConnection | undefined> {
  const serializedCard =
    runtimeCardText?.trim() || sessionStorage.getItem(RUNTIME_CARD_KEY);
  if (!serializedCard) throw new Error("No Agent Connect runtime card saved");
  const runtimeCard = parseRuntimeCard(serializedCard);
  sessionStorage.setItem(RUNTIME_CARD_KEY, JSON.stringify(runtimeCard));
  let accessToken = sessionStorage.getItem(GRANT_KEY);

  const transactionText = sessionStorage.getItem(TRANSACTION_KEY);
  const callback = new URL(location.href);
  const hasCallback =
    callback.searchParams.has("code") || callback.searchParams.has("error");
  if (transactionText && hasCallback) {
    try {
      const grant = await completeAgentAuthorization({
        runtimeCard,
        appId: APP_ID,
        redirectUri: REDIRECT_URI,
        transaction: parseAuthorizationTransaction(transactionText),
        callbackUrl: callback.toString(),
      });
      accessToken = grant.accessToken;
      sessionStorage.setItem(GRANT_KEY, accessToken);
    } finally {
      // A denial or malformed callback must not leave the app in a retry loop.
      sessionStorage.removeItem(TRANSACTION_KEY);
      history.replaceState({}, "", REDIRECT_URI);
    }
  }

  if (!accessToken) {
    const authorization = await beginAgentAuthorization({
      runtimeCard,
      appId: APP_ID,
      redirectUri: REDIRECT_URI,
      tools,
    });
    sessionStorage.setItem(
      TRANSACTION_KEY,
      serializeAuthorizationTransaction(authorization.transaction),
    );
    // Persist both values before the full-page gateway redirect.
    sessionStorage.setItem(RUNTIME_CARD_KEY, JSON.stringify(runtimeCard));
    location.assign(authorization.authorizeUrl);
    return;
  }

  try {
    return await connectAgent({
      baseUrl: runtimeCard.endpoint,
      appId: APP_ID,
      tools,
      accessToken,
    });
  } catch (error) {
    if (
      error instanceof AgentConnectError &&
      error.code === "invalid_app_grant"
    ) {
      sessionStorage.removeItem(GRANT_KEY);
      return connectRuntime(JSON.stringify(runtimeCard));
    }
    throw error;
  }
}

async function resumeAuthorizationCallback() {
  const transactionText = sessionStorage.getItem(TRANSACTION_KEY);
  if (!transactionText) return;
  const transaction = parseAuthorizationTransaction(transactionText);
  const callback = new URL(location.href);
  if (
    !callback.searchParams.has("code") &&
    !callback.searchParams.has("error")
  ) {
    return;
  }
  // Do not consume a callback belonging to another OAuth-style integration.
  if (callback.searchParams.get("state") !== transaction.state) return;
  try {
    const connection = await connectRuntime();
    if (connection) useConnection(connection);
  } catch (error) {
    showConnectionError(error);
  }
}

async function disconnectRuntime() {
  const serializedCard = sessionStorage.getItem(RUNTIME_CARD_KEY);
  const accessToken = sessionStorage.getItem(GRANT_KEY);
  try {
    if (serializedCard && accessToken) {
      await revokeAgentAuthorization({
        baseUrl: parseRuntimeCard(serializedCard).endpoint,
        appId: APP_ID,
        accessToken,
      });
    }
  } finally {
    sessionStorage.removeItem(GRANT_KEY);
    sessionStorage.removeItem(TRANSACTION_KEY);
  }
}

void resumeAuthorizationCallback();
```

`beginAgentAuthorization` first verifies a fresh gateway signature against
the key pinned in the runtime card. Only then does it send the app id, redirect,
scopes, and tool definitions. For the private Tailscale profile, a previously
unknown HTTPS Origin may request authorization; the user approves it on the
gateway-owned page.

The example keeps the runtime card, authorization transaction, and bearer grant
in `sessionStorage`, matching the current demo. The runtime card is public
identity material; the transaction and grant are credentials. A production app
should select storage and XSS controls appropriate to its threat model.

## Send a task and handle the live result

```ts
async function runPrompt(connection: AgentConnection, prompt: string) {
  for await (const event of connection.session.streamTask(prompt)) {
    if (event.type === "text.delta") appendAgentText(event.delta);
    if (event.type === "tool.requested") showToolActivity(event);
    if (event.type === "tool.completed") finishToolActivity(event);
    if (event.type === "task.failed") throw new Error(event.error.message);
  }
}

async function refinePrompt(connection: AgentConnection, prompt: string) {
  for await (const event of connection.session.streamContinuation(prompt)) {
    if (event.type === "text.delta") appendAgentText(event.delta);
    if (event.type === "task.failed") throw new Error(event.error.message);
  }
}
```

Under the hood, `AgentSession` drives standard Open Responses (`POST /v1/responses`)
streams. When the agent requests an approved application tool, the response
segment ends with a function call. `AgentSession` validates requested arguments
against the declared schema, executes the matching browser handler, and continues
the chain with `previous_response_id` and the correlated function output. Stable
action ids support application-owned deduplication; Agent Connect does not claim
generic exactly-once side effects.

A completed task publishes an opaque continuation checkpoint inside the SDK.
`streamContinuation()` and `continueTask()` explicitly advance that linear
conversation. A failed, cancelled, interrupted, or lost-checkpoint session must
not be guessed back into continuity. To start over without repeating consent,
call `connectAgent` with the application grant; the gateway provisions a new
opaque application and provider session under it. It neither waits for nor
replaces an older session, so a page refresh is not blocked by an abandoned
task. Independent sessions may run concurrently, with one active task inside
each session. The gateway permits up to eight unexpired sessions per grant,
application, and tool snapshot in one process. Session lifetime slides on
activity under the idle, parked, and stalled clocks described in
[the session lifecycle](../plan/parallel-expiring-sessions-mvp.md); expiry
retires the opaque session and best-effort cancels retained work.

Reconnecting to an existing conversation is a different operation, and it is
one the application has to prepare for. Pass that session's own capability —
the `accessToken` from the previous connect — as `accessToken`, and persist it
(with the continuation checkpoint, to resume the conversation rather than only
the session) somewhere that survives the reload. The gateway will not select a
session for a bare application grant: every key it could search by is shared
with every other tab of the same application, so it would eventually connect
one tab to another tab's conversation. Losing the capability therefore starts
over — it does not recover browser state or replay a pending function call.

## Gateway requirements

The user must have the [real reference gateway](../../deploy/real-gateway/README.md)
running and reachable through Tailscale Serve. _The application must itself use
HTTPS_ because redirect URIs and dynamically enrolled Origins are HTTPS-only.
The browser must be signed into the gateway operator's allowed tailnet
identity.

The current reference scope is one user, one online Omnigent host, one agent,
one active task per application session, and one fixed tool snapshot per
downstream session.
