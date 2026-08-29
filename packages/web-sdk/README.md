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
```

See the repository's complete
[web application integration guide](https://github.com/jomi-se/agent-connect/blob/main/docs/guides/web-app-integration.md)
for callback handling, transaction storage, package installation, revocation,
and the real gateway setup.

## Current constraints

- One active task per application session
- A fixed tool snapshot per session
- No generic exactly-once execution
