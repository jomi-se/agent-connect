import {
  connectAgent,
  AgentSession,
  createAgentChat,
  createAcpPairing,
  captureAcpPairingCallback,
} from "@open-agent-connect/web/acp";
import definitions from "./tools.json";
import toolsUrl from "./tools.json?url";
import {
  getConversationRecoveryAction,
  getConversationRecoveryState,
} from "./recovery-policy.js";
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
let connectionGeneration = 0;
let recovering = false;
let recoveryAttemptedChat;
let recoveryNotice = "";
let recoveryErrorCode;
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

function recoveryAction(error) {
  return getConversationRecoveryAction({
    sessionId: provider?.sessionId,
    closeCode: provider?.transport.error?.closeCode,
    errorCode:
      error?.code ??
      recoveryErrorCode ??
      chat?.getSnapshot().error?.code ??
      provider?.transport.error?.code,
  });
}

function recoveryState() {
  const snapshot = chat.getSnapshot();
  return getConversationRecoveryState({
    ...snapshot,
    sessionId: provider?.sessionId,
    closeCode: provider?.transport.error?.closeCode,
    errorCode:
      recoveryErrorCode ??
      snapshot.error?.code ??
      provider?.transport.error?.code,
  });
}

function render() {
  const snapshot = chat.getSnapshot();
  const { action, canSend, needsNewSession } = recoveryState();
  element("chat-status").textContent = recovering
    ? "Recovering conversation"
    : snapshot.status;
  element("chat-input").disabled = !gatewayUrl || recovering || !canSend;
  element("chat-send").disabled = !gatewayUrl || recovering || !canSend;
  element("chat-stop").disabled = !gatewayUrl || !snapshot.canStop;
  element("chat-new").disabled =
    !gatewayUrl || connecting || recovering || !needsNewSession;
  element("chat-new").textContent =
    action === "recover" ? "Retry recovery" : "New connection";
  element("new-session-notice").hidden = !needsNewSession && !recoveryNotice;
  element("new-session-notice").textContent = recovering
    ? "Restoring the conversation. The interrupted message and application actions will not be repeated."
    : needsNewSession
      ? action === "recover"
        ? "Recovery is unavailable. Retry recovery to restore the conversation. Your previous message will not be repeated."
        : "This conversation ended. Start a new connection to send another message. Previous messages remain visible and will not be repeated."
      : recoveryNotice;
  element("error").textContent =
    connectionError || snapshot.error?.message || "";
  if (action === "approval") void clearAuthorization();
  element("chat-messages").replaceChildren(
    ...[
      ...previousMessages,
      ...(chat === archivedChat ? [] : snapshot.messages),
    ].map((message) => {
      const article = document.createElement("article");
      article.dataset.role = message.role;
      article.dataset.status = message.status;
      if (message.status === "failed" || message.status === "cancelled") {
        const status = document.createElement("p");
        status.textContent =
          message.error?.code === "task_interrupted"
            ? "Turn interrupted. Your message and any application actions were not repeated."
            : message.status === "cancelled"
              ? "Turn stopped."
              : `Turn failed: ${message.error?.message ?? "Unable to complete the message."}`;
        article.append(status);
      }
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
  if (
    snapshot.needsNewSession &&
    provider?.sessionId &&
    gatewayUrl &&
    !connecting &&
    !recovering &&
    !clearingAuthorization &&
    action === "recover" &&
    recoveryAttemptedChat !== chat
  ) {
    recoveryAttemptedChat = chat;
    queueMicrotask(() => void recoverConversation());
  }
}

async function recoverConversation() {
  if (
    recovering ||
    connecting ||
    clearingAuthorization ||
    recoveryAction() !== "recover"
  )
    return;
  const previous = chat;
  const currentProvider = provider;
  recovering = true;
  recoveryAttemptedChat = previous;
  connectionError = "";
  render();
  try {
    await currentProvider.recover();
    if (
      provider !== currentProvider ||
      chat !== previous ||
      clearingAuthorization
    )
      return;
    previousMessages.push(...previous.getSnapshot().messages);
    archivedChat = previous;
    await previous.dispose();
    // The loaded provider owns history. This new presenter sends only the next
    // deliberate user message, never the interrupted turn or application results.
    chat = createAgentChat({ session: new AgentSession({ provider, tools }) });
    chat.subscribe(render);
    recoveryErrorCode = undefined;
    recoveryNotice =
      "Conversation restored. Send a new message when you are ready; the previous turn was not repeated.";
    element("connection-status").textContent = "Connected";
  } catch (error) {
    recoveryErrorCode = error.code;
    const action = recoveryAction(error);
    if (action === "approval") {
      await clearAuthorization();
      return;
    }
    connectionError =
      error.code === "session_capacity"
        ? "Gateway session capacity is full. Wait for cleanup, then retry recovery."
        : action === "recover"
          ? `Could not restore the conversation: ${error.message}. Retry recovery when the gateway is available.`
          : `Could not restore the conversation: ${error.message}. Start a new connection to send another message.`;
  } finally {
    recovering = false;
    if (chat) render();
  }
}

async function clearAuthorization() {
  if (clearingAuthorization) return;
  clearingAuthorization = true;
  connectionGeneration++;
  connectionError =
    "Gateway approval ended or could not authorize this application. Connect again to request approval. Your previous messages will not be replayed.";
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
  const generation = ++connectionGeneration;
  clearingAuthorization = false;
  connectionError = "";
  recoveryNotice = "";
  recoveryErrorCode = undefined;
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
        if (generation !== connectionGeneration) return;
        element("connection-status").dataset.sessionId = id;
      },
      onRecovery({ interrupted }) {
        if (generation !== connectionGeneration) return;
        recoveryNotice = interrupted
          ? "Conversation restored after an interruption. The previous turn was not repeated."
          : "Conversation restored.";
      },
      transport: {
        onState(state, reason) {
          if (generation !== connectionGeneration) return;
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
          // An idle presenter has no in-flight request to observe this error.
          // Update its controls immediately when the transport ends.
          if (state.startsWith("ended:") && chat && chat !== archivedChat)
            render();
        },
      },
    });
    callbackUrl = undefined;
    const nextProvider = await pendingProvider;
    if (generation !== connectionGeneration) {
      nextProvider.close();
      return;
    }
    provider = nextProvider;
    clearingAuthorization = false;
    chat = createAgentChat({ session: new AgentSession({ provider, tools }) });
    chat.subscribe(render);
    if (!provider.sessionId)
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
      [
        "invalid_app_grant",
        "invalid_grant",
        "expired",
        "authorization_denied",
      ].includes(error.code)
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
  if (connecting || !gatewayUrl || !chat || !recoveryState().needsNewSession)
    return;
  element("chat-new").disabled = true;
  if (recoveryAction() === "recover") {
    await recoverConversation();
    return;
  }
  try {
    await startConnection();
  } catch (error) {
    connectionError =
      error.code === "session_capacity"
        ? "Gateway session capacity is full. Wait for box cleanup, then choose New connection again. If it persists, ask the gateway operator to inspect cleanup errors."
        : error.message;
    element("error").textContent = connectionError;
    element("chat-new").disabled = false;
  }
});
element("chat-form").addEventListener("submit", (event) => {
  event.preventDefault();
  const prompt = element("chat-input").value.trim();
  if (!prompt || !chat || !recoveryState().canSend) return;
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
