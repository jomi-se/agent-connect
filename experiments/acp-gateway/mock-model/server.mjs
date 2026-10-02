// Scripted model provider for the ACP gateway spike.
//
// Serves just enough of the OpenAI Responses API (for Codex) and the Anthropic
// Messages API (for Claude Code) to drive a deterministic application-tool
// turn through the real harnesses. Every request body is appended to a JSONL
// log so the spike can show exactly which tool names and schemas each harness
// presented to the model.
//
// Script, keyed on the latest user text:
//   contains "SPIKE-TOOLS": call read_passage -> call highlight -> final text
//   contains "SPIKE-ASK":   call ask_reader  -> final text
//   contains "SPIKE-SLOW":  stream 30 numbered chunks, one every 300 ms
//   contains "SPIKE-LATEASK": wait 6 s, call ask_reader -> final text
//   anything else:          plain text reply
import { createServer } from "node:http";
import { appendFileSync } from "node:fs";

const port = Number(process.env.MOCK_PORT ?? 18931);
const host = process.env.MOCK_HOST ?? "127.0.0.1";
const logPath = process.env.MOCK_LOG ?? "mock-requests.jsonl";

let counter = 0;
const nextId = (prefix) => `${prefix}_${Date.now().toString(36)}_${++counter}`;

function log(entry) {
  appendFileSync(
    logPath,
    JSON.stringify({ at: new Date().toISOString(), ...entry }) + "\n",
  );
}

// ---------------------------------------------------------------- script ---

// Each harness names MCP tools differently (and may nest them in namespaces),
// so match on the application tool's base name.
function findTool(tools, baseName) {
  const stack = [...(tools ?? [])];
  while (stack.length > 0) {
    const tool = stack.shift();
    if (Array.isArray(tool?.tools)) {
      for (const inner of tool.tools)
        stack.push({ ...inner, namespace: tool.name });
    }
    const name = tool?.name ?? tool?.function?.name;
    if (
      typeof name === "string" &&
      (name === baseName ||
        name.endsWith(`__${baseName}`) ||
        name.endsWith(`_${baseName}`))
    ) {
      return { name, namespace: tool.namespace };
    }
  }
  return undefined;
}

