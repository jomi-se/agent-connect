# Agent Connect browser SDK

`@open-agent-connect/web@0.0.10` is the ACP browser API at the package root.
ACP, MCP-over-ACP and Agent Connect's resumable transport remain **experimental**.
The gateway is independently versioned at 0.0.1. Both candidates are unpublished.

```sh
npm install @open-agent-connect/web@0.0.10 @ai-sdk/react react
```

## Pair and chat

The application owns its functions and effects. Approve a fixed tool snapshot
on the user's gateway before connecting. Use an explicit popup/redirect action
with a same-origin callback; capture and remove callback credentials before
rendering. Access/refresh credentials are session-scoped and never enter URLs.

```tsx
import { useMemo } from "react";
import { useChat } from "@ai-sdk/react";
import {
  connectAgent,
  createAcpChatTransport,
  captureAcpPairingCallback,
  defineTool,
  type AcpProvider,
  type ApplicationTool,
} from "@open-agent-connect/web";

const callbackUrl = captureAcpPairingCallback();
const tools = [
  defineTool({
    name: "read_note",
    description: "Read the open note",
    inputSchema: {
      type: "object",
      properties: {},
      additionalProperties: false,
    },
    execute: () => "The open note belongs to this application.",
  }),
];

// Call from an explicit user action. Resume stored approval at startup only
// after this optional feature is opened; never auto-send a prompt.
async function pair(gatewayUrl: string) {
  return connectAgent({
    gatewayUrl,
    tools,
    pairing: {
      mode: "popup",
      redirectUri: window.location.origin + window.location.pathname,
      callbackUrl,
      clientName: "Notes",
    },
  });
}

export function Chat({
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
  const { messages, sendMessage, stop, status, error } = useChat({ transport });
  // Render messages and provide explicit send/stop controls in the application.
  return (
    <button
      disabled={status === "streaming" || status === "submitted"}
      onClick={() => void sendMessage({ text: "Read my note" })}
    >
      Read note
    </button>
  );
}
```

The [typechecked React example](examples/acp-use-chat.tsx) renders thoughts, tool
progress and plans. The [standalone sample](../../examples/acp-chat/README.md)
adds pairing, lifecycle and recovery controls using packed public exports.
Dispose the chat transport and close its provider when leaving. BFCache pages
retain their connection and check liveness on restoration.

## Tools and authority

`defineTool` supplies a schema and handler. The ACP transport validates arguments
with CSP-safe JSON Schema, executes each approved request with its stable action
ID and returns structured MCP results. Do not add a second AI SDK
`execute`/`onToolCall` loop for those same tools. Handlers own side effects and
must provide idempotency or action-ID deduplication where needed. Cooperative
cancellation uses the handler's signal; cancellation cannot undo an effect.

`createWebMcpToolSnapshot` captures selected native browser tools before consent.
Definitions remain fixed, registry changes invalidate the snapshot, and disposal
aborts borrowed execution without unregistering the page's tools. See
[the WebMCP boundary](../../docs/architecture/browser-sdk-building-blocks.md).

## Recovery and errors

The transport sends only the latest explicit text user message. Harness history
is authoritative; UI messages are presentation and are never replayed. Automatic
sequence reattachment preserves the ongoing stream and deduplicates frames.
If a resumable session has ended, `provider.recover()` loads its history and
reports interruption. The application retains the interrupted transcript and
allows a deliberate next prompt. It never retries an uncertain prompt or effect.
Owner eviction needs a new connection; revoked approval needs fresh consent.

`AgentConnectError` provides a stable code and optional HTTP status/owner
`manageUrl`. `AcpTransportError` includes the close code. Capacity remains held
until owned box cleanup succeeds; offer an owner-console link when supplied.
`transport.error` retains the typed streaming failure even when AI SDK presents
it as text. Low-level ACP stream and single-server helpers are exported for explicit protocol
integration and remain unstable. No agent credentials are exposed to the app.
