import React, { useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { useChat } from "@ai-sdk/react";
import {
  connectAgent,
  createAcpChatTransport,
  createAcpPairing,
  captureAcpPairingCallback,
} from "@open-agent-connect/web";
import definitions from "./tools.json";
import toolsUrl from "./tools.json?url";
import { getConversationRecoveryAction } from "./recovery-policy.js";
import "./style.css";

const callbackUrl = captureAcpPairingCallback();
const redirectUri = location.origin + location.pathname;
let answerPending;
const tools = definitions.map((definition) => ({
  ...definition,
  async execute(args, context) {
    const book = document.getElementById("book");
    const counter = `${definition.name}Count`;
    book.dataset[counter] = String(Number(book.dataset[counter] ?? 0) + 1);
    let text;
    if (definition.name === "read_passage") {
      text =
        document.querySelector(`[data-chapter="${Number(args.chapter)}"]`)
          ?.textContent ?? "No chapter.";
    } else if (definition.name === "highlight") {
      const passage = document.querySelector('[data-chapter="1"]');
      const plain = passage.textContent;
      const index = plain.indexOf(args.text);
      if (!args.text || index < 0) text = `Not found: ${args.text}`;
      else {
        const mark = document.createElement("mark");
        mark.textContent = args.text;
        passage.replaceChildren(
          document.createTextNode(plain.slice(0, index)),
          mark,
          document.createTextNode(plain.slice(index + args.text.length)),
        );
        passage.dataset.highlights = String(
          Number(passage.dataset.highlights ?? 0) + 1,
        );
        text = `Highlighted: ${args.text}`;
      }
    } else {
      document.getElementById("ask-question").textContent = args.question;
      document.getElementById("ask-form").hidden = false;
      text = await new Promise((resolve) => {
        const finish = (value) => {
          context.signal?.removeEventListener("abort", abort);
          answerPending = undefined;
          document.getElementById("ask-form").hidden = true;
          resolve(value);
        };
        const abort = () => finish("Interrupted");
        answerPending = finish;
        if (context.signal?.aborted) abort();
        else context.signal?.addEventListener("abort", abort, { once: true });
      });
    }
    return { content: [{ type: "text", text }], isError: false };
  },
}));

document.getElementById("tool-snapshot").textContent = JSON.stringify(
  definitions,
  null,
  2,
);
document.getElementById("download-tools").href = toolsUrl;
document.getElementById("ask-form").addEventListener("submit", (event) => {
  event.preventDefault();
  answerPending?.(document.getElementById("ask-input").value);
});

function ChatPanel({
  connection,
  revision,
  archived,
  onArchive,
  onReconnect,
  onApprovalEnded,
  restored,
}) {
  const [transport] = useState(() =>
    createAcpChatTransport({ provider: connection, tools }),
  );
  const [input, setInput] = useState("");
  const [recovering, setRecovering] = useState(false);
  const [notice, setNotice] = useState(
    restored
      ? "Conversation restored. Previous messages and actions were not repeated."
      : "",
  );
  const [failure, setFailure] = useState();
  const [terminal, setTerminal] = useState(false);
  const [messageStates, setMessageStates] = useState({});
  const latest = useRef([]);
  const states = useRef({});
  const busyRef = useRef(false);
  const recoveryInFlight = useRef(false);
  const recoverRef = useRef();
  const { messages, sendMessage, stop, status, error } = useChat({
    id: `reader-${revision}`,
    transport,
    onFinish({ message, isAbort, isError }) {
      states.current = {
        ...states.current,
        [message.id]: isAbort ? "cancelled" : isError ? "failed" : "completed",
      };
      setMessageStates(states.current);
      if (isAbort) queueMicrotask(() => void recoverRef.current?.());
    },
    onError(cause) {
      setFailure(cause);
      queueMicrotask(() => void recoverRef.current?.(cause));
    },
  });
  latest.current = messages;
  const busy = status === "submitted" || status === "streaming";
  busyRef.current = busy;
  const action = getConversationRecoveryAction({
    sessionId: connection.sessionId,
    closeCode: connection.transport.error?.closeCode,
    errorCode:
      transport.error?.code ??
      failure?.code ??
      error?.code ??
      connection.transport.error?.code,
  });
  async function recover(cause) {
    if (recoveryInFlight.current) return;
    const nextAction = getConversationRecoveryAction({
      sessionId: connection.sessionId,
      closeCode: connection.transport.error?.closeCode,
      errorCode:
        transport.error?.code ??
        cause?.code ??
        connection.transport.error?.code,
    });
    if (nextAction === "approval") {
      await onApprovalEnded();
      return;
    }
    if (nextAction !== "recover") {
      setTerminal(true);
      return;
    }
    recoveryInFlight.current = true;
    setRecovering(true);
    setNotice(
      "Restoring the conversation. Previous messages and actions will not be repeated.",
    );
    try {
      // Finish cancellation and release the UI iterator before loading history.
      await transport.close();
      await connection.recover();
      onArchive(latest.current, {
        ...states.current,
        ...(cause && latest.current.at(-1)
          ? { [latest.current.at(-1).id]: "failed" }
          : {}),
      });
      onReconnect(connection);
    } catch (cause) {
      setFailure(cause);
      setTerminal(true);
      if (["invalid_app_grant", "authorization_denied"].includes(cause.code))
        await onApprovalEnded();
    } finally {
      recoveryInFlight.current = false;
      setRecovering(false);
    }
  }
  recoverRef.current = recover;
  useEffect(() => {
    const ended = () => {
      const reason = connection.transport.stats().ended;
      const state = reason ? `ended:${reason}` : "attached";
      if (state === "ended:unauthorized" || state === "ended:grant-revoked")
        void onApprovalEnded();
      else if (state?.startsWith("ended:")) {
        setTerminal(true);
        if (!busyRef.current)
          void recoverRef.current?.(connection.transport.error);
      }
    };
    window.addEventListener("reader-connection-state", ended);
    const pagehide = (event) => {
      if (!event.persisted) {
        void transport.close();
        connection.close();
      }
    };
    window.addEventListener("pagehide", pagehide);
    return () => {
      window.removeEventListener("reader-connection-state", ended);
      window.removeEventListener("pagehide", pagehide);
      void transport.close();
    };
  }, [connection, transport]);
  const allMessages = [
    ...archived,
    ...messages.map((message) => ({
      ...message,
      displayStatus:
        messageStates[message.id] ??
        (message.role === "assistant"
          ? error
            ? "failed"
            : busy
              ? "running"
              : "completed"
          : "completed"),
    })),
  ];
  return (
    <section aria-label="Agent chat">
      <p id="chat-status" role="status">
        {recovering ? "Recovering conversation" : busy ? "running" : "idle"}
      </p>
      <div id="chat-messages" aria-live="polite">
        {allMessages.map((message) => (
          <article
            key={message.id}
            data-role={message.role}
            data-status={message.displayStatus}
          >
            {message.displayStatus === "failed" && (
              <p>
                Turn interrupted. Your message and application actions were not
                repeated.
              </p>
            )}
            {message.displayStatus === "cancelled" && <p>Turn stopped.</p>}
            {message.parts.map((part, index) =>
              part.type === "text" || part.type === "reasoning" ? (
                <p key={index}>{part.text}</p>
              ) : part.type === "dynamic-tool" ? (
                <p key={index}>
                  {part.toolName}: {part.state}
                </p>
              ) : part.type === "data-acp-plan" ? (
                <pre key={index}>{JSON.stringify(part.data)}</pre>
              ) : null,
            )}
          </article>
        ))}
      </div>
      <p id="error" role="alert">
        {failure?.message ?? error?.message ?? ""}
      </p>
      <p id="new-session-notice" role="status" hidden={!notice && !terminal}>
        {notice ||
          "This conversation ended. Start a new connection; previous messages will not be repeated."}
      </p>
      <form
        id="chat-form"
        onSubmit={(event) => {
          event.preventDefault();
          if (!busy && !terminal && input.trim()) {
            void sendMessage({ text: input });
            setInput("");
          }
        }}
      >
        <label>
          Message{" "}
          <input
            id="chat-input"
            value={input}
            onChange={(event) => setInput(event.target.value)}
            required
            disabled={busy || recovering || terminal}
          />
        </label>
        <button id="chat-send" disabled={busy || recovering || terminal}>
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
        <button
          id="chat-new"
          type="button"
          disabled={!terminal || busy || recovering}
          onClick={() => {
            if (action === "recover") void recover();
            else {
              onArchive(latest.current, states.current);
              onReconnect();
            }
          }}
        >
          {action === "recover" ? "Retry recovery" : "New connection"}
        </button>
      </form>
    </section>
  );
}

let currentProvider;
let pairing;
let revision = 0;
let archived = [];
let connecting = false;
let ended = false;
let currentCallback = callbackUrl;
const root = createRoot(document.getElementById("chat-root"));
function archive(messages, states) {
  archived.push(
    ...messages.map((message) => ({
      ...message,
      displayStatus: states[message.id] ?? "completed",
    })),
  );
}
function renderChat(connection, restored = false) {
  currentProvider = connection;
  document.getElementById("connection-status").textContent = "Connected";
  if (connection.sessionId)
    document.getElementById("connection-status").dataset.sessionId =
      connection.sessionId;
  else delete document.getElementById("connection-status").dataset.sessionId;
  root.render(
    <ChatPanel
      key={++revision}
      revision={revision}
      connection={connection}
      archived={archived}
      restored={restored}
      onArchive={archive}
      onReconnect={(recovered) =>
        recovered ? renderChat(recovered, true) : void startConnection()
      }
      onApprovalEnded={clearAuthorization}
    />,
  );
}
async function clearAuthorization() {
  if (ended) return;
  ended = true;
  await pairing?.clear();
  sessionStorage.removeItem("reader-chat-gateway");
  currentProvider?.close();
  document.getElementById("connection-status").textContent = "Approval ended";
  document.getElementById("connect").disabled = false;
  document.getElementById("gateway-url").disabled = false;
  root.render(
    <section>
      <p id="error" data-code="invalid_app_grant" role="alert">
        Gateway approval ended. Connect again; previous messages will not be
        replayed.
      </p>
      <div id="chat-messages" />
      <input id="chat-input" disabled />
      <button id="chat-send" disabled>
        Send
      </button>
      <button id="chat-stop" disabled>
        Stop
      </button>
      <button id="chat-new" disabled>
        New connection
      </button>
    </section>,
  );
}
async function startConnection(mode = "resume") {
  if (connecting) return;
  connecting = true;
  ended = false;
  try {
    currentProvider?.close();
    const url = new URL(document.getElementById("gateway-url").value);
    if (
      !["http:", "https:"].includes(url.protocol) ||
      url.username ||
      url.password ||
      url.search ||
      url.hash ||
      url.pathname !== "/"
    )
      throw new Error(
        "Use your gateway's HTTP or HTTPS origin without a path, credentials or query parameters.",
      );
    sessionStorage.setItem("reader-chat-gateway", url.origin);
    pairing?.dispose();
    pairing = createAcpPairing({
      gatewayUrl: url.origin,
      tools: definitions,
      redirectUri,
      clientName: "Reader chat",
    });
    const connection = await connectAgent({
      gatewayUrl: url.origin,
      tools: definitions,
      pairing: {
        mode,
        redirectUri,
        callbackUrl: currentCallback,
        clientName: "Reader chat",
      },
      onSession(id) {
        document.getElementById("connection-status").dataset.sessionId = id;
      },
      transport: {
        onState(state) {
          window.dispatchEvent(new CustomEvent("reader-connection-state"));
          document.getElementById("connection-status").textContent = state;
          if (state === "ended:unauthorized" || state === "ended:grant-revoked")
            void clearAuthorization();
        },
      },
    });
    currentCallback = undefined;
    document.getElementById("connect").disabled = true;
    document.getElementById("gateway-url").disabled = true;
    renderChat(connection);
  } catch (cause) {
    if (cause.code === "pairing_redirected") return;
    if (
      [
        "invalid_app_grant",
        "authorization_denied",
        "invalid_grant",
        "expired",
      ].includes(cause.code)
    ) {
      await clearAuthorization();
      return;
    }
    if (cause.code === "pairing_required" && mode === "resume") {
      document.getElementById("connect").disabled = false;
      return;
    }
    document.getElementById("error").textContent = cause.message;
    document.getElementById("error").dataset.code =
      cause.code ?? "connection_failed";
    document.getElementById("connect").disabled = false;
  } finally {
    connecting = false;
  }
}
document.getElementById("connect-form").addEventListener("submit", (event) => {
  event.preventDefault();
  document.getElementById("connect").disabled = true;
  void startConnection(
    matchMedia("(pointer: coarse)").matches ? "redirect" : "popup",
  );
});
const stored = sessionStorage.getItem("reader-chat-gateway");
if (stored) document.getElementById("gateway-url").value = stored;
if (callbackUrl && window.opener) window.close();
else if (stored || callbackUrl) void startConnection();
