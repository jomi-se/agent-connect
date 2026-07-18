#!/usr/bin/env node

import { appendFileSync } from "node:fs";
import { basename } from "node:path";
import { Readable, Writable } from "node:stream";
import { spawn } from "node:child_process";

import { agent, methods, ndJsonStream } from "@agentclientprotocol/sdk";

const transcriptPath = process.env.AGENT_CONNECT_ACP_TRANSCRIPT;
const targetToolName =
  process.env.AGENT_CONNECT_DETERMINISTIC_TOOL_NAME ?? "get_test_nonce";
const targetToolArguments = parseTargetArguments(
  process.env.AGENT_CONNECT_DETERMINISTIC_TOOL_ARGUMENTS ?? "{}",
);
const scenarioMode = process.env.AGENT_CONNECT_DETERMINISTIC_SCENARIOS === "1";
const sessions = new Map();

const scenarioPlans = {
  "project-board": [
    {
      name: "create_project_tasks",
      arguments: {
        tasks: [
          {
            id: "analytics",
            title: "Add launch analytics and alerts",
            priority: "high",
            status: "backlog",
          },
          {
            id: "support",
            title: "Prepare the launch support playbook",
            priority: "medium",
            status: "backlog",
          },
        ],
      },
    },
    {
      name: "update_project_tasks",
      arguments: {
        changes: [
          {
            id: "pricing",
            title: "Confirm launch pricing and upgrade path",
            priority: "high",
          },
          {
            id: "docs",
            title: "Publish setup and migration docs",
            priority: "high",
          },
        ],
      },
    },
    {
      name: "move_project_tasks",
      arguments: {
        moves: [
          { id: "pricing", status: "doing" },
          { id: "docs", status: "doing" },
          { id: "checkout", status: "done" },
        ],
      },
    },
  ],
  "document-review": [
    {
      name: "add_document_comments",
      arguments: {
        comments: [
          {
            quote:
              "Our new workspace makes every team exactly twice as productive.",
            kind: "fact",
            comment:
              "Unsupported causal claim. Replace it with a concrete product benefit.",
          },
          {
            quote: "The first graphical web browser was released in 1989.",
            kind: "fact",
            comment:
              "This compresses a disputed history into a precise but unreliable date.",
          },
          {
            quote:
              "Basically, we really think this is perhaps the best way for everyone to work better.",
            kind: "clarity",
            comment:
              "Hedged and universal. State the intended outcome without claiming it fits everyone.",
          },
        ],
      },
    },
    {
      name: "replace_document_text",
      arguments: {
        replacements: [
          {
            quote:
              "Our new workspace makes every team exactly twice as productive.",
            replacement:
              "Our new workspace keeps tasks, decisions, and notes in one shared view.",
          },
          {
            quote: "The first graphical web browser was released in 1989.",
            replacement:
              "Graphical browsers brought the web to a wider audience in the early 1990s.",
          },
          {
            quote:
              "Basically, we really think this is perhaps the best way for everyone to work better.",
            replacement:
              "We designed it to reduce coordination work without dictating how every team operates.",
          },
        ],
      },
    },
    {
      name: "format_document_blocks",
      arguments: {
        blocks: [
          { blockId: "intro", format: "callout" },
          { blockId: "history", format: "paragraph" },
          { blockId: "close", format: "paragraph" },
        ],
      },
    },
  ],
  "product-research": [
    {
      name: "add_product_assessment",
      arguments: {
        kidFit: "poor",
        verdict:
          "These are adult headphones, not a strong choice for an eight-year-old.",
        concerns: [
          "No child-specific volume limit is listed.",
          "The adult headband may fit poorly on a smaller head.",
          "Noise cancellation can reduce awareness outdoors.",
        ],
      },
    },
    {
      name: "add_price_comparison",
      arguments: {
        listedPrice: 129,
        fairLow: 85,
        fairHigh: 110,
        verdict:
          "The listed price is above this recorded comparison range. This demo does not fetch live prices.",
      },
    },
    {
      name: "add_product_alternatives",
      arguments: {
        alternatives: [
          {
            name: "JBL Junior 320BT",
            price: 50,
            reason: "Designed for children with an 85 dB volume limit.",
            url: "https://www.jbl.com/kids-headphones/",
          },
          {
            name: "PuroQuiet",
            price: 99,
            reason:
              "Child-sized fit, volume limiting, and active noise cancellation.",
            url: "https://purosound.com/",
          },
        ],
      },
    },
  ],
};

