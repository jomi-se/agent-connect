import http from "node:http";
import { spawn, execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtemp, writeFile, appendFile, readFile } from "node:fs/promises";
import { openSync, closeSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export const compatibility = JSON.parse(
  await readFile(
    new URL("../config/openclaw-test-compat.json", import.meta.url),
    "utf8",
  ),
);

export function isSupportedOpenClawNode(version) {
  const actual = version.split(".").map(Number);
  const required = compatibility.minimumNodeVersion.split(".").map(Number);
  return (
    actual[0] === required[0] &&
    actual[0] < compatibility.maximumNodeMajorExclusive &&
    (actual[1] > required[1] ||
      (actual[1] === required[1] && actual[2] >= required[2]))
  );
}

export function preflightOpenClaw() {
  if (!isSupportedOpenClawNode(process.versions.node)) {
    throw new Error(
      `This OpenClaw setup requires Node >=${compatibility.minimumNodeVersion} <${compatibility.maximumNodeMajorExclusive}; found ${process.versions.node}. No install was attempted.`,
    );
  }
  return process.env.OPENCLAW_TEST_BIN || "openclaw";
}

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Starts the actual pinned gateway. Only the model's inference HTTP endpoint is a fixture. */
export async function startOpenClawTestRuntime({
  onModelRequest,
  configure,
  tailscaleTestBinary,
} = {}) {
  const binary = preflightOpenClaw();
  const directory = await mkdtemp(
    join(tmpdir(), "agent-connect-openclaw-test-"),
  );
  const token = randomUUID();
  const modelRequests = [];
  const env = {
    PATH: process.env.PATH,
    OPENCLAW_HOME: directory,
    OPENCLAW_STATE_DIR: join(directory, "state"),
    OPENCLAW_CONFIG_PATH: join(directory, "openclaw.json"),
    XDG_CACHE_HOME: join(directory, "cache"),
    TMPDIR: directory,
    OPENCLAW_SKIP_CHANNELS: "1",
    OPENCLAW_SKIP_CRON: "1",
    // Explicit native test seam; PATH is hardened by OpenClaw at startup.
    ...(tailscaleTestBinary
      ? { VITEST: "true", OPENCLAW_TEST_TAILSCALE_BINARY: tailscaleTestBinary }
      : {}),
  };
  // Do not pass personal auth, provider API keys, HOME, or OpenClaw profile variables.
  const version = execFileSync(binary, ["--version"], {
    env,
    encoding: "utf8",
    timeout: 30000,
  });
  if (
    !new RegExp(`\\b${compatibility.version.replaceAll(".", "\\.")}\\b`).test(
      version,
    )
  ) {
    throw new Error(
      `Expected OpenClaw ${compatibility.version}; got ${version.trim()}`,
    );
  }
  let child;
  let log;
  let closed = false;
  const model = http.createServer(async (req, res) => {
    try {
      let raw = "";
      for await (const chunk of req) raw += chunk;
      const body = JSON.parse(raw);
      const observation = {
        path: req.url,
        body,
        closed: false,
        completed: false,
      };
      // Publish readiness only after close observation is armed. Consumers may
      // cancel immediately, including while the evidence write below is pending.
      res.on("close", () => {
        observation.closed = true;
      });
      modelRequests.push(observation);
      await appendFile(
        join(directory, "model-requests.jsonl"),
        JSON.stringify({ path: req.url, body }) + "\n",
      );
      const chunk = (delta, finishReason = null) => {
        if (!res.headersSent)
          res.writeHead(200, { "content-type": "text/event-stream" });
        res.write(
          `data: ${JSON.stringify({ id: `chatcmpl-${modelRequests.length}`, object: "chat.completion.chunk", created: Math.floor(Date.now() / 1000), model: "fixture", choices: [{ index: 0, delta, finish_reason: finishReason }] })}\n\n`,
        );
      };
      const finish = (reason) => {
        chunk({}, reason);
        observation.completed = true;
        res.end("data: [DONE]\n\n");
      };
      const helpers = {
        text(text) {
          chunk({ role: "assistant", content: text });
          finish("stop");
        },
        tool(name, args, id = `call_fixture_${modelRequests.length}`) {
          chunk({
            role: "assistant",
            tool_calls: [
              {
                index: 0,
                id,
                type: "function",
                function: { name, arguments: JSON.stringify(args) },
              },
            ],
          });
          finish("tool_calls");
        },
        // Intentionally leave inference open until cancellation or fixture cleanup.
        hang(text = "Inference started.") {
          chunk({ role: "assistant", content: text });
        },
        observation,
      };
      if (onModelRequest) await onModelRequest(body, helpers);
      else helpers.text("Deterministic fixture response.");
    } catch (error) {
      res.destroy(error);
    }
  });
  const close = async () => {
    if (closed) return;
    closed = true;
    if (child?.pid && child.exitCode === null && child.signalCode === null) {
      const exited = new Promise((resolve) => child.once("exit", resolve));
      try {
        process.kill(-child.pid, "SIGTERM");
      } catch {
        /* already exited */
      }
      let timer;
      await Promise.race([
        exited,
        new Promise((resolve) => {
          timer = setTimeout(resolve, 5000);
        }),
      ]);
      clearTimeout(timer);
      if (child.exitCode === null && child.signalCode === null) {
        try {
          process.kill(-child.pid, "SIGKILL");
        } catch {
          /* already exited */
        }
        await exited;
      }
    }
    model.closeAllConnections();
    if (model.listening) await new Promise((resolve) => model.close(resolve));
    if (log !== undefined) closeSync(log);
  };
  try {
    await new Promise((resolve) => model.listen(0, "127.0.0.1", resolve));
    const reservation = http.createServer();
    await new Promise((resolve) => reservation.listen(0, "127.0.0.1", resolve));
    const port = reservation.address().port;
    await new Promise((resolve) => reservation.close(resolve));
    const config = {
      gateway: {
        mode: "local",
        bind: "loopback",
        port,
        auth: { mode: "token", token },
        http: { endpoints: { responses: { enabled: true } } },
      },
      agents: {
        defaults: {
          workspace: join(directory, "workspace"),
          model: { primary: "fixture/fixture" },
          timeoutSeconds: 20,
        },
      },
      tools: { deny: ["*"] },
      models: {
        providers: {
          fixture: {
            baseUrl: `http://127.0.0.1:${model.address().port}/v1`,
            apiKey: "fixture-only",
            api: "openai-completions",
            agentRuntime: { id: "openclaw" },
            models: [
              {
                id: "fixture",
                name: "Fixture",
                reasoning: false,
                input: ["text"],
                contextWindow: 32000,
                maxTokens: 1024,
                cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
              },
            ],
          },
        },
      },
    };
    // Research callers can exercise real auth/plugin configuration in this
    // disposable runtime without touching a personal installation.
    if (configure) await configure(config, { directory, token, port });
    await writeFile(env.OPENCLAW_CONFIG_PATH, JSON.stringify(config, null, 2), {
      mode: 0o600,
    });
    log = openSync(join(directory, "gateway.log"), "a", 0o600);
    child = spawn(binary, ["gateway", "run", "--port", String(port)], {
      env,
      stdio: ["ignore", log, log],
      detached: true,
    });
    let spawnError;
    child.on("error", (error) => {
      spawnError = error;
    });
    const baseUrl = `http://127.0.0.1:${port}`;
    let ready = false;
    for (let attempt = 0; attempt < 180; attempt++) {
      if (spawnError) throw spawnError;
      if (child.exitCode !== null)
        throw new Error(
          `OpenClaw exited ${child.exitCode}; see ${directory}/gateway.log`,
        );
      try {
        const response = await fetch(`${baseUrl}/health`, {
          signal: AbortSignal.timeout(1000),
        });
        if (response.ok) {
          ready = true;
          break;
        }
      } catch {
        /* startup */
      }
      await delay(500);
    }
    if (!ready)
      throw new Error(
        `OpenClaw startup timed out; see ${directory}/gateway.log`,
      );
    return {
      baseUrl,
      token,
      agentId: "main",
      model: "openclaw",
      directory,
      modelRequests,
      close,
      async request(
        body,
        {
          sessionKey = `agent:main:openresponses:${randomUUID()}`,
          signal,
        } = {},
      ) {
        return fetch(`${baseUrl}/v1/responses`, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            authorization: `Bearer ${token}`,
            "x-openclaw-agent-id": "main",
            "x-openclaw-session-key": sessionKey,
          },
          body: JSON.stringify({ model: "openclaw", ...body }),
          signal: signal ?? AbortSignal.timeout(30000),
        });
      },
    };
  } catch (error) {
    await close();
    throw error;
  }
}
