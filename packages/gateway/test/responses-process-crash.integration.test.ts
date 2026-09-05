import { fork, type ChildProcess } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { once } from "node:events";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  startOpenClawTestRuntime,
  type OpenClawTestRuntime,
} from "../../../scripts/openclaw-test-runtime.mjs";
import {
  authorize,
  createSession,
  headers,
  post,
} from "./support/gateway-client.js";

const integration =
  process.env.RUN_OPENCLAW_INTEGRATION === "1" ? describe : describe.skip;
let runtime: OpenClawTestRuntime;
const children: ChildProcess[] = [];
const roots: string[] = [];
async function start(directory: string, crashAt?: string) {
  const child = fork(
    new URL("./fixtures/response-crash-gateway.mjs", import.meta.url),
    { stdio: ["ignore", "pipe", "pipe", "ipc"] },
  );
  children.push(child);
  const ready = new Promise<string>((resolve, reject) => {
    child.once("message", (message) =>
      resolve((message as { baseUrl: string }).baseUrl),
    );
    child.once("exit", (code) =>
      reject(new Error(`gateway exited before ready: ${code}`)),
    );
    child.once("error", reject);
  });
  child.send({
    directory,
    crashAt,
    baseUrl: runtime.baseUrl,
    token: runtime.token,
    agentId: runtime.agentId,
  });
  return { child, baseUrl: await ready };
}
integration("real process crash boundaries with real OpenClaw", () => {
  beforeAll(async () => {
    runtime = await startOpenClawTestRuntime({
      onModelRequest(_body, inference) {
        inference.tool("set_page_message", { message: "durable" });
      },
    });
  }, 120_000);
  afterAll(async () => {
    for (const child of children)
      if (child.exitCode === null && child.signalCode === null) {
        const exited = once(child, "exit");
        child.kill("SIGKILL");
        await exited;
      }
    await runtime?.close();
    for (const root of roots) rmSync(root, { recursive: true, force: true });
  }, 30_000);
  it.each(["recorded", "delivery_attempted"])(
    "does not redrive after a crash at %s",
    async (crashAt) => {
      const directory = mkdtempSync(join(tmpdir(), "ac-openclaw-crash-"));
      roots.push(directory);
      const first = await start(directory, crashAt);
      const grant = await authorize(first.baseUrl);
      const session = await createSession(first.baseUrl, grant);
      const exited = once(first.child, "exit");
      const initial = await post(first.baseUrl, session.accessToken, {
        input: "request tool",
        stream: true,
      });
      let initialText = "";
      try {
        initialText = await initial.text();
      } catch {
        /* expected abrupt process loss before publication */
      }
      let priorId: string | undefined;
      let callId: string | undefined;
      if (crashAt === "delivery_attempted") {
        const terminal = initialText
          .split("\n")
          .filter(
            (line) =>
              line.startsWith("data: ") && line.slice(6).trim() !== "[DONE]",
          )
          .map((line) => JSON.parse(line.slice(6)))
          .find((event) => event.type === "response.completed");
        priorId = terminal.response.id;
        callId = terminal.response.output.find(
          (item: { type: string }) => item.type === "function_call",
        ).call_id;
        await post(first.baseUrl, session.accessToken, {
          previous_response_id: priorId,
          input: [
            {
              type: "function_call_output",
              call_id: callId,
              output: "never automatically repeat",
            },
          ],
          stream: true,
        })
          .then((r) => r.text())
          .catch(() => undefined);
      }
      expect((await exited)[0]).toBe(86);
      const ledgers = readdirSync(join(directory, "responses"))
        .filter((n) => n.endsWith(".json"))
        .map((n) =>
          JSON.parse(readFileSync(join(directory, "responses", n), "utf8")),
        );
      const call = ledgers.flatMap((ledger) =>
        Object.values(ledger.calls),
      )[0] as { responseId: string; callId: string; result: string };
      expect(call).toBeDefined();
      priorId ??= call.responseId;
      callId ??= call.callId;
      if (crashAt === "delivery_attempted")
        expect(call.result).toBe("delivery_attempted");
      const count = runtime.modelRequests.length;
      const restarted = await start(directory);
      const pending = await fetch(
        `${restarted.baseUrl}/v1/agent-connect/responses/${priorId}/pending-function-calls`,
        { headers: headers(session.accessToken) },
      );
      expect(pending.status).toBe(200);
      expect((await pending.json()).pending_function_calls).toEqual([]);
      const replay = await post(restarted.baseUrl, session.accessToken, {
        previous_response_id: priorId,
        input: [
          {
            type: "function_call_output",
            call_id: callId,
            output: "never automatically repeat",
          },
        ],
      });
      expect(replay.status).toBeGreaterThanOrEqual(400);
      expect(runtime.modelRequests).toHaveLength(count);
    },
    60_000,
  );
});