function parseTargetArguments(value) {
  const parsed = JSON.parse(value);
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new TypeError(
      "AGENT_CONNECT_DETERMINISTIC_TOOL_ARGUMENTS must be a JSON object",
    );
  }
  return parsed;
}

function record(event) {
  if (!transcriptPath) return;
  appendFileSync(
    transcriptPath,
    `${JSON.stringify({ at: new Date().toISOString(), ...event })}\n`,
    { mode: 0o600 },
  );
}

class McpStdioClient {
  constructor(spec) {
    const extraEnv = Object.fromEntries(
      (spec.env ?? []).map(({ name, value }) => [name, value]),
    );
    this.child = spawn(spec.command, spec.args ?? [], {
      env: { ...process.env, ...extraEnv },
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.nextId = 1;
    this.pending = new Map();
    this.buffer = "";
    this.child.stdout.setEncoding("utf8");
    this.child.stdout.on("data", (chunk) => this.onData(chunk));
    this.child.stderr.setEncoding("utf8");
    this.child.stderr.on("data", (chunk) => {
      record({ kind: "mcp.stderr", text: String(chunk).slice(0, 500) });
    });
    this.child.on("exit", (code, signal) => {
      const error = new Error(
        `MCP server exited before response (code=${code}, signal=${signal})`,
      );
      for (const { reject } of this.pending.values()) reject(error);
      this.pending.clear();
    });
    record({
      kind: "mcp.spawn",
      name: spec.name,
      command: basename(spec.command),
      envNames: (spec.env ?? []).map(({ name }) => name).sort(),
    });
  }

  async initialize() {
    const response = await this.request("initialize", {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: { name: "agent-connect-deterministic-agent", version: "1" },
    });
    this.notify("notifications/initialized", {});
    record({ kind: "mcp.initialize", response });
  }

  async request(method, params) {
    const id = this.nextId++;
    record({ kind: "mcp.request", method, params });
    const result = new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`MCP ${method} timed out`));
      }, 30_000);
      this.pending.set(id, {
        resolve: (value) => {
          clearTimeout(timeout);
          resolve(value);
        },
        reject: (error) => {
          clearTimeout(timeout);
          reject(error);
        },
      });
    });
    this.write({ jsonrpc: "2.0", id, method, params });
    return result;
  }

  notify(method, params) {
    this.write({ jsonrpc: "2.0", method, params });
  }

  async close() {
    if (this.child.exitCode !== null) return;
    this.child.kill("SIGTERM");
    await Promise.race([
      new Promise((resolve) => this.child.once("exit", resolve)),
      new Promise((resolve) =>
        setTimeout(() => {
          if (this.child.exitCode === null) this.child.kill("SIGKILL");
          resolve(undefined);
        }, 2_000),
      ),
    ]);
  }

  write(message) {
    this.child.stdin.write(`${JSON.stringify(message)}\n`);
  }

  onData(chunk) {
    this.buffer += chunk;
    while (true) {
      const newline = this.buffer.indexOf("\n");
      if (newline < 0) return;
      const line = this.buffer.slice(0, newline).trim();
      this.buffer = this.buffer.slice(newline + 1);
      if (!line) continue;
      let message;
      try {
        message = JSON.parse(line);
      } catch (error) {
        record({ kind: "mcp.invalid_json", line: line.slice(0, 500) });
        continue;
      }
      if (message.id === undefined) continue;
      const pending = this.pending.get(message.id);
      if (!pending) continue;
      this.pending.delete(message.id);
      if (message.error) {
        pending.reject(
          new Error(`MCP error: ${JSON.stringify(message.error)}`),
        );
      } else {
        record({
          kind: "mcp.response",
          id: message.id,
          result: message.result,
        });
        pending.resolve(message.result);
      }
    }
  }
}

