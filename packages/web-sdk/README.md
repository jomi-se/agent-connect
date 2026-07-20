# `@agent-connect/web`

Browser-safe, harness-neutral primitives for lending temporary application
tools to a user-owned agent runtime.

The package provides:

- signed runtime-card verification before application disclosure;
- connector-owned authorization with PKCE;
- opaque Agent Connect sessions and provider-neutral task events;
- JSON Schema validation before browser tool execution; and
- correlated tool results returned to the same agent turn.

OmniGENT is the first provider behind the gateway. Its session ids and wire
types do not enter this API.

```ts
import {
  beginAgentAuthorization,
  completeAgentAuthorization,
  connectAgent,
  defineTool,
  parseRuntimeCard,
} from "@agent-connect/web";

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
and the real connector setup.

## Current constraints

- one active task per application session;
- a fixed tool snapshot per logical/downstream session;
- in-memory action suppression only, not generic exactly-once execution;
- bearer app grants are not yet sender-bound with DPoP;
- no durable unresolved-tool recovery yet; and
- the experimental MCP-over-ACP helpers are not the default provider path.

MIT licensed.
