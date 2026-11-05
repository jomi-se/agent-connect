// Live canary: real Codex turns through a real boxed gateway, its egress and
// the model provider. The deterministic scenarios use a mock model that the
// box reaches without the egress, so they cannot see the path out to the
// internet; this does. It spends real tokens (three short turns on the
// harness home's default model; clients cannot pick one) and needs a
// signed-in harness home, so it is opt-in and never part of CI:
//
//   ACP_LIVE_HARNESS_HOME=<a gateway's codex harness home> \
//   AGENT_CONNECT_CONTAINER_ENGINE=podman \
//   npm run verify -- test:live   # on this checkout's test box
//
// or `npm run test:live` with ACP_BOX_IMAGE naming an image that exists.
//
// Run it after anything that can change the path out: a container engine or
// OS upgrade, a new box image, a harness bump. The harness home is used in
// place, never copied: a copy would carry live credentials into scratch space.
import { engine, engineEnv } from "./container-engine.mjs";
import assert from "node:assert/strict";
import { spawn, execFile } from "node:child_process";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createServer } from "node:net";
import { randomBytes } from "node:crypto";
import { promisify } from "node:util";
import { requireBoxImage } from "./test-box-images.mjs";
import { gatewayTestBinary } from "./gateway-test-binary.mjs";

const harnessHome = process.env.ACP_LIVE_HARNESS_HOME;
if (!harnessHome)
  throw new Error(
    "ACP_LIVE_HARNESS_HOME must name a signed-in codex harness home",
  );
const boxImage = requireBoxImage();
const repo = resolve(import.meta.dirname, "..");
const exec = promisify(execFile);
const gatewayBinary = await gatewayTestBinary({
  repository: repo,
  build: () =>
    exec(process.env.CARGO ?? "cargo", ["build", "--locked", "--bins"], {
      cwd: repo,
    }),
});

const run = await mkdtemp(join(tmpdir(), "agent-connect-live-"));
const suffix = run.split("-").at(-1).toLowerCase();
const egress = `acp-live-egress-${suffix}`;
const token = randomBytes(24).toString("hex");
const origin = "https://canary.example";
const port = await new Promise((ok) => {
  const server = createServer().listen(0, "127.0.0.1", () => {
    const { port } = server.address();
    server.close(() => ok(port));
  });
});
await writeFile(join(run, "tools.json"), "[]");
await writeFile(
  join(run, "config.json"),
  JSON.stringify({ box_refresh: false }),
  { mode: 0o600 },
);

