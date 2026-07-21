import { spawn, execFileSync, type ChildProcess } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { createServer as createNetServer, connect } from "node:net";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";

import { createGateway } from "../src/gateway.js";
import { OmnigentRuntime } from "../src/omnigent-runtime.js";

const integration =
  process.env.RUN_OMNIGENT_INTEGRATION === "1" ? describe : describe.skip;
const repositoryRoot = resolve(import.meta.dirname, "../../..");
const compat = JSON.parse(
  readFileSync(
    join(repositoryRoot, "config/omnigent-test-compat.json"),
    "utf8",
  ),
) as { version: string };
const liveGateways: ReturnType<typeof createGateway>[] = [];

afterEach(async () => {
  await Promise.all(liveGateways.splice(0).map(closeServer));
});

integration("real Omnigent with deterministic ACP", () => {
  it("completes a request-scoped MCP tool loop through the gateway", async () => {
    const result = await withIsolatedOmnigent(async (harness) => {
      return exerciseToolLoop(harness);
    });

    expect(result.value.text).toContain(result.value.nonce);
    expect(result.value.completed).toBe(true);
    expect(result.value.transcript).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: "acp.request", method: "initialize" }),
        expect.objectContaining({
          kind: "acp.request",
          method: "session/new",
        }),
        expect.objectContaining({
          kind: "acp.request",
          method: "session/prompt",
        }),
        expect.objectContaining({ kind: "mcp.request", method: "tools/list" }),
        expect.objectContaining({
          kind: "mcp.request",
          method: "tools/call",
          params: { name: "get_test_nonce", arguments: {} },
        }),
      ]),
    );
    const resultEvent = result.value.transcript.find(
      (event) => event["kind"] === "agent.tool_result",
    );
    expect(JSON.stringify(resultEvent)).toContain(result.value.nonce);
    expect(existsSync(result.root)).toBe(false);
    await expectPortClosed(result.serverPort);
    for (const processGroupId of result.processGroupIds) {
      expect(processGroupExists(processGroupId)).toBe(false);
    }
    expect(findProcessesReferencing(result.root)).toEqual([]);
    expect(result.operatorCanaryAfter).toEqual(result.operatorCanaryBefore);
  }, 120_000);

  it("cleans up isolated processes and files after a post-start failure", async () => {
    let root = "";
    let serverPort = 0;
    let reachedMcpToolCall = false;
    let activePids: number[] = [];
    let processGroupIds: number[] = [];
    let operatorCanaryBefore: Record<string, string> = {};
    await expect(
      withIsolatedOmnigent(async (harness) => {
        root = harness.root;
        serverPort = harness.serverPort;
        processGroupIds = [...harness.processGroupIds];
        operatorCanaryBefore = harness.operatorCanaryBefore;
        await exerciseToolLoop(harness, {
          onActionRequired: () => {
            reachedMcpToolCall = true;
            activePids = harness.activePids();
            throw new Error("deliberate integration cleanup probe");
          },
        });
      }),
    ).rejects.toThrow("deliberate integration cleanup probe");

    expect(root).not.toBe("");
    expect(reachedMcpToolCall).toBe(true);
    expect(activePids.length).toBeGreaterThanOrEqual(4);
    expect(existsSync(root)).toBe(false);
    await expectPortClosed(serverPort);
    for (const processGroupId of processGroupIds) {
      expect(processGroupExists(processGroupId)).toBe(false);
    }
    expect(findProcessesReferencing(root)).toEqual([]);
    expect(snapshotOperatorCanaries()).toEqual(operatorCanaryBefore);
  }, 90_000);
});

interface HarnessContext {
  readonly root: string;
  readonly serverUrl: string;
  readonly serverPort: number;
  readonly workspace: string;
  readonly transcript: string;
  readonly env: NodeJS.ProcessEnv;
  readonly processGroupIds: readonly number[];
  readonly activePids: () => number[];
  readonly serviceOutput: () => string;
  readonly operatorCanaryBefore: Record<string, string>;
}