// history: [{ kind: "call", id, name } | { kind: "result", id, text } | { kind: "user", text }]
function decide({ tools, history }) {
  const turnStart = history.findLastIndex((h) => h.kind === "user");
  const lastUser = history[turnStart]?.text ?? "";
  const results = new Map();
  const callNames = new Map();
  // Earlier turns must not satisfy this turn's scripted application tool calls.
  for (const h of history.slice(turnStart + 1)) {
    if (h.kind === "call") callNames.set(h.id, h.name);
    if (h.kind === "result") results.set(callNames.get(h.id) ?? h.id, h.text);
  }
  const resultFor = (base) => {
    for (const [name, text] of results)
      if (name === base || name.endsWith(base)) return text;
    return undefined;
  };

  if (lastUser.includes("SPIKE-PROGRESS")) {
    const codexPlan = findTool(tools, "update_plan");
    const claudePlan = findTool(tools, "TodoWrite");
    const plan = codexPlan ?? claudePlan;
    const thought = "Deterministic thought: inspect the passage.";
    if (!plan)
      return { thought, text: "PROGRESS-DONE (native plan tool unavailable)" };
    if (resultFor(plan.name) === undefined)
      return {
        thought,
        call: {
          ...plan,
          args: codexPlan
            ? { plan: [{ step: "Read the passage", status: "completed" }] }
            : {
                todos: [
                  {
                    content: "Read the passage",
                    status: "completed",
                    activeForm: "Reading the passage",
                  },
                ],
              },
        },
      };
    return { thought, text: "PROGRESS-DONE" };
  }
  if (lastUser.includes("SPIKE-TOOLS")) {
    const read = findTool(tools, "read_passage");
    const highlight = findTool(tools, "highlight");
    if (!read || !highlight)
      return { text: `MISSING-TOOLS read=${!!read} highlight=${!!highlight}` };
    const passage = resultFor("read_passage");
    if (passage === undefined)
      return { call: { ...read, args: { chapter: 1 } } };
    const highlighted = resultFor("highlight");
    if (highlighted === undefined) {
      return {
        call: {
          ...highlight,
          args: {
            text: (
              passage.match(/Chapter \d+:[^"\n\\]*/)?.[0] ?? passage
            ).slice(0, 40),
          },
        },
      };
    }
    return {
      text: `DONE read=${JSON.stringify(passage.slice(0, 60))} highlight=${JSON.stringify(highlighted)}`,
    };
  }
  if (lastUser.includes("SPIKE-SHELL")) {
    // A harness-native action: Codex exec_command or Claude Code Bash.
    const codexShell = findTool(tools, "exec_command");
    const claudeShell = findTool(tools, "Bash");
    const shell = codexShell ?? claudeShell;
    if (!shell) return { text: "MISSING-TOOLS shell" };
    const output = resultFor(shell.name);
    if (output === undefined) {
      const args = codexShell
        ? { cmd: "echo native-$((6*7)) && pwd" }
        : {
            command: "echo native-$((6*7)) && pwd",
            description: "Spike native action",
          };
      return { call: { ...shell, args } };
    }
    return { text: `DONE shell=${JSON.stringify(output.slice(0, 160))}` };
  }
  if (lastUser.includes("SPIKE-SLOW")) {
    const chunks = Array.from(
      { length: 30 },
      (_, i) => `w${String(i + 1).padStart(2, "0")} `,
    );
    chunks.push("DONE-SLOW");
    return { text: chunks.join(""), chunks, chunkDelayMs: 300 };
  }
  if (lastUser.includes("SPIKE-LATEASK")) {
    const ask = findTool(tools, "ask_reader");
    if (!ask) return { text: "MISSING-TOOLS ask_reader" };
    const answer = resultFor("ask_reader");
    if (answer === undefined)
      return {
        delayMs: 6000,
        call: { ...ask, args: { question: "Which chapter should we study?" } },
      };
    return { text: `DONE answer=${JSON.stringify(answer)}` };
  }
  if (lastUser.includes("SPIKE-ASK")) {
    const ask = findTool(tools, "ask_reader");
    if (!ask) return { text: "MISSING-TOOLS ask_reader" };
    const answer = resultFor("ask_reader");
    if (answer === undefined)
      return {
        call: { ...ask, args: { question: "Which chapter should we study?" } },
      };
    return { text: `DONE answer=${JSON.stringify(answer)}` };
  }
  return { text: "mock reply" };
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const textOf = (content) =>
  typeof content === "string"
    ? content
    : Array.isArray(content)
      ? content
          .map((c) =>
            typeof c === "string" ? c : (c?.text ?? c?.content ?? ""),
          )
          .map((c) => (typeof c === "string" ? c : textOf(c)))
          .join("")
      : "";

// ------------------------------------------------------ OpenAI Responses ---

function responsesHistory(body) {
  const history = [];
  const input =
    typeof body.input === "string"
      ? [{ role: "user", content: body.input }]
      : (body.input ?? []);
  for (const item of input) {
    if (item.type === "function_call")
      history.push({ kind: "call", id: item.call_id, name: item.name });
    else if (item.type === "function_call_output")
      history.push({
        kind: "result",
        id: item.call_id,
        text: textOf(item.output),
      });
    else if (item.role === "user")
      history.push({ kind: "user", text: textOf(item.content) });
  }
  return history;
}

async function handleResponses(body, res) {
  const decision = decide({
    tools: body.tools,
    history: responsesHistory(body),
  });
  if (decision.delayMs) await sleep(decision.delayMs);
  const responseId = nextId("resp");
  const send = (event) =>
    res.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
  res.writeHead(200, {
    "content-type": "text/event-stream",
    "cache-control": "no-cache",
  });
  const base = {
    id: responseId,
    object: "response",
    created_at: Math.floor(Date.now() / 1000),
    model: body.model,
    status: "in_progress",
    output: [],
  };
  send({ type: "response.created", response: base });

  let thoughtItem;
  const outputIndex = decision.thought ? 1 : 0;
  if (decision.thought) {
    thoughtItem = {
      type: "reasoning",
      id: nextId("reasoning"),
      summary: [{ type: "summary_text", text: decision.thought }],
    };
    send({
      type: "response.output_item.added",
      output_index: 0,
      item: { ...thoughtItem, summary: [] },
    });
    send({
      type: "response.reasoning_summary_part.added",
      output_index: 0,
      item_id: thoughtItem.id,
      summary_index: 0,
      part: { type: "summary_text", text: "" },
    });
    send({
      type: "response.reasoning_summary_text.delta",
      output_index: 0,
      item_id: thoughtItem.id,
      summary_index: 0,
      delta: decision.thought,
    });
    send({
      type: "response.reasoning_summary_text.done",
      output_index: 0,
      item_id: thoughtItem.id,
      summary_index: 0,
      text: decision.thought,
    });
    send({
      type: "response.reasoning_summary_part.done",
      output_index: 0,
      item_id: thoughtItem.id,
      summary_index: 0,
      part: thoughtItem.summary[0],
    });
    send({
      type: "response.output_item.done",
      output_index: 0,
      item: thoughtItem,
    });
  }
  let item;
  if (decision.call) {
    item = {
      type: "function_call",
      id: nextId("fc"),
      call_id: nextId("call"),
      name: decision.call.name,
      ...(decision.call.namespace
        ? { namespace: decision.call.namespace }
        : {}),
      arguments: JSON.stringify(decision.call.args),
      status: "completed",
    };
    send({
      type: "response.output_item.added",
      output_index: outputIndex,
      item: { ...item, arguments: "" },
    });
    send({
      type: "response.function_call_arguments.delta",
      output_index: outputIndex,
      item_id: item.id,
      delta: item.arguments,
    });
    send({
      type: "response.function_call_arguments.done",
      output_index: outputIndex,
      item_id: item.id,
      arguments: item.arguments,
    });
  } else {
    item = {
      type: "message",
      id: nextId("msg"),
      role: "assistant",
      status: "completed",
      content: [{ type: "output_text", text: decision.text, annotations: [] }],
    };
    send({
      type: "response.output_item.added",
      output_index: outputIndex,
      item: { ...item, content: [] },
    });
    send({
      type: "response.content_part.added",
      output_index: outputIndex,
      item_id: item.id,
      content_index: 0,
      part: { type: "output_text", text: "", annotations: [] },
    });
    for (const [i, delta] of (decision.chunks ?? [decision.text]).entries()) {
      if (i > 0 && decision.chunkDelayMs) await sleep(decision.chunkDelayMs);
      send({
        type: "response.output_text.delta",
        output_index: outputIndex,
        item_id: item.id,
        content_index: 0,
        delta,
      });
    }
    send({
      type: "response.output_text.done",
      output_index: outputIndex,
      item_id: item.id,
      content_index: 0,
      text: decision.text,
    });
    send({
      type: "response.content_part.done",
      output_index: outputIndex,
      item_id: item.id,
      content_index: 0,
      part: item.content[0],
    });
  }
  send({ type: "response.output_item.done", output_index: outputIndex, item });
  send({
    type: "response.completed",
    response: {
      ...base,
      status: "completed",
      output: thoughtItem ? [thoughtItem, item] : [item],
      usage: {
        input_tokens: 10,
        output_tokens: 5,
        total_tokens: 15,
        input_tokens_details: { cached_tokens: 0 },
        output_tokens_details: { reasoning_tokens: 0 },
      },
    },
  });
  res.end();
  return decision;
}

// ---------------------------------------------------- Anthropic Messages ---

function messagesHistory(body) {
  const history = [];
  for (const message of body.messages ?? []) {
    const blocks =
      typeof message.content === "string"
        ? [{ type: "text", text: message.content }]
        : (message.content ?? []);
    for (const block of blocks) {
      if (block.type === "tool_use")
        history.push({ kind: "call", id: block.id, name: block.name });
      else if (block.type === "tool_result")
        history.push({
          kind: "result",
          id: block.tool_use_id,
          text: textOf(block.content),
        });
      else if (block.type === "text" && message.role === "user")
        history.push({ kind: "user", text: block.text });
    }
  }
  return history;
}

async function handleMessages(body, res) {
  const decision = decide({
    tools: body.tools,
    history: messagesHistory(body),
  });
  if (decision.delayMs) await sleep(decision.delayMs);
  const messageId = nextId("msg");
  const usage = {
    input_tokens: 10,
    output_tokens: 5,
    cache_creation_input_tokens: 0,
    cache_read_input_tokens: 0,
  };
  if (!body.stream) {
    const content = decision.call
      ? [
          {
            type: "tool_use",
            id: nextId("toolu"),
            name: decision.call.name,
            input: decision.call.args,
          },
        ]
      : [{ type: "text", text: decision.text }];
    res.writeHead(200, { "content-type": "application/json" });
    res.end(
      JSON.stringify({
        id: messageId,
        type: "message",
        role: "assistant",
        model: body.model,
        content,
        stop_reason: decision.call ? "tool_use" : "end_turn",
        stop_sequence: null,
        usage,
      }),
    );
    return decision;
  }
  const send = (event) =>
    res.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
  res.writeHead(200, {
    "content-type": "text/event-stream",
    "cache-control": "no-cache",
  });
  send({
    type: "message_start",
    message: {
      id: messageId,
      type: "message",
      role: "assistant",
      model: body.model,
      content: [],
      stop_reason: null,
      stop_sequence: null,
      usage,
    },
  });
  const blockIndex = decision.thought ? 1 : 0;
  if (decision.thought) {
    send({
      type: "content_block_start",
      index: 0,
      content_block: { type: "thinking", thinking: "", signature: "" },
    });
    send({
      type: "content_block_delta",
      index: 0,
      delta: { type: "thinking_delta", thinking: decision.thought },
    });
    send({
      type: "content_block_delta",
      index: 0,
      delta: { type: "signature_delta", signature: "deterministic-fixture" },
    });
    send({ type: "content_block_stop", index: 0 });
  }
  if (decision.call) {
    const block = {
      type: "tool_use",
      id: nextId("toolu"),
      name: decision.call.name,
      input: {},
    };
    send({
      type: "content_block_start",
      index: blockIndex,
      content_block: block,
    });
    send({
      type: "content_block_delta",
      index: blockIndex,
      delta: {
        type: "input_json_delta",
        partial_json: JSON.stringify(decision.call.args),
      },
    });
  } else {
    send({
      type: "content_block_start",
      index: blockIndex,
      content_block: { type: "text", text: "" },
    });
    for (const [i, text] of (decision.chunks ?? [decision.text]).entries()) {
      if (i > 0 && decision.chunkDelayMs) await sleep(decision.chunkDelayMs);
      send({
        type: "content_block_delta",
        index: blockIndex,
        delta: { type: "text_delta", text },
      });
    }
  }
  send({ type: "content_block_stop", index: blockIndex });
  send({
    type: "message_delta",
    delta: {
      stop_reason: decision.call ? "tool_use" : "end_turn",
      stop_sequence: null,
    },
    usage: { output_tokens: 5 },
  });
  send({ type: "message_stop" });
  res.end();
  return decision;
}

// ----------------------------------------------------------------- server ---

createServer((req, res) => {
  let raw = "";
  req.on("data", (chunk) => (raw += chunk));
  req.on("end", async () => {
    const url = new URL(req.url, "http://mock");
    let body = {};
    try {
      body = raw ? JSON.parse(raw) : {};
    } catch {
      body = { unparsed: raw.slice(0, 2000) };
    }
    const path = url.pathname;
    let decision;
    try {
      if (req.method === "POST" && path.endsWith("/responses"))
        decision = await handleResponses(body, res);
      else if (
        req.method === "POST" &&
        path.endsWith("/messages/count_tokens")
      ) {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ input_tokens: 10 }));
      } else if (req.method === "POST" && path.endsWith("/messages"))
        decision = await handleMessages(body, res);
      else if (req.method === "GET" && path.endsWith("/models")) {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(
          JSON.stringify({
            object: "list",
            data: [{ id: "mock-model", object: "model" }],
          }),
        );
      } else {
        res.writeHead(404, { "content-type": "application/json" });
        res.end(
          JSON.stringify({
            error: { message: `mock: unsupported ${req.method} ${path}` },
          }),
        );
      }
    } finally {
      log({
        method: req.method,
        path,
        headers: { "user-agent": req.headers["user-agent"] },
        body,
        decision,
      });
    }
  });
}).listen(port, host, () =>
  console.log(`mock model listening on http://${host}:${port}`),
);
