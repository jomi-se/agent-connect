// Browser side of the ACP gateway spike: an application that speaks ACP over
// WebSocket and serves its own tools as an MCP-over-ACP server, in the page.
import { client, RequestError } from "@agentclientprotocol/sdk";
import { createWebSocketStream } from "@agentclientprotocol/sdk/experimental/ws-client";
import tools from "./tools.json";

const query = new URLSearchParams(location.search);
const GATEWAY = query.get("gateway") ?? "ws://127.0.0.1:18940/acp";
const TOKEN = query.get("token") ?? "spike-dev-token";

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
  ask_reader({ question }) {
    $("ask-question").textContent = question;
    $("ask").classList.add("open");
    return new Promise((resolve) => {
      $("ask-answer").onclick = () => {
        $("ask").classList.remove("open");
        resolve($("ask-answer").textContent);
      };
    });
  },
};

// Minimal MCP server over MCP-over-ACP. Unknown methods get method-not-found,
// which lets modern MCP clients fall back from `server/discover`.
async function handleMcp({ method, params }) {
  switch (method) {
    case "initialize":
      return {
        protocolVersion: params?.protocolVersion ?? "2025-06-18",
        capabilities: { tools: {} },
        serverInfo: { name: "spike-reader", version: "0.0.0" },
      };
    case "ping":
      return {};
    case "tools/list":
      return { tools };
    case "tools/call": {
      const handler = toolHandlers[params?.name];
      if (!handler) throw RequestError.invalidParams({ tool: params?.name });
      log("tool", `${params.name} ${JSON.stringify(params.arguments ?? {})}`);
      const text = await handler(params.arguments ?? {});
      log("tool-result", text);
      return { content: [{ type: "text", text }], isError: false };
    }
    default:
      log("mcp-unknown", method);
      throw RequestError.methodNotFound(method);
  }
}

// ------------------------------------------------------------ session ---

let mcpConnections = 0;

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

function connectApp() {
  const stream = createWebSocketStream(GATEWAY, {
    protocols: ["acp.v1", `bearer.${TOKEN}`],
  });
  return { stream, app: readerApp() };
}

// Reconnect after a reload and continue a session this grant created earlier.
async function resume(
  prompt,
  sessionId = sessionStorage.getItem("spike-session"),
) {
  $("answer").textContent = "";
  setStatus("resuming");
  const { stream, app } = connectApp();
  try {
    return await app.connectWith(stream, async (ctx) => {
      await ctx.request("initialize", {
        protocolVersion: 1,
        clientCapabilities: {},
      });
      const loaded = await ctx.request("session/load", {
        sessionId,
        cwd: "/the-app-does-not-choose-this",
        mcpServers: [{ type: "acp", name: "app", serverId: "reader-tools" }],
      });
      log(
        "loaded",
        `${sessionId} replayed=${events.filter((e) => e.kind.startsWith("update:user_message")).length}`,
      );
      setStatus("prompting");
      const result = await ctx.request("session/prompt", {
        sessionId,
        prompt: [{ type: "text", text: prompt }],
      });
      setStatus(`done:${result.stopReason}`);
      return loaded;
    });
  } catch (error) {
    setStatus(`error:${error?.message ?? error}`);
    throw error;
  }
}

async function run(prompt) {
  $("answer").textContent = "";
  setStatus("connecting");
  const { stream, app } = connectApp();
  try {
    return await app.connectWith(stream, async (ctx) => {
      const init = await ctx.request("initialize", {
        protocolVersion: 1,
        clientCapabilities: {
          fs: { readTextFile: false, writeTextFile: false },
          terminal: false,
        },
      });
      log(
        "initialized",
        `${init.agentInfo?.name} acpMcp=${init.agentCapabilities?.mcpCapabilities?.acp} load=${init.agentCapabilities?.loadSession}`,
      );
      const session = await ctx
        .buildSession("/the-app-does-not-choose-this")
        .withMcpServer({ type: "acp", name: "app", serverId: "reader-tools" })
        .start();
      log("session", session.sessionId);
      sessionStorage.setItem("spike-session", session.sessionId);
      setStatus("prompting");
      const result = await session.prompt(prompt);
      setStatus(`done:${result.stopReason}`);
      return result;
    });
  } catch (error) {
    setStatus(`error:${error?.message ?? error}`);
    throw error;
  }
}

function readerApp() {
  return client({ name: "spike-reader" })
    .onRequest(
      "mcp/connect",
      (p) => p,
      () => ({ connectionId: `reader-mcp-${++mcpConnections}` }),
    )
    .onRequest(
      "mcp/message",
      (p) => p,
      (ctx) => handleMcp(ctx.params),
    )
    .onRequest(
      "mcp/disconnect",
      (p) => p,
      () => ({}),
    )
    .onNotification(
      "mcp/message",
      (p) => p,
      (ctx) => log("mcp-notification", ctx.params?.method),
    )
    .onRequest("session/request_permission", () => {
      log("permission", "unexpected: the gateway must answer prompts");
      return { outcome: { outcome: "cancelled" } };
    })
    .onNotification("session/update", (ctx) => onUpdate(ctx.params));
}

$("run-tools").onclick = () => run("SPIKE-TOOLS read and highlight");
$("run-ask").onclick = () => run("SPIKE-ASK please");
window.runShell = () => run("SPIKE-SHELL run something");
$("run-resume").onclick = () => resume("SPIKE-TOOLS again");
window.spike = { run, resume, events };