const app = agent({ name: "Agent Connect deterministic ACP test agent" })
  .onRequest(methods.agent.initialize, ({ params }) => {
    record({ kind: "acp.request", method: "initialize", params });
    return {
      protocolVersion: params.protocolVersion,
      agentCapabilities: {},
      authMethods: [],
      agentInfo: { name: "agent-connect-deterministic", version: "1" },
    };
  })
  .onRequest(methods.agent.session.new, async ({ params }) => {
    record({
      kind: "acp.request",
      method: "session/new",
      cwd: params.cwd,
      mcpServers: params.mcpServers.map((server) => ({
        name: server.name,
        command: basename(server.command),
        envNames: (server.env ?? []).map(({ name }) => name).sort(),
      })),
    });
    const sessionId = `deterministic-${crypto.randomUUID()}`;
    const session = { mcpClients: [], advertisedTools: [] };
    for (const server of params.mcpServers) {
      const client = new McpStdioClient(server);
      session.mcpClients.push(client);
      await client.initialize();
      const listed = await client.request("tools/list", {});
      const tools = Array.isArray(listed?.tools) ? listed.tools : [];
      session.advertisedTools.push(...tools.map((tool) => ({ client, tool })));
      record({
        kind: "mcp.tools",
        names: tools.map((tool) => tool.name),
      });
    }
    sessions.set(sessionId, session);
    return { sessionId };
  })
  .onRequest(methods.agent.session.prompt, async ({ params, client }) => {
    record({
      kind: "acp.request",
      method: "session/prompt",
      sessionId: params.sessionId,
    });
    const session = sessions.get(params.sessionId);
    if (!session) throw new Error(`unknown ACP session ${params.sessionId}`);
    const plan = scenarioMode
      ? selectScenarioPlan(extractPromptText(params.prompt))
      : [{ name: targetToolName, arguments: targetToolArguments }];
    const results = [];
    for (const step of plan) {
      const selected = session.advertisedTools.find(
        ({ tool }) => tool.name === step.name,
      );
      if (!selected) {
        throw new Error(`request-scoped ${step.name} tool was not advertised`);
      }
      const result = await selected.client.request("tools/call", {
        name: step.name,
        arguments: step.arguments,
      });
      record({ kind: "agent.tool_result", toolName: step.name, result });
      results.push({ toolName: step.name, result });
    }
    const text = `recorded-codex-plan:${JSON.stringify(results)}`;
    await client.notify(methods.client.session.update, {
      sessionId: params.sessionId,
      update: {
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text },
      },
    });
    return { stopReason: "end_turn" };
  })
  .onNotification(methods.agent.session.cancel, async ({ params }) => {
    record({ kind: "acp.notification", method: "session/cancel" });
    const session = sessions.get(params.sessionId);
    sessions.delete(params.sessionId);
    await Promise.all(
      (session?.mcpClients ?? []).map((client) => client.close()),
    );
  });

const connection = app.connect(
  ndJsonStream(Writable.toWeb(process.stdout), Readable.toWeb(process.stdin)),
);
record({ kind: "agent.started" });
await connection.closed;
await Promise.all(
  [...sessions.values()].flatMap((session) =>
    session.mcpClients.map((client) => client.close()),
  ),
);
record({ kind: "agent.stopped" });

function extractPromptText(prompt) {
  if (!Array.isArray(prompt)) return "";
  return prompt
    .filter((block) => block?.type === "text" && typeof block.text === "string")
    .map((block) => block.text)
    .join("\n");
}

function selectScenarioPlan(prompt) {
  const match =
    /\[Agent Connect demo scenario: (project-board|document-review|product-research)\]/.exec(
      prompt,
    );
  if (!match) throw new Error("deterministic demo scenario marker is missing");
  return scenarioPlans[match[1]];
}
