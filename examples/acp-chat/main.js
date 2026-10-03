import {
  connectAgent,
  AgentSession,
  createAgentChat,
  createAcpPairing,
  captureAcpPairingCallback,
} from "@open-agent-connect/web/acp";
import definitions from "./tools.json";
import toolsUrl from "./tools.json?url";
import "./style.css";

const element = (id) => document.getElementById(id);
let provider;
let chat;
let answerPending;
let gatewayUrl;
let pairing;
let connectionError = "";
let clearingAuthorization = false;
let callbackUrl = captureAcpPairingCallback();
const redirectUri = window.location.origin + window.location.pathname;
const storedGateway = sessionStorage.getItem("reader-chat-gateway");
if (storedGateway) element("gateway-url").value = storedGateway;
let archivedChat;
let connecting = false;
const previousMessages = [];
element("tool-snapshot").textContent = JSON.stringify(definitions, null, 2);
element("download-tools").href = toolsUrl;

const handlers = {
  read_passage({ chapter }) {
    return (
      document.querySelector(`[data-chapter="${Number(chapter)}"]`)
        ?.textContent ?? `No chapter ${chapter}.`
    );
  },
  highlight({ text }) {
    const passage = document.querySelector('[data-chapter="1"]');
    const plain = passage.textContent;
    const index = plain.indexOf(text);
    if (!text || index < 0) return `Not found: ${text}`;
    const mark = document.createElement("mark");
    mark.textContent = text;
    passage.replaceChildren(
      document.createTextNode(plain.slice(0, index)),
      mark,
      document.createTextNode(plain.slice(index + text.length)),
    );
    passage.dataset.highlights = String(
      Number(passage.dataset.highlights ?? 0) + 1,
    );
    return `Highlighted: ${text}`;
  },
  ask_reader({ question }, context) {
    element("ask-question").textContent = question;
    element("ask-input").value = "";
    element("ask-form").hidden = false;
    return new Promise((resolve) => {
      const finish = (answer) => {
        context.signal?.removeEventListener("abort", abort);
        answerPending = undefined;
        element("ask-form").hidden = true;
        resolve(answer);
      };
      const abort = () => finish("Interrupted");
      answerPending = finish;
      if (context.signal?.aborted) abort();
      else context.signal?.addEventListener("abort", abort, { once: true });
    });
  },
};
const tools = definitions.map((definition) => ({
  ...definition,
  async execute(args, context) {
    const book = element("book");
    const counter = `${definition.name}Count`;
    book.dataset[counter] = String(Number(book.dataset[counter] ?? 0) + 1);
    const text = await handlers[definition.name](args, context);
    return { content: [{ type: "text", text }], isError: false };
  },
}));

function render() {
  const snapshot = chat.getSnapshot();
  element("chat-status").textContent = snapshot.status;
  element("chat-input").disabled = !gatewayUrl || !snapshot.canSend;
  element("chat-send").disabled = !gatewayUrl || !snapshot.canSend;
  element("chat-stop").disabled = !gatewayUrl || !snapshot.canStop;
  element("chat-new").disabled =
    !gatewayUrl || connecting || !snapshot.needsNewSession;
  element("new-session-notice").hidden = !snapshot.needsNewSession;
  element("error").textContent =
    connectionError || snapshot.error?.message || "";
  if (snapshot.error?.code === "invalid_app_grant") void clearAuthorization();
  element("chat-messages").replaceChildren(
    ...[
      ...previousMessages,
      ...(chat === archivedChat ? [] : snapshot.messages),
    ].map((message) => {
      const article = document.createElement("article");
      article.dataset.role = message.role;
      article.dataset.status = message.status;
      for (const part of message.parts) {
        const paragraph = document.createElement("p");
        if (part.type === "text" || part.type === "thought")
          paragraph.textContent = part.text;
        else if (part.type === "tool")
          paragraph.textContent = `${part.name}: ${part.status}`;
        else if (part.type === "progress")
          paragraph.textContent = `${part.update.title ?? "Agent action"}: ${part.update.status ?? "running"}`;
        else if (part.type === "plan")
          paragraph.textContent = part.entries
            .map((entry) => `${entry.content}: ${entry.status}`)
            .join("\n");
        article.append(paragraph);
      }
      return article;
    }),
  );
}

async function clearAuthorization() {
  if (clearingAuthorization) return;
  clearingAuthorization = true;
  connectionError =
    "Gateway approval was revoked or expired. Connect again to request approval. Your previous messages will not be replayed.";
  element("error").textContent = connectionError;
  element("error").dataset.code = "invalid_app_grant";
  await pairing?.clear();
  sessionStorage.removeItem("reader-chat-gateway");
  gatewayUrl = undefined;
  element("connect").disabled = false;
  element("gateway-url").disabled = false;
  element("connection-status").textContent = "Approval ended";
  if (chat && chat !== archivedChat) {
    previousMessages.push(...chat.getSnapshot().messages);
    archivedChat = chat;
    await chat.dispose();
  }
  provider?.close();
  element("chat-input").disabled = true;
  element("chat-send").disabled = true;
  element("chat-stop").disabled = true;
  element("chat-new").disabled = true;
}

