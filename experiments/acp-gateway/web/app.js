// Browser side of the ACP gateway spike: an application that speaks ACP over
// WebSocket and serves its own tools as an MCP-over-ACP server, in the page.
// Application code uses the product SDK; this page remains a browser fixture.
import { connectAgent, AgentSession } from "@open-agent-connect/web";
import tools from "./tools.json";

const query = new URLSearchParams(location.search);
const GATEWAY = query.get("gateway") ?? "ws://127.0.0.1:18940/acp";
const TOKEN = query.get("token") ?? "spike-dev-token";
// Resumable transport is on unless ?resume=0 (plain ACP over WebSocket).
const RESUMABLE = query.get("resume") !== "0";

const $ = (id) => document.getElementById(id);
const t0 = performance.now();
const events = [];
function log(kind, detail = "") {
  const entry = {
    ms: Math.round(performance.now() - t0),
    kind,
    detail: String(detail).slice(0, 160),
  };
  events.push(entry);
  $("events").textContent += `${entry.ms}ms ${kind} ${entry.detail}\n`;
}
const setStatus = (s) => {
  $("status").textContent = s;
  log("status", s);
};

// ---------------------------------------------------------- app tools ---

const toolCounts = {};

const toolHandlers = {
  read_passage({ chapter }) {
    const p = document.querySelector(`[data-chapter="${Number(chapter)}"] p`);
    return p ? p.textContent : `There is no chapter ${chapter}.`;
  },
  highlight({ text }) {
    for (const p of document.querySelectorAll("#book p")) {
      const index = p.textContent.indexOf(text);
      if (index < 0 || !text) continue;
      const node = p.firstChild;
      const mark = document.createElement("mark");
      const range = document.createRange();
      range.setStart(node, index);
      range.setEnd(node, index + text.length);
      range.surroundContents(mark);
      return `Highlighted: ${text}`;
    }
    return `Not found: ${text}`;
  },
  ask_reader({ question }, context) {
    $("ask-question").textContent = question;
    $("ask").classList.add("open");
    return new Promise((resolve) => {
      context?.signal?.addEventListener(
        "abort",
        () => {
          $("ask").classList.remove("open");
          resolve("Interrupted");
        },
        { once: true },
      );
      $("ask-answer").onclick = () => {
        $("ask").classList.remove("open");
        resolve($("ask-answer").textContent);
      };
    });
  },
};

const applicationTools = tools.map((tool) => ({
  ...tool,
  async execute(args, context) {
    log("tool", `${tool.name} ${JSON.stringify(args)}`);
    toolCounts[tool.name] = (toolCounts[tool.name] ?? 0) + 1;
    const text = await toolHandlers[tool.name](args, context);
    log("tool-result", text);
    return { content: [{ type: "text", text }], isError: false };
  },
}));

function onUpdate({ update }) {
  const kind = update.sessionUpdate;
  if (kind === "agent_message_chunk" && update.content?.type === "text")
    $("answer").textContent += update.content.text;
  const detail =
    kind === "tool_call" || kind === "tool_call_update"
      ? `${update.toolCallId} ${update.title ?? ""} ${update.status ?? ""}`
      : (update.content?.text ?? "");
  log(`update:${kind}`, detail);
}

let provider = null;
let activeSession = null;
async function connect(sessionId) {
  provider = await connectAgent({
    grant: { gatewayUrl: GATEWAY, token: TOKEN },
    tools,
    ...(sessionId ? { sessionId } : {}),
    transport: {
      resumable: RESUMABLE,
      onState: (state, why) => {
        $("conn").textContent = state;
        log("conn", why ? `${state} (${why})` : state);
      },
    },
    onSession: (id) => {
      sessionStorage.setItem("spike-session", id);
      log("session", id);
    },
    onUpdate,
    onRecovery: () =>
      log("recover", "session/load; interrupted turn not re-sent"),
  });
  return provider;
}
async function promptWith(connection, prompt) {
  const session = (activeSession = new AgentSession({
    provider: connection,
    tools: applicationTools,
  }));
  setStatus("prompting");
  for await (const event of session.streamTask(prompt)) {
    if (event.type === "task.failed") {
      if (event.error.code === "task_interrupted") {
        setStatus("recovered:interrupted");
        return;
      }
      throw new Error(event.error.message);
    }
    if (event.type === "task.completed") setStatus("done:end_turn");
    if (event.type === "task.cancelled") setStatus("done:cancelled");
  }
}
async function resume(
  prompt,
  sessionId = sessionStorage.getItem("spike-session"),
  finalStatus = null,
) {
  $("answer").textContent = "";
  setStatus("resuming");
  let connection;
  try {
    connection = await connect(sessionId);
    log("loaded", sessionId);
    if (prompt === null) {
      setStatus(finalStatus ?? "loaded");
      return;
    }
    await promptWith(connection, prompt);
  } catch (error) {
    setStatus(`error:${error?.message ?? error}`);
    throw error;
  } finally {
    connection?.close();
  }
}
async function run(prompt) {
  $("answer").textContent = "";
  setStatus("connecting");
  let connection;
  try {
    connection = await connect();
    await promptWith(connection, prompt);
  } catch (error) {
    setStatus(`error:${error?.message ?? error}`);
    throw error;
  } finally {
    connection?.close();
  }
}
$("run-tools").onclick = () => run("SPIKE-TOOLS read and highlight");
$("run-ask").onclick = () => run("SPIKE-ASK please");
window.runShell = () => run("SPIKE-SHELL run something");
$("run-resume").onclick = () => resume("SPIKE-TOOLS again");
window.spike = {
  run,
  resume,
  cancel: () => activeSession?.cancel(),
  events,
  toolCounts,
  answer: () => $("answer").textContent,
  transport: () => provider?.transport.stats(),
};

if (query.get("chat") === "1") {
  const connection = await connect();
  const { mountChat } = await import("./use-chat.jsx");
  mountChat(connection, applicationTools);
}