interface HarnessResult<T> {
  readonly value: T;
  readonly root: string;
  readonly serverPort: number;
  readonly processGroupIds: readonly number[];
  readonly operatorCanaryBefore: Record<string, string>;
  readonly operatorCanaryAfter: Record<string, string>;
}

async function withIsolatedOmnigent<T>(
  operation: (context: HarnessContext) => Promise<T>,
): Promise<HarnessResult<T>> {
  const root = mkdtempSync(join(tmpdir(), "agent-connect-omnigent-"));
  const home = join(root, "home");
  const configHome = join(root, "config-home");
  const dataDir = join(root, "data");
  const cacheDir = join(root, "cache");
  const xdgConfig = join(root, "xdg-config");
  const xdgData = join(root, "xdg-data");
  const workspace = join(root, "workspace");
  const codexHome = join(root, "empty-codex-home");
  const tempDir = join(root, "tmp");
  const uvCache = join(root, "uv-cache");
  const transcript = join(root, "acp-transcript.jsonl");
  for (const directory of [
    home,
    configHome,
    dataDir,
    cacheDir,
    xdgConfig,
    xdgData,
    workspace,
    codexHome,
    tempDir,
    uvCache,
  ]) {
    mkdirSync(directory, { recursive: true, mode: 0o700 });
  }

  const operatorCanaryBefore = snapshotOperatorCanaries();
  const env: NodeJS.ProcessEnv = {
    PATH: process.env.PATH,
    LANG: process.env.LANG ?? "C.UTF-8",
    LC_ALL: process.env.LC_ALL,
    USER: process.env.USER,
    LOGNAME: process.env.LOGNAME,
    SHELL: process.env.SHELL,
    HOME: home,
    CODEX_HOME: codexHome,
    TMPDIR: tempDir,
    XDG_CACHE_HOME: cacheDir,
    XDG_CONFIG_HOME: xdgConfig,
    XDG_DATA_HOME: xdgData,
    UV_CACHE_DIR: uvCache,
    OMNIGENT_CONFIG_HOME: configHome,
    OMNIGENT_DATA_DIR: dataDir,
    OMNIGENT_RUNNER_ENV_PASSTHROUGH:
      "AGENT_CONNECT_ACP_TRANSCRIPT,CODEX_HOME,HOME,PATH,TMPDIR,UV_CACHE_DIR,XDG_CACHE_HOME,XDG_CONFIG_HOME,XDG_DATA_HOME",
    AGENT_CONNECT_ACP_TRANSCRIPT: transcript,
    NO_BROWSER: "1",
    NO_PROXY: "127.0.0.1,localhost",
    no_proxy: "127.0.0.1,localhost",
  };

  const versionOutput = execFileSync("omnigent", ["--version"], {
    env,
    encoding: "utf8",
  }).trim();
  const version = /omnigent\s+(\S+)/.exec(versionOutput)?.[1];
  if (version !== compat.version) {
    rmSync(root, { recursive: true, force: true });
    throw new Error(
      `Omnigent integration requires ${compat.version}; observed ${version ?? versionOutput}`,
    );
  }
  process.stdout.write(
    `Omnigent integration compatibility accepted: ${version}\n`,
  );

  const agentScript = join(
    repositoryRoot,
    "scripts/deterministic-acp-agent.mjs",
  );
  const configPath = join(configHome, "config.yaml");
  writeFileSync(
    configPath,
    `telemetry: false\n\nacp:\n  agents:\n    - name: Codex ACP\n      command: ${JSON.stringify(`${process.execPath} ${agentScript}`)}\n      session_id_mode: server\n`,
    { mode: 0o600 },
  );

  const serverPort = await freePort();
  const serverUrl = `http://127.0.0.1:${serverPort}`;
  const processes: LoggedProcess[] = [];
  let value!: T;
  let operationError: unknown;
  let cleanupError: unknown;
  try {
    const server = spawnLogged(
      "omnigent-server",
      "omnigent",
      [
        "server",
        "--host",
        "127.0.0.1",
        "--port",
        String(serverPort),
        "--config",
        configPath,
        "--no-open",
      ],
      env,
    );
    processes.push(server);
    await waitFor(
      "Omnigent server",
      async () => {
        const response = await fetch(`${serverUrl}/v1/hosts`).catch(
          () => undefined,
        );
        return response?.ok === true;
      },
      server,
    );

    const host = spawnLogged(
      "omnigent-host",
      "omnigent",
      ["host", "--server", serverUrl, "--non-interactive"],
      env,
    );
    processes.push(host);
    await waitFor(
      "online Omnigent host",
      async () => {
        const response = await fetch(`${serverUrl}/v1/hosts`).catch(
          () => undefined,
        );
        if (!response?.ok) return false;
        const body = (await response.json()) as {
          hosts?: Array<{ status?: string }>;
        };
        return body.hosts?.some((item) => item.status === "online") === true;
      },
      host,
    );

    value = await operation({
      root,
      serverUrl,
      serverPort,
      workspace,
      transcript,
      env,
      processGroupIds: processes.flatMap((item) =>
        item.child.pid ? [item.child.pid] : [],
      ),
      activePids: () => findProcessesReferencing(root),
      serviceOutput: () => processes.map((item) => item.output()).join("\n"),
      operatorCanaryBefore,
    });
  } catch (error) {
    operationError = error;
  } finally {
    try {
      for (const process of processes.reverse())
        await stopProcess(process.child);
      await waitUntilPortClosed(serverPort);
      await stopProcessesReferencing(root);
      const remainingPids = findProcessesReferencing(root);
      if (remainingPids.length > 0) {
        throw new Error(
          `Omnigent cleanup left processes referencing the isolated root: ${remainingPids.join(", ")}`,
        );
      }
    } catch (error) {
      cleanupError = error;
    }
  }

  let operatorCanaryAfter: Record<string, string> = {};
  try {
    operatorCanaryAfter = snapshotOperatorCanaries();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
  if (operationError !== undefined && cleanupError !== undefined) {
    throw new AggregateError(
      [operationError, cleanupError],
      "Omnigent operation and cleanup both failed",
    );
  }
  if (operationError !== undefined) throw operationError;
  if (cleanupError !== undefined) throw cleanupError;
  return {
    value,
    root,
    serverPort,
    processGroupIds: processes.flatMap((item) =>
      item.child.pid ? [item.child.pid] : [],
    ),
    operatorCanaryBefore,
    operatorCanaryAfter,
  };
}

async function exerciseToolLoop(
  harness: HarnessContext,
  options: { readonly onActionRequired?: () => void } = {},
): Promise<{
  nonce: string;
  text: string;
  completed: boolean;
  transcript: Array<Record<string, unknown>>;
}> {
  assertIsolatedEnvironment(harness);
  const runtime = new OmnigentRuntime({
    baseUrl: harness.serverUrl,
    workspace: harness.workspace,
    launchTimeoutMs: 30_000,
    pollIntervalMs: 100,
  });
  const gateway = createGateway({
    allowedOrigins: new Set(["https://integration.example"]),
    allowedTailscaleUsers: new Set(["owner@example.com"]),
    omnigentBaseUrl: harness.serverUrl,
    runtime,
    pairingCode: "PAIR-INTEGRATION",
    capabilitySigningSecret: "integration-signing-secret",
  });
  liveGateways.push(gateway);
  await new Promise<void>((resolve) => gateway.listen(0, "127.0.0.1", resolve));
  const gatewayAddress = gateway.address() as AddressInfo;
  const gatewayUrl = `http://127.0.0.1:${gatewayAddress.port}`;
  const headers = {
    Origin: "https://integration.example",
    "Tailscale-User-Login": "owner@example.com",
  };
  const tool = {
    name: "get_test_nonce",
    description: "Return an unpredictable nonce generated by the application",
    inputSchema: {
      type: "object",
      properties: {},
      additionalProperties: false,
    },
  };
  const createdResponse = await fetch(`${gatewayUrl}/v1/app-sessions`, {
    method: "POST",
    headers: {
      ...headers,
      Authorization: "Pairing PAIR-INTEGRATION",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ appId: "integration-test", tools: [tool] }),
  });
  expect(createdResponse.status).toBe(201);
  const created = (await createdResponse.json()) as {
    sessionId: string;
    accessToken: string;
  };

  const sessionUrl = `${gatewayUrl}/v1/sessions/${created.sessionId}`;
  const streamResponse = await fetch(`${sessionUrl}/stream`, {
    headers: {
      ...headers,
      Authorization: `Bearer ${created.accessToken}`,
      Accept: "text/event-stream",
    },
  });
  expect(streamResponse.status).toBe(200);
  expect(streamResponse.body).not.toBeNull();

  const postMessage = await fetch(`${sessionUrl}/events`, {
    method: "POST",
    headers: {
      ...headers,
      Authorization: `Bearer ${created.accessToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      type: "message",
      data: {
        role: "user",
        content: [{ type: "input_text", text: "Call get_test_nonce once" }],
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
  expect(postMessage.status).toBe(202);

  let nonce = "";
  let text = "";
  let completed = false;
  for await (const event of parseSse(streamResponse.body!)) {
    if (event["type"] === "response.output_text.delta") {
      text += String(event["delta"] ?? "");
    }
    if (event["type"] === "response.output_item.done") {
      const item = event["item"] as Record<string, unknown> | undefined;
      if (item?.["status"] === "action_required") {
        expect(item["name"]).toBe("get_test_nonce");
        expect(parseArguments(item["arguments"])).toEqual({});
        expect(nonce).toBe("");
        options.onActionRequired?.();
        nonce = `app-${randomUUID()}`;
        const toolResult = await fetch(`${sessionUrl}/events`, {
          method: "POST",
          headers: {
            ...headers,
            Authorization: `Bearer ${created.accessToken}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            type: "function_call_output",
            data: {
              call_id: item["call_id"],
              output: JSON.stringify({ nonce }),
            },
          }),
        });
        expect(toolResult.status).toBe(202);
      }
    }
    if (event["type"] === "response.completed") {
      completed = true;
      break;
    }
  }

  expect(nonce).not.toBe("");
  expect(text).toContain(nonce);
  expect(existsSync(join(harness.root, "data/chat.db"))).toBe(true);
  expect(existsSync(join(harness.root, "data/artifacts"))).toBe(true);
  expect(existsSync(harness.transcript)).toBe(true);
  expect(existsSync(join(harness.root, "home/.omnigent/logs"))).toBe(true);
  expect(
    existsSync(join(harness.root, "home/.omnigent/logs/host-runner")),
  ).toBe(true);
  expect(existsSync(join(harness.root, "empty-codex-home/auth.json"))).toBe(
    false,
  );
  expect(harness.activePids().length).toBeGreaterThanOrEqual(4);
  const operatorHome = process.env.HOME ?? "";
  expect(harness.serviceOutput()).not.toContain(
    join(operatorHome, ".omnigent"),
  );
  expect(harness.serviceOutput()).not.toContain(join(operatorHome, ".codex"));
  const isolatedFiles = listFiles(harness.root).map((path) =>
    relative(harness.root, path),
  );
  expect(isolatedFiles).toEqual(
    expect.arrayContaining(["data/chat.db", "acp-transcript.jsonl"]),
  );
  expect(
    isolatedFiles.some((path) =>
      path.startsWith("home/.omnigent/logs/host-runner/runner-"),
    ),
  ).toBe(true);
  const transcript = readFileSync(harness.transcript, "utf8")
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
  return { nonce, text, completed, transcript };
}

