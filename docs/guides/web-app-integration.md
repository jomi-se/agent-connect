# Integrate Agent Connect into a web application

This guide connects an HTTPS web application to the stock OpenClaw scoped proxy.
The app declares functions implemented in its own JavaScript, redirects the user
to owner-controlled consent, then uses AI SDK over a bounded Open Responses wire.
No OpenClaw credential, agent ID or session key enters the browser.

## Install and define tools

```sh
npm install @open-agent-connect/web ai
```

```ts
import {
  beginOpenClawAuthorization,
  completeOpenClawAuthorization,
  createAiSdkApplicationTools,
  createAiSdkOpenResponsesGenerationOptions,
  createAiSdkOpenResponsesModel,
  createOpenClawAccessTokenGetter,
  defineTool,
  discoverOpenClawProvider,
  parseOpenClawAuthorizationTransaction,
  revokeOpenClawConnection,
  selectAiSdkOpenResponsesCheckpoint,
  serializeOpenClawAuthorizationTransaction,
  type OpenClawConnection,
} from "@open-agent-connect/web";
import { streamText } from "ai";

const REDIRECT_URI = `${location.origin}${location.pathname}`;
const TX_KEY = "agent-connect.openclaw-transaction";
const CONNECTION_KEY = "agent-connect.openclaw-connection";

const applicationTools = [
  defineTool({
    name: "add_list_items",
    description: "Add several items to the current shopping list",
    inputSchema: {
      type: "object",
      properties: {
        items: { type: "array", items: { type: "string" }, minItems: 1 },
      },
      required: ["items"],
      additionalProperties: false,
    },
    execute: async ({ items }) => {
      for (const item of items as string[]) await shoppingList.add(item);
      return { added: (items as string[]).length };
    },
  }),
];
```

The tool name, description and schema are the permission request. The owner sees
that exact snapshot, and the proxy requires the client to submit it unchanged on
every segment. Changing it requires new consent. The app owns side effects and
should deduplicate consequential operations with the stable tool-call ID.

## Discover and authorize

The user supplies the public HTTPS origin of a scoped proxy they operate. The app
validates its OAuth metadata, creates a PAR/S256 PKCE transaction, saves it before
navigation, and redirects to the proxy:

```ts
async function startAuthorization(providerUrl: string) {
  const provider = await discoverOpenClawProvider({
    providerUrl,
    experience: "https",
  });
  const started = await beginOpenClawAuthorization({
    provider,
    redirectUri: REDIRECT_URI,
    tools: applicationTools,
  });
  sessionStorage.setItem(
    TX_KEY,
    serializeOpenClawAuthorizationTransaction(started.transaction),
  );
  sessionStorage.setItem("agent-connect.provider", providerUrl);
  location.assign(started.authorizationUrl);
}
```

The proxy first asks the owner for their saved Agent Connect enrollment secret,
then displays the app Origin, callback, scopes, tools and selected static policy.
This owner login is separate from application OAuth. Tailnet membership and
forwarded identity headers are not owner proof.

After the redirect returns, exchange the one-time code and clear the transaction
even on failure:

```ts
async function finishAuthorization(): Promise<OpenClawConnection | undefined> {
  const serialized = sessionStorage.getItem(TX_KEY);
  const providerUrl = sessionStorage.getItem("agent-connect.provider");
  if (!serialized || !providerUrl) return;
  const callback = new URL(location.href);
  if (
    !callback.searchParams.has("code") &&
    !callback.searchParams.has("error")
  ) {
    return;
  }
  try {
    const provider = await discoverOpenClawProvider({
      providerUrl,
      experience: "https",
    });
    const connection = await completeOpenClawAuthorization({
      provider,
      redirectUri: REDIRECT_URI,
      transaction: parseOpenClawAuthorizationTransaction(serialized),
      callbackUrl: callback.toString(),
    });
    sessionStorage.setItem(CONNECTION_KEY, JSON.stringify(connection));
    return connection;
  } finally {
    sessionStorage.removeItem(TX_KEY);
    history.replaceState({}, "", REDIRECT_URI);
  }
}
```

The connection and transaction contain credentials. `sessionStorage` matches the
current demo; production applications should choose storage and XSS controls for
their threat model. A runtime URL is discovery information, not proof that the
operator configured the upstream safely.

## Run and continue a conversation

Keep the current connection in application-owned state. The token getter refreshes
once and replaces it only if no concurrent disconnect/replacement won the race:

```ts
let connection: OpenClawConnection | undefined = JSON.parse(
  sessionStorage.getItem(CONNECTION_KEY)!,
) as OpenClawConnection;
const configuredConnection = connection;

const getAccessToken = createOpenClawAccessTokenGetter({
  getConnection: () => {
    if (!connection) throw new Error("Connection closed");
    return connection;
  },
  saveConnection: (next, expected) => {
    if (connection !== expected) return false;
    connection = next;
    sessionStorage.setItem(CONNECTION_KEY, JSON.stringify(next));
    return true;
  },
});

const model = createAiSdkOpenResponsesModel({
  endpoint: configuredConnection.endpoint,
  model: configuredConnection.model,
  getAccessToken,
});
const tools = createAiSdkApplicationTools(applicationTools, {
  connectionId: configuredConnection.applicationToolsHash,
});

let checkpoint: string | undefined;

async function runPrompt(prompt: string) {
  const result = streamText({
    model,
    prompt,
    tools,
    ...createAiSdkOpenResponsesGenerationOptions(checkpoint),
  });
  for await (const text of result.textStream) appendAgentText(text);
  checkpoint = selectAiSdkOpenResponsesCheckpoint(
    checkpoint,
    await result.finalStep,
  );
}
```

The generation options set `maxRetries: 0`. Tool output and later prompts name
the explicit prior response checkpoint; the proxy maps that ID to this exact
grant and private conversation. Never retry an ambiguously admitted failure.
A failed/disconnected attempt, proxy restart, 30-minute mapping expiry,
revocation or policy change ends continuity. Start a new conversation rather
than guessing an OpenClaw session or replaying a possible mutation.

Ordinary application handler failures should be returned as tool results so the
model can respond; transport interruption is reserved for failures at the proxy
or upstream boundary.

## Revoke

```ts
async function disconnect() {
  const current = connection;
  if (!current) return;
  connection = undefined; // make late refresh saves fail
  sessionStorage.removeItem(CONNECTION_KEY);
  await revokeOpenClawConnection({ connection: current });
}
```

Revocation prevents new requests and continuations immediately. It does not prove
that an already admitted upstream effect was undone.

## Deployment requirements

The owner must follow the [scoped-proxy guide](../../deploy/openclaw-gateway/README.md):
published pinned stock OpenClaw and the proxy on loopback, explicit HTTPS ingress,
private operator credential, reload disabled, a dedicated closed agent and one
supervisor controlling config/restart/reconsent. The current scope is one owner,
preconfigured policies and bounded process-local conversations. Selected
subscription/browser behavior remains a separate live acceptance gate.
