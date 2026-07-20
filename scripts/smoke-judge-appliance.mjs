#!/usr/bin/env node

import { createHash, randomBytes } from "node:crypto";

const baseUrl =
  process.env.AGENT_CONNECT_SMOKE_BASE_URL ?? "http://127.0.0.1:10081";
const appOrigin =
  process.env.AGENT_CONNECT_SMOKE_APP_ORIGIN ??
  "https://agent-connect-demo.web.app";
const appId = "agent-connect-demo";
const redirectUri = `${appOrigin}/`;
const verifier = randomBytes(48).toString("base64url");
const tools = [
  objectTool(
    "get_current_app_state",
    "Read the currently selected app view. Call this before deciding which app-specific write tools to use.",
    {},
    [],
  ),
  objectArrayTool(
    "create_project_tasks",
    "Add several tasks to the project board.",
    "tasks",
    {
      id: { type: "string" },
      title: { type: "string" },
      priority: { enum: ["high", "medium", "low"] },
      status: { enum: ["backlog", "doing", "done"] },
    },
    ["id", "title", "priority", "status"],
  ),
  objectArrayTool(
    "update_project_tasks",
    "Change titles or priorities of existing project tasks.",
    "changes",
    {
      id: { type: "string" },
      title: { type: "string" },
      priority: { enum: ["high", "medium", "low"] },
    },
    ["id"],
  ),
  objectArrayTool(
    "move_project_tasks",
    "Move existing project tasks between board columns.",
    "moves",
    {
      id: { type: "string" },
      status: { enum: ["backlog", "doing", "done"] },
    },
    ["id", "status"],
  ),
  objectArrayTool(
    "add_document_comments",
    "Attach review comments to exact quoted passages in the document.",
    "comments",
    {
      quote: { type: "string" },
      kind: { enum: ["fact", "clarity", "style"] },
      comment: { type: "string" },
    },
    ["quote", "kind", "comment"],
  ),
  objectArrayTool(
    "replace_document_text",
    "Replace exact quoted passages in the open document.",
    "replacements",
    {
      quote: { type: "string" },
      replacement: { type: "string" },
    },
    ["quote", "replacement"],
  ),
  objectArrayTool(
    "format_document_blocks",
    "Apply semantic formatting to exact document blocks.",
    "blocks",
    {
      blockId: { type: "string" },
      format: { enum: ["heading", "paragraph", "callout"] },
    },
    ["blockId", "format"],
  ),
  objectTool(
    "add_product_assessment",
    "Add a child-suitability assessment and safety concerns to the product page.",
    {
      verdict: { type: "string" },
      kidFit: { enum: ["good", "mixed", "poor"] },
      concerns: { type: "array", items: { type: "string" } },
    },
    ["verdict", "kidFit", "concerns"],
  ),
  objectTool(
    "add_price_comparison",
    "Add recorded pricing context and a fair-price verdict to the product page.",
    {
      listedPrice: { type: "number" },
      fairLow: { type: "number" },
      fairHigh: { type: "number" },
      verdict: { type: "string" },
    },
    ["listedPrice", "fairLow", "fairHigh", "verdict"],
  ),
  objectArrayTool(
    "add_product_alternatives",
    "Add researched alternative products and source links to the product page.",
    "alternatives",
    {
      name: { type: "string" },
      price: { type: "number" },
      reason: { type: "string" },
      url: { type: "string" },
    },
    ["name", "price", "reason", "url"],
  ),
];
const expectedToolNames = [
  "get_current_app_state",
  "create_project_tasks",
  "update_project_tasks",
  "move_project_tasks",
];

if (process.argv.includes("--print-tool-hash")) {
  process.stdout.write(`${sha256(canonicalJson(tools))}\n`);
  process.exit(0);
}

const passphrase = requiredEnv("AGENT_CONNECT_SMOKE_ENROLLMENT_PASSPHRASE");

const challenge = await request("/v1/runtime-challenges", {
  method: "POST",
  headers: appHeaders({ "Content-Type": "application/json" }),
  body: JSON.stringify({ nonce: randomBytes(18).toString("base64url") }),
});
assertStatus(challenge, 200, "runtime challenge");
const challengeBody = await challenge.json();
if (challengeBody.runtimeCard?.transportProfile !== "public-demo") {
  throw new Error("runtime challenge did not return the public-demo profile");
}
const authorizationOrigin = new URL(
  challengeBody.runtimeCard.authorizationServer,
).origin;

const authorizationRequest = await request("/v1/authorization-requests", {
  method: "POST",
  headers: appHeaders({ "Content-Type": "application/json" }),
  body: JSON.stringify({
    appId,
    redirectUri,
    state: randomBytes(18).toString("base64url"),
    codeChallenge: sha256(verifier),
    scopes: ["agent:prompt", "agent:result", "tools:invoke"],
    tools,
  }),
});
assertStatus(authorizationRequest, 201, "authorization request");
const pending = await authorizationRequest.json();

const approval = await request("/authorize", {
  method: "POST",
  redirect: "manual",
  headers: {
    Origin: authorizationOrigin,
    "Content-Type": "application/x-www-form-urlencoded",
  },
  body: new URLSearchParams({
    request: pending.requestId,
    decision: "approve",
    passphrase,
  }),
});
assertStatus(approval, 303, "authorization approval");
const deviceCookie = cookiePair(approval.headers.get("set-cookie"));
const callback = new URL(approval.headers.get("location") ?? "");
const code = callback.searchParams.get("code");
if (!code) throw new Error("authorization approval returned no code");