function assertIsolatedEnvironment(harness: HarnessContext): void {
  for (const name of [
    "HOME",
    "CODEX_HOME",
    "TMPDIR",
    "UV_CACHE_DIR",
    "XDG_CACHE_HOME",
    "XDG_CONFIG_HOME",
    "XDG_DATA_HOME",
    "OMNIGENT_CONFIG_HOME",
    "OMNIGENT_DATA_DIR",
    "AGENT_CONNECT_ACP_TRANSCRIPT",
  ]) {
    const value = harness.env[name];
    expect(value, `${name} must be set`).toBeTruthy();
    expect(isWithin(harness.root, value!)).toBe(true);
  }
  expect(isWithin(harness.root, harness.workspace)).toBe(true);
  const credentialKeys = Object.keys(harness.env).filter((name) =>
    /(?:OPENAI|ANTHROPIC|GEMINI|API_KEY|ACCESS_TOKEN|AUTH_TOKEN|CREDENTIAL)/i.test(
      name,
    ),
  );
  expect(credentialKeys).toEqual([]);
}

function snapshotOperatorCanaries(): Record<string, string> {
  const home = process.env.HOME ?? "";
  const paths = [
    join(home, ".omnigent/config.yaml"),
    join(home, ".omnigent/logs"),
    join(home, ".codex/auth.json"),
  ];
  return Object.fromEntries(
    paths.map((path) => {
      if (!existsSync(path)) return [path, "missing"];
      return [
        path,
        createHash("sha256").update(snapshotMetadata(path)).digest("hex"),
      ];
    }),
  );
}

