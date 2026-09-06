// Research probe: stock public plugin runtime, not an application-auth implementation.
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { startOpenClawTestRuntime } from "./openclaw-test-runtime.mjs";

test("stock plugin runtime: restricted tools, streaming and a second turn", async () => {
  const runtime = await startOpenClawTestRuntime({
    onModelRequest(body, inference) {
      assert.deepEqual(
        body.tools?.map((t) => t.function?.name ?? t.name),
        ["lookup_book"],
      );
      if (JSON.stringify(body.messages).includes("book-id-42"))
        inference.text("Received book-id-42.");
      else inference.tool("lookup_book", { title: "Flatland" });
    },
    async configure(config, { directory }) {
      const pluginDirectory = join(directory, "runtime-probe");
      const workspace = join(directory, "restricted-workspace");
      await mkdir(pluginDirectory, { recursive: true });
      await mkdir(workspace, { recursive: true });
      config.agents.entries = {
        restricted: {
          workspace,
          contextInjection: "never",
          model: { primary: "fixture/fixture" },
          tools: { deny: ["*"] },
        },
      };
      config.plugins = {
        allow: ["runtime-probe"],
        load: { paths: [pluginDirectory] },
        entries: { "runtime-probe": { enabled: true } },
      };
      await writeFile(
        join(pluginDirectory, "package.json"),
        JSON.stringify({
          name: "runtime-probe",
          version: "1.0.0",
          type: "module",
          openclaw: { extensions: ["./index.mjs"] },
        }),
      );
      await writeFile(
        join(pluginDirectory, "openclaw.plugin.json"),
        JSON.stringify({
          id: "runtime-probe",
          activation: { onStartup: true },
          configSchema: { type: "object", additionalProperties: false },
        }),
      );
      await writeFile(
        join(pluginDirectory, "index.mjs"),
        `
import { randomUUID } from "node:crypto";
export default { id: "runtime-probe", register(api) {
  let turn = 0;
  api.registerHttpRoute({ path: "/runtime-probe", auth: "gateway", match: "exact",
    async handler(req, res) {
      if (req.method !== "POST") { res.statusCode = 405; res.end(); return true; }
      const events = [];
      try {
        const result = await api.runtime.agent.runEmbeddedAgent({
          config: api.runtime.config.current(), agentId: "restricted", sandboxAgentId: "restricted",
          sessionId: "runtime-probe-session", sessionKey: "agent:restricted:runtime-probe",
          workspaceDir: ${JSON.stringify(workspace)}, runId: randomUUID(), timeoutMs: 20000,
          senderIsOwner: false,
          prompt: turn++ === 0 ? "Look up Flatland." : "Tool result for lookup_book: book-id-42",
          clientTools: [{ type: "function", function: { name: "lookup_book", parameters: { type: "object", properties: { title: { type: "string" } }, required: ["title"] } } }],
          onPartialReply: (event) => { events.push(event); },
        });
        res.setHeader("content-type", "application/json"); res.end(JSON.stringify({ result, events }));
      } catch (error) { res.statusCode = 500; res.end(String(error)); }
      return true;
    }
  });
} };
`,
      );
    },
  });
  try {
    const invoke = async () => {
      const response = await fetch(`${runtime.baseUrl}/runtime-probe`, {
        method: "POST",
        headers: { authorization: `Bearer ${runtime.token}` },
        signal: AbortSignal.timeout(45000),
      });
      const body = await response.text();
      assert.equal(response.status, 200, body);
      return JSON.parse(body);
    };
    const first = await invoke();
    assert.equal(first.result.meta?.pendingToolCalls?.[0]?.name, "lookup_book");
    const second = await invoke();
    assert.match(JSON.stringify(second.result.payloads), /Received book-id-42/);
    assert.ok(second.events.length > 0, "stream callback must run");
    assert.equal(runtime.modelRequests.length, 2);
    assert.match(
      JSON.stringify(runtime.modelRequests[1].body.messages),
      /Look up Flatland/,
    );
  } finally {
    await runtime.close();
  }
});