let gateway;
let model;
let gatewayLog = "";
const results = [];
try {
  gateway = spawn(
    gatewayBinary,
    [
      "serve",
      "--config",
      join(run, "config.json"),
      "--boxed",
      "--harness",
      "codex",
      "--harness-home",
      harnessHome,
      "--box-image",
      boxImage,
      "--egress-container",
      egress,
      "--codex-mode",
      "agent-full-access",
      "--state-dir",
      join(run, "state"),
      "--headless-static-bearer",
      "--token",
      token,
      "--allow-origin",
      origin,
      "--tools",
      join(run, "tools.json"),
      "--listen",
      `127.0.0.1:${port}`,
    ],
    {
      cwd: run,
      env: {
        ...engineEnv(),
        PATH: process.env.PATH,
        HOME: run,
        LANG: "C.UTF-8",
      },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  for (const stream of [gateway.stdout, gateway.stderr])
    stream.on("data", (b) => {
      gatewayLog = (gatewayLog + b).slice(-20000);
    });
  await waitFor(async () => {
    if (gateway.exitCode !== null)
      throw new Error(`gateway exited:\n${gatewayLog}`);
    await fetch(`http://127.0.0.1:${port}/`);
  }, 60_000);

  const acp = await connect(`ws://127.0.0.1:${port}/acp`);
  await acp.request(
    "initialize",
    { protocolVersion: 1, clientCapabilities: {} },
    120_000,
  );
  const session = await acp.request(
    "session/new",
    { cwd: "/", mcpServers: [] },
    120_000,
  );
  const { sessionId } = session;
  model = session.models?.currentModelId ?? "the harness default";
  results.push(`model: ${model}`);

  // 1. A real turn: the model must run a command in the box and repeat it.
  const nonce = `canary-${randomBytes(4).toString("hex")}`;
  const first = await acp.prompt(
    sessionId,
    `Run the shell command \`echo ${nonce}\` and reply with exactly its output, nothing else.`,
    300_000,
  );
  assert.equal(
    first.stopReason,
    "end_turn",
    `first turn: ${JSON.stringify(first)}`,
  );
  assert.match(
    first.text,
    new RegExp(nonce),
    `the reply lacks ${nonce}: ${first.text}`,
  );
  results.push(`turn: "${first.text.trim().slice(0, 80)}"`);

  // 2. Cancel a turn mid-reply, then the session must still answer.
  const slow = acp.prompt(
    sessionId,
    "Run the shell command `sleep 60` and then say done.",
    300_000,
  );
  await acp.waitForUpdate(sessionId, 120_000);
  acp.notify("session/cancel", { sessionId });
  const cancelled = await slow;
  assert.equal(
    cancelled.stopReason,
    "cancelled",
    `cancel: ${JSON.stringify(cancelled)}`,
  );
  results.push("cancel: cancelled");
  const again = `again-${randomBytes(4).toString("hex")}`;
  const after = await acp.prompt(
    sessionId,
    `Reply with exactly: ${again}`,
    300_000,
  );
  assert.match(after.text, new RegExp(again), `after cancel: ${after.text}`);
  results.push("after cancel: answered");
  acp.close();

  // 3. The traffic went out through this run's egress, not around it.
  const verdicts = (await exec(engine, ["logs", egress])).stdout
    .split("\n")
    .filter((line) => line.startsWith("{"))
    .map((line) => JSON.parse(line));
  const allowed = verdicts.filter((v) => v.verdict === "allow").length;
  const denied = verdicts
    .filter((v) => v.verdict === "deny")
    .map((v) => v.reason);
  assert.ok(
    allowed > 0,
    `the egress allowed nothing; denials: ${denied.join(", ")}`,
  );
  results.push(
    `egress: ${allowed} allowed, ${denied.length} denied${denied.length ? ` (${[...new Set(denied)].join(", ")})` : ""}`,
  );
} catch (error) {
  console.error(gatewayLog.slice(-6000));
  // The egress goes away with the gateway; keep what it saw.
  for (const args of [
    ["logs", egress],
    ["exec", egress, "cat", "/etc/resolv.conf"],
    [
      "inspect",
      "--format",
      "{{range $k, $v := .NetworkSettings.Networks}}{{$k}}={{$v.IPAddress}} {{end}}",
      egress,
    ],
  ])
    console.error(
      `--- ${engine} ${args.join(" ")}\n` +
        (await exec(engine, args).then(
          (r) => r.stdout + r.stderr,
          (e) => String(e),
        )),
    );
  throw error;
} finally {
  if (gateway && gateway.exitCode === null) {
    gateway.kill("SIGTERM");
    await waitFor(
      async () => assert.notEqual(gateway.exitCode, null),
      30_000,
    ).catch(() => gateway.kill("SIGKILL"));
  }
  // The gateway removes its egress on a clean stop; a crash leaves it behind.
  await exec(engine, ["rm", "-f", egress, `${egress}-keepalive`]).catch(
    () => {},
  );
  await rm(run, { recursive: true, force: true });
  for (const line of results) console.log(`  ${line}`);
}
console.log(`PASS live canary (${model})`);

async function waitFor(check, ms) {
  const end = Date.now() + ms;
  for (;;) {
    try {
      return await check();
    } catch (error) {
      if (Date.now() > end) throw error;
      await new Promise((ok) => setTimeout(ok, 250));
    }
  }
}

// A minimal ACP client: the gateway's plain WebSocket transport, answering
// the agent's own requests the way a cautious application would.
async function connect(url) {
  const socket = new WebSocket(url, {
    protocols: ["acp.v1", `bearer.${token}`],
    headers: { Origin: origin },
  });
  await new Promise((ok, fail) => {
    socket.addEventListener("open", ok, { once: true });
    socket.addEventListener(
      "error",
      () => fail(new Error(`cannot open ${url}`)),
      { once: true },
    );
  });
  let next = 0;
  const pending = new Map();
  const turns = new Map();
  const updateWaiters = [];
  socket.addEventListener("message", ({ data }) => {
    const message = JSON.parse(data);
    if (message.id !== undefined && !message.method) {
      const entry = pending.get(message.id);
      pending.delete(message.id);
      if (message.error) entry?.fail(new Error(JSON.stringify(message.error)));
      else entry?.ok(message.result);
      return;
    }
    if (message.method === "session/update") {
      const { sessionId, update } = message.params;
      const turn = turns.get(sessionId);
      if (turn && update.sessionUpdate === "agent_message_chunk")
        turn.text += update.content?.text ?? "";
      if (
        ["agent_message_chunk", "tool_call", "agent_thought_chunk"].includes(
          update.sessionUpdate,
        )
      )
        updateWaiters.splice(0).forEach((ok) => ok());
      return;
    }
    if (message.id !== undefined) {
      // Grant shell permission once, refuse everything else.
      let result;
      if (message.method === "session/request_permission") {
        const allow = message.params.options?.find((o) =>
          o.kind?.startsWith("allow"),
        );
        result = {
          outcome: allow
            ? { outcome: "selected", optionId: allow.optionId }
            : { outcome: "cancelled" },
        };
      }
      socket.send(
        JSON.stringify(
          result
            ? { jsonrpc: "2.0", id: message.id, result }
            : {
                jsonrpc: "2.0",
                id: message.id,
                error: { code: -32601, message: "not offered" },
              },
        ),
      );
    }
  });
  const request = (method, params, ms) =>
    new Promise((ok, fail) => {
      const id = ++next;
      const timer = setTimeout(
        () => fail(new Error(`${method} timed out`)),
        ms,
      );
      pending.set(id, {
        ok: (v) => (clearTimeout(timer), ok(v)),
        fail: (e) => (clearTimeout(timer), fail(e)),
      });
      socket.send(JSON.stringify({ jsonrpc: "2.0", id, method, params }));
    });
  return {
    request,
    notify: (method, params) =>
      socket.send(JSON.stringify({ jsonrpc: "2.0", method, params })),
    async prompt(sessionId, text, ms) {
      const turn = { text: "" };
      turns.set(sessionId, turn);
      const result = await request(
        "session/prompt",
        { sessionId, prompt: [{ type: "text", text }] },
        ms,
      );
      return { ...result, text: turn.text };
    },
    waitForUpdate: (sessionId, ms) =>
      new Promise((ok, fail) => {
        const timer = setTimeout(
          () => fail(new Error("no update before cancel")),
          ms,
        );
        updateWaiters.push(() => (clearTimeout(timer), ok()));
      }),
    close: () => socket.close(),
  };
}