function snapshotMetadata(path: string): string {
  const root = resolve(path);
  const entries: Array<Record<string, unknown>> = [];
  const visit = (current: string) => {
    const stat = statSync(current);
    entries.push({
      path: relative(root, current) || ".",
      type: stat.isDirectory() ? "directory" : "file",
      size: stat.size,
      mode: stat.mode,
      mtimeMs: stat.mtimeMs,
    });
    if (!stat.isDirectory()) return;
    for (const entry of readdirSync(current).sort()) {
      visit(join(current, entry));
    }
  };
  visit(root);
  return JSON.stringify(entries);
}

interface LoggedProcess {
  readonly child: ChildProcess;
  readonly output: () => string;
}

function spawnLogged(
  name: string,
  command: string,
  args: string[],
  env: NodeJS.ProcessEnv,
): LoggedProcess {
  const child = spawn(command, args, {
    env,
    detached: true,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  const collect = (chunk: Buffer) => {
    output = `${output}${chunk.toString("utf8")}`.slice(-16_000);
  };
  child.stdout?.on("data", collect);
  child.stderr?.on("data", collect);
  child.on("error", (error) =>
    collect(Buffer.from(`${name}: ${error.message}`)),
  );
  return { child, output: () => output };
}

async function waitFor(
  description: string,
  check: () => Promise<boolean>,
  process: LoggedProcess,
  timeoutMs = 30_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (process.child.exitCode !== null) {
      throw new Error(
        `${description} process exited (${process.child.exitCode})\n${process.output()}`,
      );
    }
    if (await check()) return;
    await delay(200);
  }
  throw new Error(`Timed out waiting for ${description}\n${process.output()}`);
}

async function stopProcess(child: ChildProcess): Promise<void> {
  if (!child.pid) return;
  const processGroupId = child.pid;
  try {
    process.kill(-processGroupId, "SIGTERM");
  } catch {
    if (child.exitCode === null) child.kill("SIGTERM");
  }
  await waitForExit(child, 5_000);
  if (!(await waitForProcessGroupExit(processGroupId, 5_000))) {
    try {
      process.kill(-processGroupId, "SIGKILL");
    } catch {
      if (child.exitCode === null) child.kill("SIGKILL");
    }
  }
  if (!(await waitForProcessGroupExit(processGroupId, 5_000))) {
    throw new Error(`Process group ${processGroupId} survived cleanup`);
  }
}

async function waitForProcessGroupExit(
  processGroupId: number,
  timeoutMs: number,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!processGroupExists(processGroupId)) return true;
    await delay(100);
  }
  return !processGroupExists(processGroupId);
}