const tokenResponse = await request("/oauth/token", {
  method: "POST",
  headers: appHeaders({ "Content-Type": "application/json" }),
  body: JSON.stringify({ code, codeVerifier: verifier, appId, redirectUri }),
});
assertStatus(tokenResponse, 200, "authorization code exchange");
const grant = await tokenResponse.json();
if (typeof grant.grant?.id !== "string") {
  throw new Error("authorization code exchange returned no grant id");
}

const sessionResponse = await request("/v1/app-sessions", {
  method: "POST",
  headers: appHeaders({
    Authorization: `Bearer ${grant.accessToken}`,
    "Content-Type": "application/json",
  }),
  body: JSON.stringify({ appId, tools }),
});
assertStatus(sessionResponse, 201, "application session");
const session = await sessionResponse.json();
const sessionPath = `/v1/sessions/${encodeURIComponent(session.sessionId)}`;

const stream = await request(`${sessionPath}/stream`, {
  headers: appHeaders({
    Authorization: `Bearer ${session.accessToken}`,
    Accept: "text/event-stream",
  }),
});
assertStatus(stream, 200, "task stream");

const message = await request(`${sessionPath}/events`, {
  method: "POST",
  headers: appHeaders({
    Authorization: `Bearer ${session.accessToken}`,
    "Content-Type": "application/json",
  }),
  body: JSON.stringify({
    type: "message",
    data: {
      role: "user",
      content: [
        {
          type: "input_text",
          text: "[Agent Connect demo scenario: project-board]\nOrganize this launch board",
        },
      ],
    },
    tools: tools.map((tool) => ({
      type: "function",
      function: {
        name: tool.name,
        description: tool.description,
        parameters: tool.inputSchema,
      },
    })),
  }),
});
assertStatus(message, 202, "task message");

const requestedToolNames = [];
let completed = false;
for await (const event of parseSse(stream.body)) {
  if (event.type === "response.output_item.done") {
    const item = event.item;
    if (item?.status !== "action_required") continue;
    if (!expectedToolNames.includes(item.name)) {
      throw new Error(`unexpected tool requested: ${String(item.name)}`);
    }
    JSON.parse(item.arguments);
    requestedToolNames.push(item.name);
    const result = await request(`${sessionPath}/events`, {
      method: "POST",
      headers: appHeaders({
        Authorization: `Bearer ${session.accessToken}`,
        "Content-Type": "application/json",
      }),
      body: JSON.stringify({
        type: "function_call_output",
        data: {
          call_id: item.call_id,
          output: JSON.stringify({
            applied: true,
            toolName: item.name,
          }),
        },
      }),
    });
    assertStatus(result, 202, "browser tool result");
  }
  if (event.type === "response.completed") {
    completed = true;
    break;
  }
}

if (
  JSON.stringify(requestedToolNames) !== JSON.stringify(expectedToolNames) ||
  !completed
) {
  throw new Error("deterministic browser tool loop did not complete");
}

const revocation = await request("/v1/grants", {
  method: "POST",
  redirect: "manual",
  headers: {
    Origin: authorizationOrigin,
    Cookie: deviceCookie,
    "Content-Type": "application/x-www-form-urlencoded",
  },
  body: new URLSearchParams({ grant: grant.grant.id }),
});
assertStatus(revocation, 303, "smoke grant revocation");

const revokedGrantCheck = await request("/v1/app-sessions", {
  method: "POST",
  headers: appHeaders({
    Authorization: `Bearer ${grant.accessToken}`,
    "Content-Type": "application/json",
  }),
  body: JSON.stringify({ appId, tools }),
});
assertStatus(revokedGrantCheck, 401, "revoked smoke grant check");

process.stdout.write(
  `${JSON.stringify({ ok: true, transportProfile: "public-demo", tools: requestedToolNames, grantRevoked: true })}\n`,
);

function objectTool(name, description, properties, required) {
  return {
    name,
    description,
    inputSchema: {
      type: "object",
      properties,
      required,
      additionalProperties: false,
    },
  };
}

function objectArrayTool(
  name,
  description,
  arrayProperty,
  properties,
  required,
) {
  return objectTool(
    name,
    description,
    {
      [arrayProperty]: {
        type: "array",
        items: {
          type: "object",
          properties,
          required,
          additionalProperties: false,
        },
      },
    },
    [arrayProperty],
  );
}

function request(path, init) {
  return fetch(`${baseUrl}${path}`, init);
}

function appHeaders(extra = {}) {
  return { Origin: appOrigin, ...extra };
}

function assertStatus(response, expected, step) {
  if (response.status !== expected) {
    throw new Error(`${step} failed: HTTP ${response.status}`);
  }
}

function cookiePair(setCookie) {
  const pair = setCookie?.split(";", 1)[0];
  if (!pair?.startsWith("agent_connect_device=")) {
    throw new Error("authorization approval returned no device cookie");
  }
  return pair;
}

function sha256(value) {
  return createHash("sha256").update(value).digest("base64url");
}

function canonicalJson(value) {
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(",")}]`;
  }
  if (typeof value === "object" && value !== null) {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function requiredEnv(name) {
  const value = process.env[name];
  if (!value) throw new TypeError(`${name} is required`);
  return value;
}

async function* parseSse(body) {
  if (!body) throw new Error("task stream returned no body");
  const decoder = new TextDecoder();
  let buffer = "";
  for await (const chunk of body) {
    buffer += decoder.decode(chunk, { stream: true }).replaceAll("\r\n", "\n");
    while (true) {
      const boundary = buffer.indexOf("\n\n");
      if (boundary < 0) break;
      const frame = buffer.slice(0, boundary);
      buffer = buffer.slice(boundary + 2);
      const data = frame
        .split("\n")
        .filter((line) => line.startsWith("data:"))
        .map((line) => line.slice(5).trimStart())
        .join("\n");
      if (data && data !== "[DONE]") yield JSON.parse(data);
    }
  }
}
