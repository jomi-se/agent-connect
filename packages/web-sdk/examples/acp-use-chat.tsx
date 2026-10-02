import { useMemo, useState } from "react";
import { useChat } from "@ai-sdk/react";
import {
  createAcpChatTransport,
  type AcpProvider,
  type ApplicationTool,
} from "../src/index.js";

/** Unreleased ACP/MCP-over-ACP example. Connect an approved provider before mounting. */
export function AcpChatExample({
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
  const { messages, sendMessage, stop, status, error } = useChat({
    id: "reader-chat",
    transport,
  });
  const [input, setInput] = useState("");
  const busy = status === "submitted" || status === "streaming";
  return (
    <section aria-label="Agent chat">
      <div id="chat-status" role="status">
        {status}
      </div>
      <div id="chat-messages" aria-live="polite">
        {messages.map((message) => (
          <article key={message.id} data-role={message.role}>
            {message.parts.map((part, index) => {
              if (part.type === "text") return <p key={index}>{part.text}</p>;
              if (part.type === "reasoning")
                return (
                  <details key={index}>
                    <summary>Agent thought</summary>
                    {part.text}
                  </details>
                );
              if (part.type === "dynamic-tool")
                return (
                  <p key={index} data-tool={part.toolCallId}>
                    {part.toolName}: {part.state}
                  </p>
                );
              if (part.type === "data-acp-plan")
                return (
                  <pre key={index} data-plan>
                    {JSON.stringify(part.data, null, 2)}
                  </pre>
                );
              return null;
            })}
          </article>
        ))}
      </div>
      {error && <p role="alert">{error.message}</p>}
      <form
        onSubmit={(event) => {
          event.preventDefault();
          if (input.trim() && !busy) {
            void sendMessage({ text: input });
            setInput("");
          }
        }}
      >
        <label htmlFor="chat-input">Message</label>
        <input
          id="chat-input"
          value={input}
          onChange={(event) => setInput(event.target.value)}
          disabled={busy}
        />
        <button id="chat-send" disabled={busy || !input.trim()}>
          Send
        </button>
        <button
          id="chat-stop"
          type="button"
          disabled={!busy}
          onClick={() => void stop()}
        >
          Stop
        </button>
      </form>
    </section>
  );
}
// The mounting application disposes the transport/provider when leaving.
// Re-mounting must not automatically re-send the last message or regenerate it.
