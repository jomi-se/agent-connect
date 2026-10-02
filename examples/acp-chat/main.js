import {
  connectAgent,
  AgentSession,
  createAgentChat,
} from "@open-agent-connect/web/acp";
import definitions from "./tools.json";
import toolsUrl from "./tools.json?url";
import "./style.css";

const element = (id) => document.getElementById(id);
let provider;
let chat;
let answerPending;
let approvedGrant;
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
  element("chat-input").disabled = !snapshot.canSend;
  element("chat-send").disabled = !snapshot.canSend;
  element("chat-stop").disabled = !snapshot.canStop;
  element("chat-new").disabled = connecting || !snapshot.needsNewSession;
  element("new-session-notice").hidden = !snapshot.needsNewSession;
  element("error").textContent = snapshot.error?.message ?? "";
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

async function startConnection(grant) {
  if (connecting) return;
  connecting = true;
  try {
    if (chat && chat !== archivedChat) {
      previousMessages.push(...chat.getSnapshot().messages);
      archivedChat = chat;
      await chat.dispose();
      provider.close();
      render();
    }
    const nextProvider = await connectAgent({
      grant,
      tools: definitions,
      onSession(id) {
        element("connection-status").dataset.sessionId = id;
      },
      transport: {
        onState(state) {
          element("connection-status").textContent = state;
        },
      },
    });
    provider = nextProvider;
    chat = createAgentChat({ session: new AgentSession({ provider, tools }) });
    chat.subscribe(render);
    approvedGrant = grant;
    delete element("connection-status").dataset.sessionId;
    element("connection-status").textContent = "Connected";
    render();
  } finally {
    connecting = false;
    if (chat) render();
  }
}

element("grant-file").addEventListener("change", async (event) => {
  try {
    const grant = JSON.parse(await event.target.files[0].text());
    if (typeof grant.gatewayUrl !== "string" || typeof grant.token !== "string")
      throw new Error("Expected gatewayUrl and token in the grant JSON.");
    element("gateway-url").value = grant.gatewayUrl;
    element("grant-token").value = grant.token;
    element("error").textContent = "";
  } catch (error) {
    element("error").textContent = error.message;
  }
});
element("connect-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  element("connect").disabled = true;
  try {
    const grant = {
      gatewayUrl: element("gateway-url").value,
      token: element("grant-token").value,
    };
    const url = new URL(grant.gatewayUrl);
    if (
      !["ws:", "wss:"].includes(url.protocol) ||
      url.username ||
      url.password ||
      url.search ||
      url.hash
    )
      throw new Error(
        "Use a ws:// or wss:// gateway URL without credentials or query parameters.",
      );
    await startConnection(grant);
    element("grant-token").value = "";
    for (const input of element("connect-form").querySelectorAll("input"))
      input.disabled = true;
  } catch (error) {
    element("error").textContent = error.message;
    element("connect").disabled = false;
  }
});
element("chat-new").addEventListener("click", async () => {
  if (connecting || !approvedGrant || !chat?.getSnapshot().needsNewSession)
    return;
  element("chat-new").disabled = true;
  try {
    await startConnection(approvedGrant);
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
