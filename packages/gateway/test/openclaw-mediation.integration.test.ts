import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  startOpenClawTestRuntime,
  type OpenClawTestRuntime,
} from "../../../scripts/openclaw-test-runtime.mjs";
import { ResponseEngine, type EngineSession } from "../src/responses/engine.js";
import { OpenClawResponses } from "../src/responses/openclaw.js";
import { FileResponseStore } from "../src/responses/file-store.js";
import type {
  ResponseResource,
  ResponseStreamEvent,
} from "../src/responses/protocol.js";
import {
  hashToolSnapshot,
  validateToolSnapshot,
} from "../src/tool-snapshot.js";

const integration =
  process.env.RUN_OPENCLAW_INTEGRATION === "1" ? describe : describe.skip;
const tools = validateToolSnapshot([
  {
    name: "set_page_message",
    description: "Set visible message",
    inputSchema: {
      type: "object",
      properties: { message: { type: "string" } },
      required: ["message"],
      additionalProperties: false,
    },
  },
]);
const roots: string[] = [];
let runtime: OpenClawTestRuntime;
let serial = 0;
function session(): EngineSession {
  const id = ++serial;
  return {
    sessionId: `acs_test_${id}`,
    appId: "test",
    origin: "https://app.example",
    toolHash: hashToolSnapshot(tools),
    tools,
    authorizationGrantId: `grant_${id}`,
    providerSessionId: `agent:main:openresponses:agent-connect-test-${id}`,
  };
}
function harness() {
  const directory = mkdtempSync(join(tmpdir(), "ac-openclaw-ledger-"));
  roots.push(directory);
  const store = new FileResponseStore(directory);
  let active = true;
  const upstream = new OpenClawResponses({
    baseUrl: runtime.baseUrl,
    token: runtime.token,
    agentId: runtime.agentId,
  });
  const engine = new ResponseEngine({
    store,
    upstream,
    isGrantActive: () => active,
  });
  return {
    directory,
    store,
    engine,
    upstream,
    revoke: () => {
      active = false;
    },
  };
}
async function drain(stream: AsyncGenerator<ResponseStreamEvent>) {
  const events: ResponseStreamEvent[] = [];
  let response: ResponseResource | undefined;
  for await (const event of stream) {
    events.push(event);
    if ("response" in event) response = event.response;
  }
  if (!response) throw new Error("missing response");
  return { events, response };
}
function callOf(response: ResponseResource) {
  const call = response.output.find((item) => item.type === "function_call");
  if (!call || call.type !== "function_call") throw new Error("missing call");
  return call;
}
function latch() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}
integration("real OpenClaw mediation and local authority", () => {
  it("does not publish a recovery call between resource persistence and the call commit", async () => {
    const h = harness();
    const own = session();
    const entered = latch();
    const resume = latch();
    let id = "";
    const putResponse = h.store.putResponse.bind(h.store);
    h.store.putResponse = async (response) => {
      await putResponse(response);
      if (response.output.some((item) => item.type === "function_call")) {
        id = response.responseId;
        entered.release();
        await resume.promise;
      }
    };
    const consuming = drain(
      await h.engine.createResponse(own, {
        kind: "initial",
        stream: true,
        prompt: "request-browser-tool",
      }),
    );
    try {
      await entered.promise;
      const recovery = await h.engine.describeChain(own, id);
      expect(
        recovery.response.output.filter(
          (item) => item.type === "function_call",
        ),
      ).toEqual([]);
      expect(await h.engine.pendingFunctionCalls(own, id)).toEqual([]);
    } finally {
      resume.release();
    }
    const final = await consuming;
    expect(callOf(final.response)).toBeDefined();
  }, 30_000);

  it("suppresses a pending-call snapshot when cancellation wins during its store read", async () => {
    const h = harness();
    const own = session();
    const first = await drain(
      await h.engine.createResponse(own, {
        kind: "initial",
        stream: true,
        prompt: "request-browser-tool",
      }),
    );
    const entered = latch();
    const resume = latch();
    const unresolved = h.store.unresolvedCalls.bind(h.store);
    h.store.unresolvedCalls = async (chainId) => {
      const snapshot = await unresolved(chainId);
      entered.release();
      await resume.promise;
      return snapshot;
    };
    const pending = h.engine.pendingFunctionCalls(own, first.response.id);
    try {
      await entered.promise;
      await h.engine.cancelChain(own, first.response.id);
    } finally {
      resume.release();
    }
    expect(await pending).toEqual([]);
  }, 30_000);

  beforeAll(async () => {
    runtime = await startOpenClawTestRuntime({
      onModelRequest(body, inference) {
        const latest = body.messages.filter((m) => m.role === "user").at(-1);
        const text = JSON.stringify(latest?.content);
        if (text.includes("hold-inference")) inference.hang("waiting");
        else if (text.includes("request-browser-tool"))
          inference.tool("set_page_message", { message: "from inference" });
        else inference.text("fixture consumed " + text);
      },
    });
  }, 120_000);
  afterAll(async () => {
    await runtime?.close();
    for (const root of roots) rmSync(root, { recursive: true, force: true });
  }, 30_000);

  it("persists an approved call before publication, consumes output, reinjects tools and rejects stale/foreign IDs", async () => {
    const h = harness();
    const own = session();
    const foreign = session();
    const stream = await h.engine.createResponse(own, {
      kind: "initial",
      stream: true,
      prompt: "request-browser-tool",
    });
    let response: ResponseResource | undefined;
    for await (const event of stream) {
      if ("item" in event && event.item.type === "function_call")
        expect(await h.store.getCall(event.item.call_id)).toBeDefined();
      if ("response" in event) response = event.response;
    }
    const call = callOf(response!);
    await expect(
      h.engine.describeChain(foreign, response!.id),
    ).rejects.toMatchObject({ code: "previous_response_not_found" });
    const request = {
      kind: "continuation" as const,
      stream: true,
      previousResponseId: response!.id,
      callId: call.call_id,
      output: "unique-result-47",
    };
    const final = await drain(await h.engine.createResponse(own, request));
    expect(JSON.stringify(final.response.output)).toContain("unique-result-47");
    const count = runtime.modelRequests.length;
    await expect(h.engine.createResponse(own, request)).rejects.toMatchObject({
      code: "previous_response_not_continuable",
    });
    await expect(
      h.engine.createResponse(own, { ...request, output: "conflict" }),
    ).rejects.toMatchObject({ code: "function_output_conflict" });
    expect(runtime.modelRequests).toHaveLength(count);
    expect(await h.engine.pendingFunctionCalls(own, response!.id)).toEqual([]);
    const followup = await drain(
      await h.engine.createResponse(own, {
        kind: "follow_up",
        stream: true,
        previousResponseId: final.response.id,
        prompt: "followup",
      }),
    );
    expect(followup.response.status).toBe("completed");
    for (const request of runtime.modelRequests)
      expect(request.body.tools?.map((t) => t.function.name)).toEqual([
        "set_page_message",
      ]);
    expect(JSON.stringify(followup)).not.toContain(runtime.token);
    expect(JSON.stringify(followup)).not.toContain(own.providerSessionId);
  }, 60_000);

  it("keeps independent sessions live and denies output after revocation", async () => {
    const h = harness();
    const a = session();
    const b = session();
    const [first, second] = await Promise.all(
      [a, b].map(async (s) =>
        drain(
          await h.engine.createResponse(s, {
            kind: "initial",
            stream: true,
            prompt: "request-browser-tool",
          }),
        ),
      ),
    );
    if (!first || !second) throw new Error("both sessions must finish");
    await expect(
      h.engine.createResponse(b, {
        kind: "continuation",
        stream: true,
        previousResponseId: second.response.id,
        callId: callOf(first.response).call_id,
        output: "stolen",
      }),
    ).rejects.toMatchObject({ code: "function_call_not_found" });
    h.revoke();
    const count = runtime.modelRequests.length;
    await expect(
      h.engine.createResponse(a, {
        kind: "continuation",
        stream: true,
        previousResponseId: first.response.id,
        callId: callOf(first.response).call_id,
        output: "denied",
      }),
    ).rejects.toMatchObject({ code: "response_cancelled" });
    expect(runtime.modelRequests).toHaveLength(count);
  }, 60_000);

  it("reconstructs parked authority and cancels without offering an impossible call", async () => {
    const h = harness();
    const own = session();
    const first = await drain(
      await h.engine.createResponse(own, {
        kind: "initial",
        stream: true,
        prompt: "request-browser-tool",
      }),
    );
    const restarted = new ResponseEngine({
      store: new FileResponseStore(h.directory),
      upstream: h.upstream,
      isGrantActive: () => true,
    });
    expect(
      await restarted.pendingFunctionCalls(own, first.response.id),
    ).toHaveLength(1);
    await restarted.cancelChain(own, first.response.id);
    expect(
      await restarted.pendingFunctionCalls(own, first.response.id),
    ).toEqual([]);
    expect(
      (await restarted.describeChain(own, first.response.id)).recovery,
    ).toBe("interrupted");
  }, 60_000);

  it("cancels actual active inference and blocks concurrent admission", async () => {
    const h = harness();
    const own = session();
    const stream = await h.engine.createResponse(own, {
      kind: "initial",
      stream: true,
      prompt: "hold-inference",
    });
    const first = await stream.next();
    if (!first.value || !("response" in first.value))
      throw new Error("expected created event");
    const id = first.value.response.id;
    const consuming = drain(stream).catch(() => undefined);
    await expect
      .poll(
        () =>
          runtime.modelRequests.some((r) =>
            JSON.stringify(r.body).includes("hold-inference"),
          ),
        // A focused run cold-starts the first inference; this is not the stop budget.
        { timeout: 10_000 },
      )
      .toBe(true);
    await expect(
      h.engine.createResponse(own, {
        kind: "initial",
        stream: true,
        prompt: "duplicate",
      }),
    ).rejects.toMatchObject({ code: "response_busy" });
    await h.engine.cancelChain(own, id);
    await consuming;
    await expect
      .poll(
        () =>
          runtime.modelRequests
            .filter((r) => JSON.stringify(r.body).includes("hold-inference"))
            .every((r) => r.closed),
        { timeout: 10_000 },
      )
      .toBe(true);
    expect(await h.engine.pendingFunctionCalls(own, id)).toEqual([]);
  }, 30_000);
});
