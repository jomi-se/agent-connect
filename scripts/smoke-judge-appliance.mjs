#!/usr/bin/env node

import { createHash, randomBytes } from "node:crypto";

const baseUrl =
  process.env.AGENT_CONNECT_SMOKE_BASE_URL ?? "http://127.0.0.1:10081";
const appOrigin =
  process.env.AGENT_CONNECT_SMOKE_APP_ORIGIN ??
  "https://agent-connect-demo.web.app";
const passphrase = requiredEnv("AGENT_CONNECT_SMOKE_ENROLLMENT_PASSPHRASE");
const appId = "agent-connect-demo";
const redirectUri = `${appOrigin}/`;
const expectedMessage =
  "Welcome—this page was updated through the deterministic Agent Connect judge runtime.";
const verifier = randomBytes(48).toString("base64url");
const tool = {
  name: "set_page_message",
  description: "Replace the large visible message on the user's web page.",
  inputSchema: {
    type: "object",
    properties: {
      message: {
        type: "string",
        minLength: 1,
        maxLength: 180,
        description: "The complete message to show on the page.",
      },
    },
    required: ["message"],
    additionalProperties: false,
  },
};

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
    tools: [tool],
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

const sessionResponse = await request("/v1/app-sessions", {
  method: "POST",
  headers: appHeaders({
    Authorization: `Bearer ${grant.accessToken}`,
    "Content-Type": "application/json",
  }),
  body: JSON.stringify({ appId, tools: [tool] }),
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
      content: [{ type: "input_text", text: "Update this page" }],
    },
    tools: [
      {
        type: "function",
        function: {
          name: tool.name,
          description: tool.description,
          parameters: tool.inputSchema,
        },
      },
    ],
  }),
});
assertStatus(message, 202, "task message");

let requestedMessage;
let completed = false;
for await (const event of parseSse(stream.body)) {
  if (event.type === "response.output_item.done") {
    const item = event.item;
    if (item?.status !== "action_required") continue;
    if (item.name !== "set_page_message") {
      throw new Error(`unexpected tool requested: ${String(item.name)}`);
    }
    const args = JSON.parse(item.arguments);
    requestedMessage = args.message;
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
            displayed: true,
            message: requestedMessage,
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

if (requestedMessage !== expectedMessage || !completed) {
  throw new Error("deterministic browser tool loop did not complete");
}
process.stdout.write(
  `${JSON.stringify({ ok: true, transportProfile: "public-demo", tool: tool.name, requestedMessage })}\n`,
);

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

function sha256(value) {
  return createHash("sha256").update(value).digest("base64url");
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
