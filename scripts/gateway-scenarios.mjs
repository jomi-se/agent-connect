import { engine, engineEnv, ownerIdentity } from "./container-engine.mjs";
import { seedCodexMock } from "../deploy/gateway/test/fixtures/seed-codex.mjs";
// Deterministic compatibility gate: real gateway, pinned adapters and Chromium.
// Every process and home belongs to this run; no personal harness state is used.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import {
  mkdtemp,
  mkdir,
  writeFile,
  copyFile,
  readFile,
} from "node:fs/promises";
import { tmpdir, homedir } from "node:os";
import { resolve, join } from "node:path";
import { createServer } from "node:http";
import { createServer as tcpServer } from "node:net";
import {
  pruneTestInstallations,
  runCleanupTasks,
  stopFixtureChild,
} from "./test-fixture-cleanup.mjs";
import { requireBoxImage } from "./test-box-images.mjs";
import { gatewayTestBinary } from "./gateway-test-binary.mjs";

const boxImage = requireBoxImage();
const repo = resolve(import.meta.dirname, "..");
const gatewayBinary = await gatewayTestBinary({
  repository: repo,
  build: () =>
    command(process.env.CARGO ?? "cargo", ["build", "--locked", "--bins"]),
});
const fixtures = join(repo, "deploy/gateway/test/fixtures");
const run = await mkdtemp(join(tmpdir(), "agent-connect-acp-"));
const children = new Set();
const dockerContainers = [];
const dockerNetworks = [];
const boxed = process.env.ACP_BOXED === "1";
let mockContainer, egressContainer;
// CI's Docker is rootful, which a boxed serve refuses unless the
// configuration accepts it; the rest of the gateway comes from flags.
const serveConfig = join(run, "serve-config.json");
await writeFile(
  serveConfig,
  JSON.stringify({ allow_rootful_engine: true, box_refresh: false }),
  { mode: 0o600 },
);
const cleanEnv = {
  ...engineEnv(),
  PATH: process.env.PATH,
  HOME: run,
  LANG: "C.UTF-8",
  PLAYWRIGHT_BROWSERS_PATH:
    process.env.PLAYWRIGHT_BROWSERS_PATH ??
    join(homedir(), ".cache/ms-playwright"),
  CARGO_HOME: process.env.CARGO_HOME,
  RUSTUP_HOME: process.env.RUSTUP_HOME,
};
// Build tools need their existing cache, never harness homes.
async function command(bin, args, options = {}) {
  const child = spawn(bin, args, {
    cwd: repo,
    ...options,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  child.stdout.on("data", (b) => {
    output += b;
  });
  child.stderr.on("data", (b) => {
    output += b;
  });
  return await new Promise((ok, fail) => {
    child.on("error", fail);
    child.on("exit", (code) =>
      code === 0
        ? ok(output)
        : fail(new Error(`${bin} exited ${code}\n${output.slice(-6000)}`)),
    );
  });
}
function service(bin, args, env) {
  const child = spawn(bin, args, {
    cwd: run,
    env,
    detached: true,
    stdio: ["ignore", "ignore", "pipe"],
  });
  children.add(child);
  let tail = "";
  child.stderr.on("data", (b) => {
    tail = (tail + b).slice(-6000);
  });
  child.on("error", (e) => {
    tail += String(e);
  });
  child.tail = () => tail;
  return child;
}
async function stop(child) {
  await stopFixtureChild(child, {
    signal: (signal) => process.kill(-child.pid, signal),
    graceMs: 3000,
  });
  children.delete(child);
}
async function port() {
  const server = tcpServer();
  await new Promise((ok) => server.listen(0, "127.0.0.1", ok));
  const value = server.address().port;
  await new Promise((ok) => server.close(ok));
  return value;
}
async function ready(url, child) {
  for (let i = 0; i < 100; i++) {
    if (child?.exitCode !== null && child?.exitCode !== undefined)
      throw new Error(child.tail());
    try {
      await fetch(url);
      return;
    } catch {}
    await new Promise((ok) => setTimeout(ok, 100));
  }
  throw new Error(`Service did not start: ${url}\n${child?.tail() ?? ""}`);
}
const pageServer = createServer(async (req, res) => {
  try {
    const path = new URL(req.url, "http://localhost").pathname;
    if (path.includes("..")) throw new Error("bad path");
    const data = await readFile(
      join(run, "web", path === "/" ? "index.html" : path),
    );
    res.setHeader(
      "Content-Type",
      path.endsWith(".js") ? "text/javascript" : "text/html",
    );
    res.end(data);
  } catch {
    res.writeHead(404).end();
  }
});
try {
  await command("node", ["--test", join(repo, "scripts/gateway-cli.test.mjs")]);
  for (const name of ["adapters", "web"]) {
    await mkdir(join(run, name));
    for (const file of ["package.json", "package-lock.json"])
      await copyFile(join(fixtures, name, file), join(run, name, file));
    await command(
      "npm",
      [
        "ci",
        "--ignore-scripts",
        "--no-audit",
        "--no-fund",
        "--cache",
        join(tmpdir(), "agent-connect-npm-cache"),
      ],
      { cwd: join(run, name) },
    );
  }
  for (const file of ["app.js", "tools.json", "index.html"])
    await copyFile(join(fixtures, "web", file), join(run, "web", file));
  await command("npm", [
    "run",
    "build",
    "--workspace",
    "@open-agent-connect/web",
  ]);
  await command(join(run, "web/node_modules/.bin/esbuild"), [
    join(fixtures, "web/app.js"),
    "--bundle",
    "--format=esm",
    "--platform=browser",
    `--outfile=${join(run, "web/dist/app.js")}`,
  ]);
  await mkdir(join(run, ".run/codex-home"), { recursive: true });
  await mkdir(join(run, ".run/claude-config"), { recursive: true });
  await mkdir(join(run, ".run/browser"), { recursive: true });
  const mockPort = await port();
  const mockUrl = `http://127.0.0.1:${mockPort}`;
  await writeFile(
    join(run, ".run/codex-home/config.toml"),
    `model = "mock-model"\nmodel_provider = "mock"\napproval_policy = "never"\n[model_providers.mock]\nname = "Deterministic compatibility fixture"\nbase_url = "${mockUrl}/v1"\nwire_api = "responses"\nrequires_openai_auth = false\n`,
  );
  const model = service("node", [join(fixtures, "mock-model/server.mjs")], {
    ...cleanEnv,
    MOCK_PORT: String(mockPort),
    MOCK_LOG: join(run, "model.jsonl"),
  });
  await ready(mockUrl, model);
  await new Promise((ok) => pageServer.listen(0, "127.0.0.1", ok));
  const origin = `http://127.0.0.1:${pageServer.address().port}`;
  if (boxed) {
    await command("node", [
      "--test",
      join(repo, "deploy/gateway/test/egress-proxy.test.mjs"),
    ]);
    await command(engine, ["image", "inspect", boxImage]);
    await command(
      "node",
      ["--test", join(repo, "deploy/gateway/test/box.test.mjs")],
      { env: { ...cleanEnv, ACP_BOX_IMAGE: boxImage } },
    );
    const suffix = run.split("-").at(-1).toLowerCase();
    mockContainer = `acp-test-model-${suffix}`;
    egressContainer = `acp-test-egress-${suffix}`;
    await mkdir(join(run, "box-logs"));
    const modelNetwork = `${mockContainer}-base`;
    dockerNetworks.push(modelNetwork);
    await command(engine, ["network", "create", "--internal", modelNetwork]);
    const uid = `${process.getuid()}:${process.getgid()}`;
    dockerContainers.push(mockContainer);
    await command(engine, [
      "run",
      "-d",
      "--name",
      mockContainer,
      "--network",
      modelNetwork,
      ...ownerIdentity(uid),
      "-v",
      `${join(fixtures, "mock-model")}:/app:ro`,
      "-v",
      `${join(run, "box-logs")}:/log`,
      "-e",
      "MOCK_HOST=0.0.0.0",
      "-e",
      "MOCK_PORT=18931",
      "-e",
      "MOCK_LOG=/log/model.jsonl",
      "node:24-bookworm",
      "node",
      "/app/server.mjs",
    ]);
  }
  for (const harness of ["codex", "claude"]) {
    const harnessHome = join(run, `boxed-home-${harness}`);
    if (boxed) {
      await mkdir(harnessHome, { mode: 0o700 });
      if (harness === "codex") await seedCodexMock(harnessHome, run);
    }
    for (const [mobile, scenario] of [
      [false, "tools"],
      [false, "policy"],
      [false, "use-chat"],
      [false, "shell"],
      [false, "ask"],
      [false, "cancel"],
      [false, "resume"],
      [false, "load-foreign"],
      [false, "bad-token"],
      [false, "bad-origin"],
      ...[
        "slow-cut",
        "ask-cut",
        "lateask-cut",
        "answer-halfopen",
        "halfopen-stream",
        "expire",
        "overflow",
        "takeover",
        "discard",
      ].map((s) => [true, s]),
    ]) {
      if (!boxed && scenario === "shell") continue;
      if (
        process.env.ACP_SCENARIOS &&
        !process.env.ACP_SCENARIOS.split(",").includes(scenario)
      )
        continue;
      const gatewayPort = await port();
      const gateway = service(
        gatewayBinary,
        [
          "serve",
          ...(boxed
            ? [
                "--config",
                serveConfig,
                "--boxed",
                "--harness-home",
                harnessHome,
                "--box-image",
                boxImage,
                "--egress-container",
                egressContainer,
                "--mock-container",
                mockContainer,
              ]
            : []),
          "--mock-root",
          run,
          "--state-dir",
          join(run, ".run/state"),
          "--codex-mode",
          boxed ? "agent-full-access" : "workspace-write",
          "--headless-static-bearer",
          "--token",
          "spike-dev-token",
          "--harness",
          harness,
          "--listen",
          `127.0.0.1:${gatewayPort}`,
          "--allow-origin",
          origin,
          "--tools",
          join(fixtures, "web/tools.json"),
          "--mock-url",
          `${mockUrl}/v1`,
          "--max-sessions",
          "2",
          "--resume-grace-secs",
          scenario === "expire" ? "5" : "60",
          "--resume-max-bytes",
          scenario === "overflow" ? "3000" : "8388608",
        ],
        { ...cleanEnv, AGENT_CONNECT_TEST_ROOT: run },
      );
      await ready(`http://127.0.0.1:${gatewayPort}`, gateway);
      const relayPort = await port(),
        controlPort = await port();
      const relay = mobile
        ? service("node", [join(fixtures, "web/relay.mjs")], {
            ...cleanEnv,
            RELAY_LISTEN: String(relayPort),
            RELAY_TARGET: String(gatewayPort),
            RELAY_CONTROL: String(controlPort),
          })
        : null;
      if (relay) await ready(`http://127.0.0.1:${controlPort}/stats`, relay);
      const label = `${harness}-${scenario}`;
      const output = await command(
        "node",
        [
          scenario === "policy"
            ? join(repo, "scripts/policy-browser.mjs")
            : join(
                fixtures,
                "web",
                scenario === "use-chat"
                  ? "drive-use-chat.mjs"
                  : mobile
                    ? "drive-mobile.mjs"
                    : "drive.mjs",
              ),
          scenario,
          label,
        ],
        {
          cwd: join(run, ".run"),
          env: {
            ...cleanEnv,
            ACP_REPORT_DIR: join(run, ".run/browser"),
            ACP_HARNESS: harness,
            PAGE_ORIGIN: `${origin}/?gateway=ws://127.0.0.1:${mobile ? relayPort : gatewayPort}/acp${mobile ? "" : "&resume=0"}`,
            RELAY_CONTROL: `http://127.0.0.1:${controlPort}`,
            AWAY_MS: "10000",
            ASK_WAIT_MS: "50",
          },
        },
      );
      const report = JSON.parse(output);
      assert.equal(
        report.error,
        undefined,
        `${label}: ${report.error}\n${gateway.tail()}`,
      );
      if (["bad-token", "bad-origin", "load-foreign"].includes(scenario))
        assert.match(report.status, /^error/);
      else if (["expire", "overflow"].includes(scenario))
        assert.equal(report.status, "recovered:interrupted");
      else if (scenario === "takeover") {
        assert.equal(report.wrongResume.code, 4404);
        assert.equal(report.rightToken.open, true);
        assert.equal(report.firstPage.ended, "superseded");
      } else
        assert.match(
          report.status,
          /^done:/,
          `${label}: ${JSON.stringify(report)}\n${gateway.tail()}`,
        );
      if (scenario === "policy") {
        assert.equal(report.oversizedInitialCode, 1009);
        assert.equal(report.denied["session/set_mode"], -32601);
        assert.equal(report.denied["session/set_config_option"], -32601);
        assert.deepEqual(report.connects, ["policy-app"]);
        assert.ok(report.listCalls > 0, "real adapter must request tools/list");
        assert.match(report.answer, /MISSING-TOOLS read=true highlight=false/);
        assert.deepEqual(report.toolCalls, []);
        assert.equal(report.evictedCode, 4415);
        assert.equal(report.secondClientStopReason, "end_turn");
      }
      if (scenario === "cancel") assert.equal(report.status, "done:cancelled");
      if (scenario === "shell") {
        assert.match(report.answer, /native-42/);
        if (boxed) assert.match(report.answer, /work/);
      }
      if (["tools", "discard"].includes(scenario))
        assert.ok(
          report.marked.length > 0,
          `${label} marked nothing: ${JSON.stringify(report)}\n${gateway.tail()}`,
        );
      if (["slow-cut", "halfopen-stream"].includes(scenario))
        assert.equal(report.answerExact, true);
      if (["ask-cut", "lateask-cut", "answer-halfopen"].includes(scenario))
        assert.equal(report.toolCounts.ask_reader, 1);
      console.log(`PASS ACP ${label}`);
      await stop(relay);
      await stop(gateway);
    }
  }
} catch (error) {
  for (const name of dockerContainers)
    console.error(
      (await command(engine, ["logs", name]).catch(String)).slice(-3000),
    );
  // A cleanup failure below replaces this error; print it first.
  console.error(error);
  throw error;
} finally {
  const failures = [];
  async function attemptAll(tasks) {
    await runCleanupTasks(tasks).catch((error) => {
      failures.push(
        ...(error instanceof AggregateError ? error.errors : [error]),
      );
    });
  }
  // Independent shutdown must finish even when one child cannot be stopped.
  await attemptAll([
    ...[...children].map((child) => () => stop(child)),
    () =>
      new Promise((ok, fail) => {
        pageServer.close((error) =>
          error && error.code !== "ERR_SERVER_NOT_RUNNING" ? fail(error) : ok(),
        );
        // A failed browser child may still hold an active HTTP connection.
        pageServer.closeAllConnections();
      }),
  ]);
  await attemptAll(
    dockerContainers.map((name) => () => command(engine, ["rm", "-f", name])),
  );
  // Each gateway removes its egress when it stops; one that crashed does not.
  if (egressContainer)
    await command(engine, [
      "rm",
      "-f",
      egressContainer,
      `${egressContainer}-keepalive`,
    ]).catch(() => {});
  // Container removal must settle before attempting the owned networks.
  await attemptAll(
    dockerNetworks.map(
      (name) => () => command(engine, ["network", "rm", name]),
    ),
  );
  // Never delete files that an unconfirmed child may still be using.
  if (!failures.length)
    await pruneTestInstallations(run).catch((error) => failures.push(error));
  console.log(`ACP diagnostics: ${run}`);
  if (failures.length)
    throw new AggregateError(
      failures,
      `Scenario cleanup failed; diagnostics retained at ${run}`,
    );
}
