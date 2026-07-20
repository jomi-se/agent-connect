# Integrate Agent Connect into a web application

This guide connects an arbitrary HTTPS web application to the real
OmniGENT/Codex reference connector. The app declares tools implemented in its
own JavaScript, asks the user to authorize their connector, and sends tasks
through an opaque Agent Connect session. It does not install an MCP server into
Codex or expose an OmniGENT session id.

## Install the current source package

`@agent-connect/web` has not yet been published to npm. Build a normal npm
tarball from the repository and install it into another application:

```sh
cd /path/to/agent-connect
npm install
npm run build --workspace @agent-connect/web
mkdir -p .agent-connect/packages
npm_config_cache=.agent-connect/npm-cache \
  npm pack --workspace @agent-connect/web \
  --pack-destination .agent-connect/packages

cd /path/to/your-web-app
npm install /path/to/agent-connect/.agent-connect/packages/agent-connect-web-0.0.0.tgz
```

The tarball contains browser ESM and TypeScript declarations. OmniGENT, ACP,
Codex, Tailscale, and Node gateway types do not enter the application bundle.

## Declare an application-owned tool

```ts
import {
  beginAgentAuthorization,
  completeAgentAuthorization,
  connectAgent,
  defineTool,
  parseAuthorizationTransaction,
  parseRuntimeCard,
  serializeAuthorizationTransaction,
  type AgentConnection,
} from "@agent-connect/web";

const APP_ID = "my-shopping-list";
const REDIRECT_URI = `${location.origin}${location.pathname}`;
const TRANSACTION_KEY = "agent-connect.authorization-transaction";
const GRANT_KEY = "agent-connect.app-grant";

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

The description and JSON Schema are authority requested from the user. The
connector displays them during consent and binds the resulting grant to their
canonical hash. Changing the tool definition requires new authorization.

## Authorize the user's connector

The user supplies a public runtime card exported by their connector. The card
contains an endpoint and public identity key, not an agent credential or bearer
token.

```ts
async function connectRuntime(runtimeCardText: string) {
  const runtimeCard = parseRuntimeCard(runtimeCardText);
  let accessToken = sessionStorage.getItem(GRANT_KEY);

  const transactionText = sessionStorage.getItem(TRANSACTION_KEY);
  const callback = new URL(location.href);
  if (
    transactionText &&
    (callback.searchParams.has("code") || callback.searchParams.has("error"))
  ) {
    const grant = await completeAgentAuthorization({
      runtimeCard,
      appId: APP_ID,
      redirectUri: REDIRECT_URI,
      transaction: parseAuthorizationTransaction(transactionText),
      callbackUrl: callback.toString(),
    });
    accessToken = grant.accessToken;
    sessionStorage.setItem(GRANT_KEY, accessToken);
    sessionStorage.removeItem(TRANSACTION_KEY);
    history.replaceState({}, "", REDIRECT_URI);
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
    location.assign(authorization.authorizeUrl);
    return;
  }

  return connectAgent({
    baseUrl: runtimeCard.endpoint,
    appId: APP_ID,
    tools,
    accessToken,
  });
}
```

`beginAgentAuthorization` first verifies a fresh connector signature against
the key pinned in the runtime card. Only then does it send the app id, redirect,
scopes, and tool definitions. For the private Tailscale profile, a previously
unknown HTTPS Origin may request authorization; the user approves it on the
connector-owned page. No gateway restart or Origin pre-registration is needed.

The example keeps the bearer grant in `sessionStorage`, matching the current
demo. A production app should select storage and XSS controls appropriate to
its threat model. DPoP/app-instance sender binding is not implemented yet.

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
```

`AgentSession` validates requested arguments against the declared schema and
executes the matching browser handler. The tool result is correlated back to
the same agent turn. Stable action ids support application-owned deduplication;
Agent Connect does not claim generic exactly-once side effects.

## Connector requirements

The user must have the [real reference connector](../../deploy/real-connector/README.md)
running and reachable through Tailscale Serve. The application must itself use
HTTPS because redirect URIs and dynamically enrolled Origins are HTTPS-only.
The browser must be signed into the connector operator's allowed tailnet
identity.

The current reference scope is one user, one online OmniGENT host, one agent,
one active task per application session, and one fixed tool snapshot per
downstream session.
