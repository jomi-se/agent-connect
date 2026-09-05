import assert from "node:assert/strict";
import { mkdir, cp } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import http from "node:http";
import { startOpenClawTestRuntime } from "../../../scripts/openclaw-test-runtime.mjs";

let stateDirectory;
let beforeTurn;
const rows = () => {
  const db = new DatabaseSync(
    `${stateDirectory}/state/agents/main/agent/openclaw-agent.sqlite`,
    { readOnly: true },
  );
  try {
    return db
      .prepare(
        "SELECT session_key, created_actor_id, created_via FROM session_nodes",
      )
      .all();
  } finally {
    db.close();
  }
};
const runtime = await startOpenClawTestRuntime({
  async onModelRequest(body, helpers) {
    beforeTurn ??= rows();
    const last = body.messages.at(-1);
    if (last.role === "tool")
      return helpers.text("Native tool execution confirmed.");
    const serialized = JSON.stringify(last);
    if (serialized.includes("NATIVE_READ_PROBE"))
      return helpers.tool("read", {
        path: `${stateDirectory}/delegation-plugin/openclaw.plugin.json`,
      });
    if (serialized.includes("CLIENT_TOOL_PROBE"))
      return helpers.tool("client_echo", { value: "client-roundtrip" });
    helpers.text("Deterministic fixture response.");
  },
  async configure(config, { directory, token, port }) {
    stateDirectory = directory;
    const plugin = `${directory}/delegation-plugin`;
    await cp(
      fileURLToPath(new URL("delegation-plugin", import.meta.url)),
      plugin,
      { recursive: true },
    );
    config.plugins = {
      allow: ["ac-delegation-probe"],
      load: { paths: [plugin] },
      entries: {
        "ac-delegation-probe": {
          enabled: true,
          config: { ownerSecret: token, port },
        },
      },
    };
    config.gateway.trustedProxies = ["127.0.0.1"];
    config.gateway.auth = {
      mode: "trusted-proxy",
      trustedProxy: {
        allowLoopback: true,
        userHeader: "x-ac-principal",
        requiredHeaders: ["x-forwarded-for"],
      },
    };
    config.gateway.roles = {
      default: "app",
      definitions: {
        app: {
          sessions: { others: "none" },
          agents: ["main"],
          scopes: ["operator.read", "operator.write"],
        },
      },
    };
    config.tools = { allow: ["read"] };
    config.agents.list = [{ id: "main", default: true }, { id: "other" }];
    await mkdir(`${directory}/workspace`, { recursive: true });
  },
});
try {
  console.log(`EVIDENCE ${runtime.directory}`);
  const call = async (path, body, token, headers = {}) => {
    const res = await fetch(`${runtime.baseUrl}${path}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(token ? { authorization: `Bearer ${token}` } : {}),
        ...headers,
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(60000),
    });
    const text = await res.text();
    let json;
    try {
      json = JSON.parse(text);
    } catch {
      /* SSE */
    }
    return {
      status: res.status,
      json,
      text,
      session: res.headers.get("x-ac-session"),
    };
  };
  const initial = await call("/ac-probe/request", {
    name: "Unverified native A",
  });
  assert.equal(initial.status, 201, initial.text);
  const a = initial.json;
  assert.equal(a.verified, false);
  assert(!JSON.stringify(a).includes(runtime.token));
  assert.equal(
    (await call("/ac-probe/responses", { input: "pending" }, a.credential))
      .status,
    403,
  );
  assert.equal(
    (
      await call(
        "/ac-probe/decision",
        { id: a.id, state: "approved" },
        a.credential,
      )
    ).status,
    401,
  );
  const denied = (await call("/ac-probe/request", { name: "Denied" })).json;
  assert.equal(
    (
      await call(
        "/ac-probe/decision",
        { id: denied.id, state: "denied" },
        runtime.token,
      )
    ).status,
    200,
  );
  assert.equal(
    (await call("/ac-probe/responses", { input: "denied" }, denied.credential))
      .status,
    403,
  );
  assert.equal(
    (
      await call(
        "/ac-probe/decision",
        { id: a.id, state: "approved" },
        runtime.token,
      )
    ).status,
    200,
  );
  console.log(
    "PASS originless unverified request; pending, unauthorized approval, denial, owner approval",
  );
  const first = await call(
    "/ac-probe/responses",
    { input: "First turn", stream: false },
    a.credential,
  );
  console.log(
    JSON.stringify({
      label: "first approved native-provisioned Responses",
      status: first.status,
      responseStatus: first.json?.status,
    }),
  );
  assert.equal(first.status, 200);
  const second = await call(
    "/ac-probe/responses",
    { input: "Second turn", stream: true },
    a.credential,
    { "x-ac-session": first.session },
  );
  console.log(
    JSON.stringify({
      label: "second turn SSE",
      status: second.status,
      completed: second.text.includes("response.completed"),
    }),
  );
  assert.equal(second.status, 200);
  assert(second.text.includes("response.completed"));
  assert.deepEqual(rows(), beforeTurn);
  assert.equal(beforeTurn.length, 1);
  assert(beforeTurn[0].created_actor_id);
  assert.equal(beforeTurn[0].created_via, "operator");
  const profiles = new DatabaseSync(
    `${stateDirectory}/state/state/openclaw.sqlite`,
    { readOnly: true },
  );
  try {
    assert.equal(
      profiles
        .prepare("SELECT profile_id FROM user_profile_emails WHERE email = ?")
        .get(`app:${a.id}`).profile_id,
      beforeTurn[0].created_actor_id,
    );
  } finally {
    profiles.close();
  }
  console.log(
    JSON.stringify({
      label: "native creator preserved before inference and after two turns",
      rows: rows(),
    }),
  );
  const nativeHeaders = (id) => ({
    "x-ac-principal": `app:${id}`,
    "x-forwarded-for": "192.0.2.7",
    "x-openclaw-scopes": "operator.write",
    "x-openclaw-session-key": rows()[0].session_key,
    "x-openclaw-agent-id": "main",
  });
  const approvedB = (await call("/ac-probe/request", { name: "Approved B" }))
    .json;
  assert.equal(
    (
      await call(
        "/ac-probe/decision",
        { id: approvedB.id, state: "approved" },
        runtime.token,
      )
    ).status,
    200,
  );
  const stolenSession = await call(
    "/ac-probe/responses",
    { input: "Use A session as B" },
    approvedB.credential,
    { "x-ac-session": first.session },
  );
  assert.equal(stolenSession.status, 403, stolenSession.text);
  const authorityBefore = rows();
  const hostileHeaders = await call(
    "/ac-probe/responses",
    { input: "Approved A with hostile authority headers", stream: false },
    a.credential,
    {
      "x-ac-session": first.session,
      "x-ac-principal": `app:${approvedB.id}`,
      "x-forwarded-for": "203.0.113.99",
      "x-openclaw-agent-id": "other",
      "x-openclaw-session-key": "agent:other:ac-probe:forged",
      "x-openclaw-scopes": "operator.write,operator.admin",
    },
  );
  assert.equal(hostileHeaders.status, 200, hostileHeaders.text);
  assert.equal(hostileHeaders.session, first.session);
  assert.deepEqual(rows(), authorityBefore);
  const alternateModel = await call(
    "/ac-probe/responses",
    { model: "openclaw:other", input: "Select other through model" },
    a.credential,
    { "x-ac-session": first.session },
  );
  assert.equal(alternateModel.status, 403, alternateModel.text);
  const alternateBody = await call(
    "/ac-probe/responses",
    {
      agentId: "other",
      sessionKey: "agent:other:ac-probe:forged",
      input: "Select other through raw body",
    },
    a.credential,
    { "x-ac-session": first.session },
  );
  assert.equal(alternateBody.status, 400, alternateBody.text);
  assert.deepEqual(rows(), authorityBefore);
  console.log(
    "PASS approved B opaque-session theft403; approved A hostile identity/agent/session/combined write+admin headers200 with unchanged native authority; alternate model403; raw body routing400",
  );
  assert.equal(
    (
      await call("/v1/responses", {
        model: "openclaw",
        input: "unauthenticated",
      })
    ).status,
    401,
  );
  const sibling = await call(
    "/v1/responses",
    { model: "openclaw", input: "sibling" },
    undefined,
    nativeHeaders("sibling"),
  );
  assert.equal(sibling.status, 403, sibling.text);
  const wrong = await call(
    "/v1/responses",
    { model: "openclaw", input: "wrong agent" },
    undefined,
    {
      ...nativeHeaders(a.id),
      "x-openclaw-agent-id": "other",
      "x-openclaw-session-key": "agent:other:ac-probe:test",
    },
  );
  assert.equal(wrong.status, 403, wrong.text);
  const admin = await call(
    "/v1/responses",
    { model: "openclaw", input: "admin" },
    undefined,
    { ...nativeHeaders(a.id), "x-openclaw-scopes": "operator.admin" },
  );
  assert.equal(admin.status, 403, admin.text);
  console.log(
    "PASS native core unauthenticated401, sibling403, wrong-agent403, admin-only403 (missing write; not evidence of combined-scope restriction)",
  );
  const tools = [
    {
      type: "function",
      name: "client_echo",
      description: "Fixture echo",
      parameters: {
        type: "object",
        properties: { value: { type: "string" } },
        required: ["value"],
      },
    },
  ];
  const native = await call(
    "/ac-probe/responses",
    { input: "NATIVE_READ_PROBE", tools, stream: false },
    a.credential,
    { "x-ac-session": first.session },
  );
  assert.equal(native.status, 200, native.text);
  // Read only a public fixture artifact, never credentials.
  assert(
    runtime.modelRequests.some((request) =>
      request.body.messages.some(
        (message) =>
          message.role === "tool" &&
          String(message.content).includes("ac-delegation-probe"),
      ),
    ),
  );
  console.log(
    JSON.stringify({
      label:
        "native read returned manifest into model context alongside client tool",
      status: native.status,
    }),
  );
  const client = await call(
    "/ac-probe/responses",
    { input: "CLIENT_TOOL_PROBE", tools, stream: false },
    a.credential,
    { "x-ac-session": first.session },
  );
  assert.equal(client.status, 200, client.text);
  const invocation = client.json.output.find(
    (item) => item.type === "function_call",
  );
  assert(invocation, client.text);
  const output = await call(
    "/ac-probe/responses",
    {
      input: [
        {
          type: "function_call_output",
          call_id: invocation.call_id,
          output: "CLIENT_OUTPUT_CONFIRMED",
        },
      ],
      tools,
      stream: true,
    },
    a.credential,
    { "x-ac-session": first.session },
  );
  assert.equal(output.status, 200, output.text);
  assert(output.text.includes("response.completed"));
  assert(
    runtime.modelRequests.some((request) =>
      JSON.stringify(request.body.messages).includes("CLIENT_OUTPUT_CONFIRMED"),
    ),
  );
  console.log(
    "PASS native read plus client-defined tool/output and native SSE terminal",
  );
  assert.equal(
    (
      await call(
        "/ac-probe/decision",
        { id: a.id, state: "revoked" },
        runtime.token,
      )
    ).status,
    200,
  );
  assert.equal(
    (await call("/ac-probe/responses", { input: "revoked" }, a.credential))
      .status,
    403,
  );
  console.log("PASS revocation; local inference only");
  // Test-only stand-in for an existing path-restricted deployment ingress.
  // This listener is NOT part of the plugin or a proposed new gateway process.
  const allowed = new Set([
    "/ac-probe/request",
    "/ac-probe/decision",
    "/ac-probe/responses",
  ]);
  const ingress = http.createServer(async (req, res) => {
    if (!allowed.has(req.url)) {
      res.writeHead(404);
      res.end();
      return;
    }
    const upstream = http.request(
      `${runtime.baseUrl}${req.url}`,
      { method: req.method, headers: req.headers },
      (response) => {
        res.writeHead(response.statusCode, response.headers);
        response.pipe(res);
      },
    );
    upstream.on("error", () => res.destroy());
    req.pipe(upstream);
  });
  await new Promise((resolve) => ingress.listen(0, "127.0.0.1", resolve));
  try {
    const publicUrl = `http://127.0.0.1:${ingress.address().port}`;
    for (const path of [
      "/v1/responses",
      "/_ac-private/create-session",
      "/ac-probe/%2e%2e/v1/responses",
      "/ac-probe/%2f../v1/responses",
    ]) {
      const response = await fetch(`${publicUrl}${path}`, {
        method: "POST",
        headers: nativeHeaders(a.id),
        body: JSON.stringify({ input: "forged bypass" }),
      });
      assert.equal(response.status, 404, path);
    }
    const response = await fetch(`${publicUrl}/ac-probe/responses`, {
      method: "POST",
      headers: nativeHeaders(a.id),
      body: JSON.stringify({ input: "forged app identity" }),
    });
    assert.equal(response.status, 403);
    assert.equal(
      (
        await fetch(`${publicUrl}/ac-probe/request`, {
          method: "POST",
          body: "{}",
        })
      ).status,
      201,
    );
    console.log(
      "PASS modeled path-limited ingress: approved route reachable, forged identity grant bypass403, core/private/encoded traversal404",
    );
  } finally {
    ingress.closeAllConnections();
    await new Promise((resolve) => ingress.close(resolve));
  }
} finally {
  await runtime.close();
}
