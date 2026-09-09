import assert from "node:assert/strict";
import { access, writeFile } from "node:fs/promises";
import { constants } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  compatibility,
  startOpenClawTestRuntime,
} from "./openclaw-test-runtime.mjs";

const APP_TOOL = {
  type: "function",
  name: "lookup_fixture",
  description: "Look up fixture data",
  parameters: {
    type: "object",
    properties: { query: { type: "string" } },
    required: ["query"],
    additionalProperties: false,
  },
};

async function exists(path) {
  try {
    await access(path, constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

test("published stock OpenClaw applies a dedicated deny-all policy to operator Responses", async () => {
  let marker;
  let runtime;
  let inferenceCalls = 0;
  try {
    runtime = await startOpenClawTestRuntime({
      async configure(config, { directory }) {
        marker = join(directory, "must-not-exist");
        config.agents.defaults.skipBootstrap = true;
        config.gateway.reload = { mode: "off" };
        config.agents.entries = {
          restricted: {
            workspace: join(directory, "restricted-workspace"),
            contextInjection: "never",
            skills: [],
            memory: { search: { enabled: false } },
            model: { primary: "fixture/fixture", fallbacks: [] },
            tools: { deny: ["*"] },
          },
        };
        config.tools.toolSearch = false;
        // Deliberately enable elevation globally here: the dedicated agent's
        // deny-all ceiling must still win. Production validation is stricter
        // and requires global elevation off as defense in depth.
        config.tools.elevated = { enabled: true };
        config.plugins = {
          slots: { memory: "none" },
          entries: { "memory-core": { enabled: false } },
        };
      },
      onModelRequest(body, inference) {
        const names = (body.tools ?? []).map(
          (candidate) => candidate.function?.name ?? candidate.name,
        );
        if (JSON.stringify(body.messages).includes("/exec touch")) {
          assert.deepEqual(names, []);
          inference.text("Direct exec remained unavailable.");
          return;
        }
        inferenceCalls += 1;
        assert.deepEqual(names, [APP_TOOL.name]);
        if (inferenceCalls === 1) {
          // Deliberately hallucinate an owner-only native call which was not
          // offered. The runtime must not resolve it to the host exec tool.
          inference.tool("exec", { command: `touch ${marker}` });
        } else {
          inference.text("Unknown native calls stayed unavailable.");
        }
      },
    });

    assert.equal(runtime.stockPackage.version, compatibility.version);
    assert.ok(
      [
        compatibility.tarball,
        `file:openclaw-${compatibility.version}.tgz`,
      ].includes(runtime.stockPackage.resolved),
      `Unexpected OpenClaw package resolution: ${runtime.stockPackage.resolved}`,
    );
    assert.equal(runtime.stockPackage.integrity, compatibility.integrity);
    assert.equal(runtime.stockPackage.patchedApplicationPrincipal, false);
    const authenticatedMalformed = await fetch(
      new URL("/v1/responses", runtime.baseUrl),
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${runtime.token}`,
          "content-type": "application/json",
        },
        body: "{",
      },
    );
    assert.equal(authenticatedMalformed.status, 400);
    const unauthenticatedMalformed = await fetch(
      new URL("/v1/responses", runtime.baseUrl),
      {
        method: "POST",
        headers: {
          authorization: "Bearer deliberately-wrong",
          "content-type": "application/json",
        },
        body: "{",
      },
    );
    assert.equal(unauthenticatedMalformed.status, 401);
    assert.equal(runtime.modelRequests.length, 0);
    const direct = await runtime.request(
      {
        model: "openclaw",
        stream: false,
        input: `/exec touch ${marker}`,
      },
      {
        agentId: "restricted",
        sessionKey: "agent:restricted:openresponses:stock-command-proof",
      },
    );
    assert.equal(direct.status, 200, await direct.clone().text());
    assert.equal(await exists(marker), false);

    const response = await runtime.request(
      {
        model: "openclaw",
        stream: false,
        input:
          "/elevated on\nTry to execute the marker command, then use the application tool.",
        tools: [APP_TOOL],
      },
      {
        agentId: "restricted",
        sessionKey: "agent:restricted:openresponses:stock-deny-proof",
      },
    );
    assert.equal(response.status, 200, await response.clone().text());
    assert.equal(await exists(marker), false);
    assert.ok(inferenceCalls >= 1);
  } finally {
    await runtime?.close();
  }
});

test("published stock OpenClaw fails closed before inference when its sandbox is unavailable", async () => {
  const original = process.env.OPENCLAW_TEST_BIN;
  const fixture = await mkdtemp(join(tmpdir(), "ac-stock-sandbox-proof-"));
  const launcher = join(fixture, "openclaw");
  const socket = join(fixture, "absent-docker.sock");
  const binary = original || "openclaw";
  await writeFile(
    launcher,
    `#!/bin/sh\nexport DOCKER_HOST=${shellQuote(`unix://${socket}`)}\nexec ${shellQuote(binary)} "$@"\n`,
    { mode: 0o700 },
  );
  process.env.OPENCLAW_TEST_BIN = launcher;
  let runtime;
  try {
    runtime = await startOpenClawTestRuntime({
      async configure(config, { directory }) {
        config.agents.defaults.skipBootstrap = true;
        config.agents.entries = {
          restricted: {
            workspace: join(directory, "sandbox-workspace"),
            contextInjection: "never",
            model: { primary: "fixture/fixture" },
            tools: { allow: ["exec", "process"] },
            sandbox: {
              mode: "all",
              backend: "docker",
              scope: "session",
              workspaceAccess: "ro",
            },
          },
        };
      },
      onModelRequest(_body, inference) {
        inference.text("Inference must not be reached.");
      },
    });
    const response = await runtime.request(
      { model: "openclaw", stream: false, input: "Run a command." },
      {
        agentId: "restricted",
        sessionKey: "agent:restricted:openresponses:stock-sandbox-proof",
      },
    );
    const body = await response.text();
    assert.ok(response.status >= 400 || JSON.parse(body).status === "failed");
    assert.equal(runtime.modelRequests.length, 0);
    assert.match(body, /sandbox|docker|failed|unavailable/i);
  } finally {
    process.env.OPENCLAW_TEST_BIN = original;
    await runtime?.close();
  }
});

function shellQuote(value) {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}
