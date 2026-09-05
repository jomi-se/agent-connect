import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import {
  cp,
  mkdir,
  mkdtemp,
  readFile,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { startOpenClawTestRuntime } from "../../../scripts/openclaw-test-runtime.mjs";

// A real Docker CLI targets a nonexistent private socket. No daemon/image/container
// state is changed, even if the workstation's normal Docker daemon is available.
const binary = process.env.OPENCLAW_TEST_BIN || "openclaw";
const launcherDirectory = await mkdtemp(
  join(tmpdir(), "ac-sandbox-unavailable-"),
);
const launcher = join(launcherDirectory, "openclaw");
const unavailableSocket = join(launcherDirectory, "absent-docker.sock");
const shellQuote = (value) => `'${value.replaceAll("'", "'\\''")}'`;
await writeFile(
  launcher,
  `#!/bin/sh\nexport DOCKER_HOST=${shellQuote(`unix://${unavailableSocket}`)}\nexec ${shellQuote(binary)} "$@"\n`,
  { mode: 0o700 },
);
process.env.OPENCLAW_TEST_BIN = launcher;
console.log(
  JSON.stringify({
    dockerClient: execFileSync("docker", ["--version"], {
      encoding: "utf8",
    }).trim(),
    unavailableSocket,
  }),
);

async function exists(path) {
  try {
    await stat(path);
    return true;
  } catch (error) {
    if (error.code === "ENOENT") return false;
    throw error;
  }
}

async function runCase(required) {
  let directory;
  let marker;
  let toolRequests = 0;
  const runtime = await startOpenClawTestRuntime({
    async configure(config, state) {
      directory = state.directory;
      marker = join(directory, "host-execution-marker");
      const plugin = join(directory, "delegation-plugin");
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
            config: { ownerSecret: state.token, port: state.port },
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
            sandbox: required ? "required" : "inherit",
          },
        },
      };
      config.agents.defaults.sandbox = { mode: "off" };
      config.tools = {
        allow: ["exec"],
        exec: { security: "full", ask: "off" },
      };
      await mkdir(join(directory, "workspace"), { recursive: true });
    },
    async onModelRequest(body, helpers) {
      if (body.messages.at(-1)?.role === "tool")
        return helpers.text("HOST_CONTROL_COMPLETED");
      toolRequests++;
      return helpers.tool("exec", { command: `touch ${shellQuote(marker)}` });
    },
  });
  try {
    console.log(`EVIDENCE ${required ? "required" : "control"} ${directory}`);
    const id = randomUUID();
    const key = `agent:main:ac-probe:${randomUUID()}`;
    const headers = {
      "content-type": "application/json",
      "x-ac-principal": `app:${id}`,
      "x-forwarded-for": "192.0.2.7",
      "x-openclaw-scopes": "operator.write",
    };
    const post = async (path, body, extra = {}) => {
      const response = await fetch(`${runtime.baseUrl}${path}`, {
        method: "POST",
        headers: { ...headers, ...extra },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(60000),
      });
      return { status: response.status, text: await response.text() };
    };
    const provision = await post("/_ac-private/create-session", { key });
    assert.equal(provision.status, 200, provision.text);
    const row = () => {
      const db = new DatabaseSync(
        join(directory, "state/agents/main/agent/openclaw-agent.sqlite"),
        { readOnly: true },
      );
      try {
        return db
          .prepare(
            "SELECT created_actor_id, created_via, entry_json FROM session_nodes WHERE session_key = ?",
          )
          .get(key);
      } finally {
        db.close();
      }
    };
    const before = row();
    assert(
      before?.created_actor_id,
      "native creator must exist before Responses",
    );
    assert.equal(before.created_via, "operator");
    assert.equal(
      JSON.parse(before.entry_json).sandbox,
      required ? "required" : undefined,
    );
    assert.equal(await exists(marker), false);
    const response = await post(
      "/v1/responses",
      {
        model: "openclaw",
        input: "Execute the fixture marker command.",
        stream: false,
      },
      { "x-openclaw-agent-id": "main", "x-openclaw-session-key": key },
    );
    const after = row();
    assert.equal(after.created_actor_id, before.created_actor_id);
    assert.equal(
      JSON.parse(after.entry_json).sandbox,
      required ? "required" : undefined,
    );
    const hostMarkerExists = await exists(marker);
    const log = await readFile(join(directory, "gateway.log"), "utf8");
    const summary = {
      required,
      status: response.status,
      response: response.text,
      creator: before.created_actor_id,
      sandboxBefore: JSON.parse(before.entry_json).sandbox ?? null,
      sandboxAfter: JSON.parse(after.entry_json).sandbox ?? null,
      modelRequests: runtime.modelRequests.length,
      toolRequests,
      hostMarkerExists,
      unavailableDockerEvidence:
        /Docker daemon is not available|Cannot connect to the Docker daemon|dial unix/i.test(
          `${log}\n${response.text}`,
        ),
    };
    await writeFile(
      join(directory, "sandbox-evidence.json"),
      JSON.stringify(summary, null, 2),
    );
    console.log(JSON.stringify(summary));
    if (required) {
      assert.equal(
        hostMarkerExists,
        false,
        "required sandbox must not fall back to host execution",
      );
      assert(
        summary.unavailableDockerEvidence,
        "failure must identify the real unavailable Docker backend",
      );
      assert(
        response.status >= 400 || JSON.parse(response.text).status === "failed",
        "run must fail closed",
      );
    } else {
      assert.equal(response.status, 200, response.text);
      assert(
        toolRequests > 0,
        "positive control must request the real native exec tool",
      );
      assert.equal(
        hostMarkerExists,
        true,
        "positive control must establish that host execution would create the marker",
      );
    }
  } finally {
    await runtime.close();
  }
}

try {
  await runCase(false);
  await runCase(true);
  console.log(
    "PASS native creator and required sandbox provenance; positive host-exec control; unavailable Docker fails closed without host marker",
  );
} finally {
  process.env.OPENCLAW_TEST_BIN = binary;
}