async function startConnection(mode = "resume") {
  if (connecting) return;
  connecting = true;
  clearingAuthorization = false;
  connectionError = "";
  delete element("error").dataset.code;
  try {
    if (chat && chat !== archivedChat) {
      previousMessages.push(...chat.getSnapshot().messages);
      archivedChat = chat;
      await chat.dispose();
      provider.close();
      render();
    }
    const url = new URL(element("gateway-url").value);
    if (
      !["http:", "https:"].includes(url.protocol) ||
      url.username ||
      url.password ||
      url.search ||
      url.hash ||
      (url.pathname !== "/" && url.pathname !== "")
    )
      throw new Error(
        "Use your gateway's HTTP or HTTPS address without a path, credentials or query parameters.",
      );
    gatewayUrl = url.origin;
    sessionStorage.setItem("reader-chat-gateway", gatewayUrl);
    pairing?.dispose();
    pairing = createAcpPairing({
      gatewayUrl,
      tools: definitions,
      redirectUri,
      clientName: "Reader chat",
    });
    const pendingProvider = connectAgent({
      gatewayUrl,
      tools: definitions,
      pairing: { mode, redirectUri, callbackUrl, clientName: "Reader chat" },
      onSession(id) {
        element("connection-status").dataset.sessionId = id;
      },
      transport: {
        onState(state, reason) {
          if (
            state === "ended:unauthorized" ||
            state === "ended:grant-revoked" ||
            reason === "unauthorized" ||
            reason === "grant-revoked"
          ) {
            void clearAuthorization();
            return;
          }
          element("connection-status").textContent = state;
        },
      },
    });
    callbackUrl = undefined;
    const nextProvider = await pendingProvider;
    provider = nextProvider;
    clearingAuthorization = false;
    chat = createAgentChat({ session: new AgentSession({ provider, tools }) });
    chat.subscribe(render);
    delete element("connection-status").dataset.sessionId;
    element("connection-status").textContent = "Connected";
    element("connect").disabled = true;
    element("gateway-url").disabled = true;
    render();
  } catch (error) {
    if (error.code === "pairing_redirected") return;
    if (
      error.code === "pairing_required" &&
      mode === "resume" &&
      !callbackUrl
    ) {
      element("connection-status").textContent = "Disconnected";
      element("connect").disabled = false;
      return;
    }
    if (
      ["invalid_app_grant", "invalid_grant", "expired"].includes(error.code)
    ) {
      await clearAuthorization();
      return;
    }
    throw error;
  } finally {
    connecting = false;
    if (chat) render();
  }
}

function showConnectionError(error) {
  connectionError =
    error.code === "denied"
      ? "Gateway owner declined this application's request."
      : error.message;
  element("error").textContent = connectionError;
  element("error").dataset.code = error.code ?? "connection_failed";
  element("connect").disabled = false;
}
element("connect-form").addEventListener("submit", (event) => {
  event.preventDefault();
  element("connect").disabled = true;
  // A pointer-operated desktop uses a popup; touch devices return through a redirect.
  const mode = window.matchMedia("(pointer: coarse)").matches
    ? "redirect"
    : "popup";
  void startConnection(mode).catch(showConnectionError);
});
element("chat-new").addEventListener("click", async () => {
  if (connecting || !gatewayUrl || !chat?.getSnapshot().needsNewSession) return;
  element("chat-new").disabled = true;
  try {
    await startConnection();
  } catch (error) {
    element("error").textContent =
      error.code === "session_capacity"
        ? "Gateway session capacity is full. Wait for box cleanup, then choose New connection again. If it persists, ask the gateway operator to inspect cleanup errors."
        : error.message;
    element("chat-new").disabled = false;
  }
});
element("chat-form").addEventListener("submit", (event) => {
  event.preventDefault();
  const prompt = element("chat-input").value.trim();
  if (!prompt || !chat?.getSnapshot().canSend) return;
  element("chat-input").value = "";
  void chat.send(prompt).catch((error) => {
    element("error").textContent = error.message;
  });
});
element("chat-stop").addEventListener("click", () => {
  void chat?.stop().catch((error) => {
    element("error").textContent = error.message;
  });
});
element("ask-form").addEventListener("submit", (event) => {
  event.preventDefault();
  answerPending?.(element("ask-input").value);
});
window.addEventListener("pagehide", (event) => {
  if (event.persisted) return;
  void chat?.dispose();
  provider?.close();
});

if (callbackUrl && window.opener) {
  window.close();
} else if (storedGateway || callbackUrl) {
  element("connect").disabled = true;
  void startConnection().catch(showConnectionError);
}