function processGroupExists(processGroupId: number): boolean {
  try {
    process.kill(-processGroupId, 0);
    return true;
  } catch (error) {
    return !(
      error instanceof Error &&
      "code" in error &&
      (error as NodeJS.ErrnoException).code === "ESRCH"
    );
  }
}

function waitForExit(child: ChildProcess, timeoutMs: number): Promise<boolean> {
  if (child.exitCode !== null) return Promise.resolve(true);
  return new Promise((resolve) => {
    const timeout = setTimeout(() => {
      child.off("exit", onExit);
      resolve(false);
    }, timeoutMs);
    const onExit = () => {
      clearTimeout(timeout);
      resolve(true);
    };
    child.once("exit", onExit);
  });
}

function findProcessesReferencing(marker: string): number[] {
  const result: number[] = [];
  for (const entry of readdirSync("/proc")) {
    if (!/^\d+$/.test(entry)) continue;
    try {
      const environment = readFileSync(`/proc/${entry}/environ`);
      if (environment.includes(Buffer.from(marker))) result.push(Number(entry));
    } catch {
      // Processes may exit or be inaccessible while /proc is scanned.
    }
  }
  return result.sort((left, right) => left - right);
}

async function stopProcessesReferencing(marker: string): Promise<void> {
  for (const pid of findProcessesReferencing(marker)) {
    try {
      process.kill(pid, "SIGTERM");
    } catch {
      // It may have exited between the /proc scan and the signal.
    }
  }
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    if (findProcessesReferencing(marker).length === 0) return;
    await delay(100);
  }
  for (const pid of findProcessesReferencing(marker)) {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      // It may have exited between the /proc scan and the signal.
    }
  }
  await delay(100);
}

