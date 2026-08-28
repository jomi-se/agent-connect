import { spawn, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
} from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";

const integration =
  process.env.RUN_RESPONSE_CRASH_INTEGRATION === "1" ? describe : describe.skip;
const repositoryRoot = resolve(import.meta.dirname, "../../..");
const fixture = join(
  repositoryRoot,
  "packages/gateway/test/fixtures/response-crash-gateway.mjs",
);
const roots: string[] = [];
const children: ChildProcess[] = [];

afterEach(async () => {
  await Promise.all(children.splice(0).map(stopChild));
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

const tools = [
  {
    type: "function",
    name: "get_test_nonce",
    description: "Return a deterministic test nonce",
    parameters: {
      type: "object",
      properties: {},
      additionalProperties: false,
    },
  },
  {
    type: "function",
    name: "confirm_test_nonce",
    description: "Confirm the deterministic test nonce",
    parameters: {
      type: "object",
      properties: {},
      additionalProperties: false,
    },
  },
] as const;

interface CrashScenario {
  readonly point:
    | "after_output_persistence_before_post"
    | "after_post_before_acknowledgement"
    | "after_ack_before_local_transition"
    | "after_provider_next_item";
  readonly expectedResult:
    "output_recorded" | "delivery_attempted" | "provider_observed";
  readonly providerPhases: readonly string[];
}

const scenarios: readonly CrashScenario[] = [
  {
    point: "after_output_persistence_before_post",
    expectedResult: "output_recorded",
    providerPhases: [],
  },
  {
    point: "after_post_before_acknowledgement",
    expectedResult: "output_recorded",
    providerPhases: ["received"],
  },
  {
    point: "after_ack_before_local_transition",
    expectedResult: "output_recorded",
    providerPhases: ["received", "acknowledged"],
  },
  {
    point: "after_provider_next_item",
    expectedResult: "provider_observed",
    providerPhases: ["received", "acknowledged"],
  },
];

integration("response durability across real gateway process death", () => {
  for (const scenario of scenarios) {
    it(`reconstructs safely at ${scenario.point}`, async () => {
      const root = mkdtempSync(join(tmpdir(), "agent-connect-crash-"));
      roots.push(root);
      const port = await freePort();
      const first = await startGateway(root, port, scenario.point);
      const gatewayUrl = `http://127.0.0.1:${port}`;
      const capability = await authorizeApplication(gatewayUrl);
      const headers = responseHeaders(capability);

      const initial = await collectResponse(
        fetch(`${gatewayUrl}/v1/responses`, {
          method: "POST",
          headers: { ...headers, "Content-Type": "application/json" },
          body: JSON.stringify({
            model: "agent-connect/default",
            stream: true,
            input: "Run the two-step durability fixture",
            tools,
          }),
        }),
      );
      const responseId = responseIdOf(initial);
      const callId = functionCallOf(initial).call_id as string;

      // This request deliberately remains open at the selected boundary. The
      // fixture writes its marker only after reaching that exact state.
      const continuation = fetch(`${gatewayUrl}/v1/responses`, {
        method: "POST",
        headers: { ...headers, "Content-Type": "application/json" },
        body: JSON.stringify({
          model: "agent-connect/default",
          stream: true,
          previous_response_id: responseId,
          input: [
            {
              type: "function_call_output",
              call_id: callId,
              output: JSON.stringify({ nonce: "durable-nonce" }),
            },
          ],
        }),
      });
      void continuation.catch(() => undefined);

      const marker = join(root, "checkpoint.json");
      await waitForFile(marker, first);
      const reached = JSON.parse(readFileSync(marker, "utf8")) as {
        point: string;
      };
      expect(reached.point).toBe(scenario.point);

      await killChild(first);
      const beforeRestart = readDurableChain(root);
      const originalCall = beforeRestart.calls[callId];
      expect(originalCall?.result).toBe(scenario.expectedResult);
      expect(
        Object.values(beforeRestart.calls).filter(
          (call) => call.name === "confirm_test_nonce",
        ),
      ).toHaveLength(0);
      expect(readProviderPhases(root)).toEqual(scenario.providerPhases);

      const restarted = await startGateway(root, port, "none");
      const recovered = await fetch(
        `${gatewayUrl}/v1/agent-connect/responses/${responseId}`,
        { headers },
      );
      expect(recovered.status).toBe(200);
      expect(await recovered.json()).toMatchObject({
        chain_status: "terminal",
        recovery: "interrupted",
      });
      const pending = await fetch(
        `${gatewayUrl}/v1/agent-connect/responses/${responseId}/pending-function-calls`,
        { headers },
      );
      expect(pending.status).toBe(200);
      expect(await pending.json()).toMatchObject({
        pending_function_calls: [],
      });
      await stopChild(restarted);

      const afterRestart = readDurableChain(root);
      expect(afterRestart.chain.status).toBe("terminal");
      expect(afterRestart.chain.terminalError?.code).toBe(
        "backend_unavailable",
      );
      expect(
        readdirSync(join(root, "responses")).filter((name) =>
          name.endsWith(".tmp"),
        ),
      ).toEqual([]);
    }, 30_000);
  }
});

interface RunningChild {
  readonly child: ChildProcess;
  readonly output: () => string;
}

async function startGateway(
  root: string,
  port: number,
  point: CrashScenario["point"] | "none",
): Promise<RunningChild> {
  const child = spawn(process.execPath, [fixture], {
    cwd: repositoryRoot,
    env: {
      ...process.env,
      CRASH_FIXTURE_ROOT: root,
      CRASH_FIXTURE_PORT: String(port),
      CRASH_FIXTURE_POINT: point,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  children.push(child);
  let output = "";
  const collect = (chunk: Buffer) => {
    output = `${output}${chunk.toString("utf8")}`.slice(-12_000);
  };
  child.stdout?.on("data", collect);
  child.stderr?.on("data", collect);
  const running = { child, output: () => output };
  await waitForHealth(`http://127.0.0.1:${port}`, running);
  return running;
}

async function authorizeApplication(gatewayUrl: string): Promise<string> {
  const headers = {
    Origin: "https://integration.example",
    "Tailscale-User-Login": "owner@example.com",
  };
  const verifier = "v".repeat(43);
  const requested = await fetch(`${gatewayUrl}/v1/authorization-requests`, {
    method: "POST",
    headers: { ...headers, "Content-Type": "application/json" },
    body: JSON.stringify({
      appId: "crash-test",
      redirectUri: "https://integration.example/oauth/callback",
      state: "integration_state",
      codeChallenge: createHash("sha256").update(verifier).digest("base64url"),
      scopes: ["agent:prompt", "agent:result", "tools:invoke"],
      tools: tools.map((tool) => ({
        name: tool.name,
        description: tool.description,
        inputSchema: tool.parameters,
      })),
    }),
  });
  const requestedBody = (await requested.json()) as {
    requestId?: string;
    error?: unknown;
  };
  expect(requested.status, JSON.stringify(requestedBody)).toBe(201);
  const requestId = requestedBody.requestId ?? "";
  const approved = await fetch(`${gatewayUrl}/authorize`, {
    method: "POST",
    redirect: "manual",
    headers: {
      "Tailscale-User-Login": "owner@example.com",
      Origin: "https://integration-runtime.example",
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({
      request: requestId,
      decision: "approve",
      passphrase: "integration enrollment phrase",
    }),
  });
  expect(approved.status).toBe(303);
  const code = new URL(approved.headers.get("location") ?? "").searchParams.get(
    "code",
  );
  const exchanged = await fetch(`${gatewayUrl}/oauth/token`, {
    method: "POST",
    headers: { ...headers, "Content-Type": "application/json" },
    body: JSON.stringify({
      code,
      codeVerifier: verifier,
      appId: "crash-test",
      redirectUri: "https://integration.example/oauth/callback",
    }),
  });
  expect(exchanged.status).toBe(200);
  const grant = (await exchanged.json()) as { accessToken: string };
  const session = await fetch(`${gatewayUrl}/v1/app-sessions`, {
    method: "POST",
    headers: {
      ...headers,
      Authorization: `Bearer ${grant.accessToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      appId: "crash-test",
      tools: tools.map((tool) => ({
        name: tool.name,
        description: tool.description,
        inputSchema: tool.parameters,
      })),
    }),
  });
  expect(session.status).toBe(201);
  return ((await session.json()) as { accessToken: string }).accessToken;
}

function responseHeaders(capability: string) {
  return {
    Origin: "https://integration.example",
    "Tailscale-User-Login": "owner@example.com",
    Authorization: `Bearer ${capability}`,
  };
}

async function collectResponse(
  responsePromise: Promise<Response>,
): Promise<Record<string, unknown>[]> {
  const response = await responsePromise;
  expect(response.status).toBe(200);
  expect(response.body).not.toBeNull();
  const events: Record<string, unknown>[] = [];
  for await (const event of parseSse(response.body!)) {
    events.push(event);
    if (event["type"] === "response.completed") break;
  }
  return events;
}

async function* parseSse(
  stream: ReadableStream<Uint8Array>,
): AsyncGenerator<Record<string, unknown>> {
  const decoder = new TextDecoder();
  let buffer = "";
  for await (const chunk of stream) {
    buffer += decoder.decode(chunk, { stream: true });
    for (;;) {
      const boundary = buffer.indexOf("\n\n");
      if (boundary < 0) break;
      const block = buffer.slice(0, boundary);
      buffer = buffer.slice(boundary + 2);
      const data = block
        .split("\n")
        .filter((line) => line.startsWith("data: "))
        .map((line) => line.slice(6))
        .join("\n");
      if (data && data !== "[DONE]") {
        yield JSON.parse(data) as Record<string, unknown>;
      }
    }
  }
}

function responseIdOf(events: readonly Record<string, unknown>[]): string {
  const created = events.find((event) => event["type"] === "response.created");
  return String(
    (created?.["response"] as Record<string, unknown> | undefined)?.["id"],
  );
}

function functionCallOf(
  events: readonly Record<string, unknown>[],
): Record<string, unknown> {
  for (const event of events) {
    if (event["type"] !== "response.output_item.done") continue;
    const item = event["item"] as Record<string, unknown> | undefined;
    if (item?.["type"] === "function_call") return item;
  }
  throw new Error("the response produced no function call");
}

function readDurableChain(root: string): {
  chain: { status: string; terminalError?: { code?: string } | null };
  calls: Record<string, { name: string; result: string }>;
} {
  const directory = join(root, "responses");
  const file = readdirSync(directory).find((name) => name.endsWith(".json"));
  if (!file) throw new Error("no durable chain file was written");
  return JSON.parse(readFileSync(join(directory, file), "utf8")) as {
    chain: { status: string; terminalError?: { code?: string } | null };
    calls: Record<string, { name: string; result: string }>;
  };
}

function readProviderPhases(root: string): string[] {
  const path = join(root, "provider-ledger.jsonl");
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8")
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => (JSON.parse(line) as { phase: string }).phase);
}

async function waitForHealth(
  gatewayUrl: string,
  process: RunningChild,
): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    if (process.child.exitCode !== null) {
      throw new Error(`gateway fixture exited\n${process.output()}`);
    }
    const response = await fetch(`${gatewayUrl}/healthz`).catch(
      () => undefined,
    );
    if (response?.ok) return;
    await delay(50);
  }
  throw new Error(`gateway fixture did not become ready\n${process.output()}`);
}

async function waitForFile(path: string, process: RunningChild): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    if (existsSync(path)) return;
    if (process.child.exitCode !== null) {
      throw new Error(`gateway fixture exited\n${process.output()}`);
    }
    await delay(25);
  }
  throw new Error(`gateway fixture missed its checkpoint\n${process.output()}`);
}

async function killChild(process: RunningChild): Promise<void> {
  if (
    process.child.exitCode !== null ||
    process.child.signalCode !== null ||
    !process.child.pid
  )
    return;
  process.child.kill("SIGKILL");
  await waitForExit(process.child);
}

async function stopChild(process: RunningChild | ChildProcess): Promise<void> {
  const child = "child" in process ? process.child : process;
  if (child.exitCode !== null || child.signalCode !== null || !child.pid)
    return;
  child.kill("SIGTERM");
  await waitForExit(child);
}

function waitForExit(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null)
    return Promise.resolve();
  return new Promise((resolve) => child.once("exit", () => resolve()));
}

async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolvePromise, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolvePromise);
  });
  const port = (server.address() as AddressInfo).port;
  await new Promise<void>((resolvePromise, reject) =>
    server.close((error) => (error ? reject(error) : resolvePromise())),
  );
  return port;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, ms));
}
