import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

import { startOpenClawTestRuntime } from "./openclaw-test-runtime.mjs";

const ORIGIN = "https://bookhand.example";
const MODEL = "openclaw/default";
const APPROVED_TOOL = {
  type: "function",
  name: "lookup_book",
  description: "Look up a book by its exact title",
  parameters: {
    type: "object",
    properties: { title: { type: "string" } },
    required: ["title"],
    additionalProperties: false,
  },
};

test("native OpenResponses application principal stays closed and refresh-stable", async () => {
  let stateDirectory;
  const runtime = await startOpenClawTestRuntime({
    onModelRequest(body, inference) {
      assert.deepEqual(
        body.tools?.map((tool) => tool.function?.name ?? tool.name),
        ["lookup_book"],
      );
      if (JSON.stringify(body.messages).includes("book-id-42")) {
        inference.text("Application result book-id-42 received.");
      } else {
        inference.tool("lookup_book", { title: "The Left Hand of Darkness" });
      }
    },
    async configure(config, { directory }) {
      stateDirectory = directory;
      const pluginDirectory = join(directory, "application-principal-plugin");
      const workspace = join(directory, "application-workspace");
      await mkdir(pluginDirectory, { recursive: true });
      await mkdir(workspace, { recursive: true });
      await writeFile(
        join(pluginDirectory, "package.json"),
        JSON.stringify({
          name: "application-principal-test",
          version: "1.0.0",
          type: "module",
          openclaw: { extensions: ["./index.mjs"] },
        }),
      );
      await writeFile(
        join(pluginDirectory, "openclaw.plugin.json"),
        JSON.stringify({
          id: "application-principal-test",
          activation: { onStartup: true },
          configSchema: { type: "object", additionalProperties: false },
        }),
      );
      await writeFile(
        join(pluginDirectory, "index.mjs"),
        `import { fingerprintOpenResponsesApplicationPolicy } from "openclaw/plugin-sdk/openresponses-application-policy";

const grants = new Map([
  ["ac_access_alpha_v1", "agent-connect:grant:alpha"],
  ["ac_access_alpha_v2", "agent-connect:grant:alpha"],
  ["ac_access_beta_v1", "agent-connect:grant:beta"],
]);

export default {
  id: "application-principal-test",
  register(api) {
    const policyFingerprint = fingerprintOpenResponsesApplicationPolicy(api.config, {
      policyRef: "application-test",
      agentId: "application-test",
      nativeCapabilities: [],
    });
    if (!policyFingerprint) throw new Error("closed test policy unavailable");
    api.registerHttpRoute({
      path: "/application-owner-only",
      auth: "gateway",
      match: "exact",
      gatewayRuntimeScopeSurface: "trusted-operator",
      async handler(_req, res) { res.end("owner"); return true; },
    });
    api.registerOpenResponsesApplicationAuth({
      resolveBrowserOrigin(req) {
        return req.headers.origin === ${JSON.stringify(ORIGIN)}
          ? { origin: ${JSON.stringify(ORIGIN)}, allowHeaders: ["authorization", "content-type"] }
          : null;
      },
      authenticate(req) {
        const bearer = req.headers.authorization?.match(/^Bearer ([^ ]+)$/)?.[1];
        if (!bearer?.startsWith("ac_access_")) return { status: "pass" };
        const subject = grants.get(bearer);
        if (!subject) return { status: "deny" };
        return {
          status: "authenticated",
          principal: {
            subject,
            agentId: "application-test",
            policyRef: "application-test",
            policyFingerprint,
            nativeCapabilities: [],
          },
        };
      },
      authorize({ principal, request }) {
        const tool = request.clientTools[0];
        return principal.policyFingerprint === policyFingerprint &&
          principal.nativeCapabilities.length === 0 &&
          request.agentId === "application-test" &&
          request.clientTools.length === 1 &&
          tool.name === "lookup_book" &&
          tool.description === "Look up a book by its exact title" &&
          JSON.stringify(tool.inputSchema) === ${JSON.stringify(
            JSON.stringify({
              type: "object",
              properties: { title: { type: "string" } },
              required: ["title"],
              additionalProperties: false,
            }),
          )};
      },
    });
  },
};
`,
      );
      config.gateway.roles = {
        default: "denied",
        definitions: {
          denied: { sessions: { others: "none" }, agents: [], scopes: [] },
          "application-test": {
            sessions: { others: "none" },
            sandbox: "inherit",
            agents: ["application-test"],
            scopes: [],
          },
        },
      };
      config.agents.entries = {
        "application-test": {
          workspace,
          contextInjection: "never",
          model: { primary: "fixture/fixture" },
          tools: { deny: ["*"] },
        },
      };
      config.plugins = {
        allow: ["application-principal-test"],
        load: { paths: [pluginDirectory] },
        entries: {
          "application-principal-test": { enabled: true, config: {} },
        },
      };
    },
  });

  const headers = (token, extra = {}) => ({
    origin: ORIGIN,
    authorization: `Bearer ${token}`,
    "content-type": "application/json",
    ...extra,
  });
  const respond = (token, body, extraHeaders) =>
    fetch(`${runtime.baseUrl}/v1/responses`, {
      method: "POST",
      headers: headers(token, extraHeaders),
      body: JSON.stringify({ model: MODEL, stream: false, ...body }),
      signal: AbortSignal.timeout(30_000),
    });

  try {
    const preflight = await fetch(`${runtime.baseUrl}/v1/responses`, {
      method: "OPTIONS",
      headers: {
        origin: ORIGIN,
        "access-control-request-method": "POST",
        "access-control-request-headers": "authorization, content-type",
      },
    });
    assert.equal(preflight.status, 204);
    assert.equal(preflight.headers.get("access-control-allow-origin"), ORIGIN);

    const ownerOnly = await fetch(`${runtime.baseUrl}/application-owner-only`, {
      headers: { authorization: "Bearer ac_access_alpha_v1" },
    });
    assert.equal(ownerOnly.status, 401);

    const invalid = await respond("ac_access_invalid", {
      input: "no inference",
    });
    assert.equal(invalid.status, 401);
    assert.equal(invalid.headers.get("access-control-allow-origin"), ORIGIN);

    const media = await respond("ac_access_alpha_v1", {
      input: [
        {
          type: "message",
          role: "user",
          content: [
            { type: "input_text", text: "do not fetch" },
            {
              type: "input_image",
              source: { type: "url", url: "http://127.0.0.1:9/no" },
            },
          ],
        },
      ],
    });
    assert.equal(media.status, 403);

    const changedTools = await respond("ac_access_alpha_v1", {
      input: "no inference",
      tools: [
        {
          type: "function",
          name: "lookup_book",
          description: "Look up a book by its exact title",
          parameters: {
            type: "object",
            properties: { title: { type: "number" } },
            required: ["title"],
          },
        },
      ],
    });
    assert.equal(changedTools.status, 403);
    assert.equal(runtime.modelRequests.length, 0);

    const first = await respond("ac_access_alpha_v1", {
      input: "first turn",
      tools: [APPROVED_TOOL],
    });
    assert.equal(first.status, 200);
    const firstBody = await first.json();
    assert.match(firstBody.id, /^resp_/);
    const call = firstBody.output.find((item) => item.type === "function_call");
    assert.equal(call.name, "lookup_book");
    assert.deepEqual(JSON.parse(call.arguments), {
      title: "The Left Hand of Darkness",
    });

    const second = await respond("ac_access_alpha_v2", {
      previous_response_id: firstBody.id,
      input: [
        {
          type: "function_call_output",
          call_id: call.call_id,
          output: "book-id-42",
        },
      ],
      tools: [APPROVED_TOOL],
    });
    assert.equal(second.status, 200);
    const secondBody = await second.json();
    assert.match(secondBody.output[0].content[0].text, /book-id-42/);
    assert.equal(runtime.modelRequests.length, 2);
    for (const request of runtime.modelRequests) {
      assert.deepEqual(
        request.body.tools?.map((tool) => tool.function?.name ?? tool.name),
        ["lookup_book"],
      );
    }

    const crossed = await respond("ac_access_beta_v1", {
      previous_response_id: firstBody.id,
      input: "must not inherit alpha",
      tools: [APPROVED_TOOL],
    });
    assert.equal(crossed.status, 403);
    assert.equal(runtime.modelRequests.length, 2);

    const rows = new DatabaseSync(
      join(
        stateDirectory,
        "state/agents/application-test/agent/openclaw-agent.sqlite",
      ),
      { readOnly: true },
    );
    try {
      const sessions = rows
        .prepare(
          "SELECT session_key, created_actor_id, created_via FROM session_nodes",
        )
        .all();
      assert.equal(sessions.length, 1);
      assert.equal(sessions[0].created_via, "run");
      assert.ok(sessions[0].created_actor_id);
    } finally {
      rows.close();
    }
  } finally {
    await runtime.close();
  }
});