async function freePort(): Promise<number> {
  const server = createNetServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const port = (server.address() as AddressInfo).port;
  await closeServer(server);
  return port;
}

async function expectPortClosed(port: number): Promise<void> {
  expect(await canConnect(port)).toBe(false);
}

async function waitUntilPortClosed(port: number): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    if (!(await canConnect(port))) return;
    await delay(100);
  }
  throw new Error(`Omnigent server port ${port} remained open after cleanup`);
}

function canConnect(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = connect({ host: "127.0.0.1", port });
    socket.once("connect", () => {
      socket.destroy();
      resolve(true);
    });
    socket.once("error", () => resolve(false));
    socket.setTimeout(500, () => {
      socket.destroy();
      resolve(false);
    });
  });
}

async function closeServer(server: {
  close(callback: (error?: Error) => void): void;
}) {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}

async function* parseSse(
  body: ReadableStream<Uint8Array>,
): AsyncGenerator<Record<string, unknown>> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  const deadline = Date.now() + 45_000;
  try {
    while (Date.now() < deadline) {
      const read = reader.read();
      const result = await Promise.race([
        read,
        delay(45_000).then(() => {
          throw new Error("Timed out reading Omnigent SSE");
        }),
      ]);
      buffer += decoder.decode(result.value, { stream: !result.done });
      const frames = buffer.split(/\r?\n\r?\n/);
      buffer = frames.pop() ?? "";
      for (const frame of frames) {
        const data = frame
          .split(/\r?\n/)
          .filter((line) => line.startsWith("data:"))
          .map((line) => line.slice(5).trimStart())
          .join("\n");
        if (data && data !== "[DONE]") {
          yield JSON.parse(data) as Record<string, unknown>;
        }
      }
      if (result.done) return;
    }
    throw new Error("Timed out waiting for Omnigent completion");
  } finally {
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}

function parseArguments(value: unknown): unknown {
  return typeof value === "string" ? JSON.parse(value) : value;
}

function listFiles(root: string): string[] {
  const result: string[] = [];
  const visit = (directory: string) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      result.push(path);
      if (entry.isDirectory()) visit(path);
    }
  };
  visit(root);
  return result;
}

function isWithin(root: string, path: string): boolean {
  const normalizedRoot = `${resolve(root)}/`;
  const normalizedPath = resolve(path);
  return (
    normalizedPath === resolve(root) ||
    normalizedPath.startsWith(normalizedRoot)
  );
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
