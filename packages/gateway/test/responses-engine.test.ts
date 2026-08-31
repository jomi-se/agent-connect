import { describe, expect, it } from "vitest";

import type {
  BackendEvent,
  BackendRun,
  BackendStartRequest,
  ResponseBackend,
} from "../src/responses/backend.js";
import {
  ResponseApiError,
  type ResponseErrorCode,
} from "../src/responses/errors.js";
import { ResponseEngine, type EngineSession } from "../src/responses/engine.js";
import type { ParsedResponseRequest } from "../src/responses/profile.js";
import type {
  ResponseResource,
  ResponseStreamEvent,
} from "../src/responses/protocol.js";
import { encodeSseEvent } from "../src/responses/sse.js";
import { InMemoryResponseStore } from "../src/responses/store.js";
import {
  hashToolSnapshot,
  validateToolSnapshot,
} from "../src/tool-snapshot.js";
import { FakeBackend, type FakeTurn } from "./support/fake-backend.js";
import {
  streamingEventSchemaName,
  validateAgainstSchema,
} from "./support/openapi-schema.js";

const tools = validateToolSnapshot([
  {
    name: "set_page_message",
    description: "Replace the visible page message",
    inputSchema: {
      type: "object",
      properties: {},
      additionalProperties: false,
    },
  },
  {
    name: "read_page_message",
    description: "Read the visible page message",
    inputSchema: {
      type: "object",
      properties: {},
      additionalProperties: false,
    },
  },
]);

const session: EngineSession = {
  sessionId: "acs_1",
  appId: "canvas",
  origin: "https://app.example",
  toolHash: hashToolSnapshot(tools),
  tools,
  authorizationGrantId: "grant_1",
  providerSessionId: "provider_1",
};

function harness(
  turns: readonly FakeTurn[],
  options: {
    readonly grantActive?: () => boolean;
    readonly runs?: readonly (readonly FakeTurn[])[];
  } = {},
) {
  const store = new InMemoryResponseStore();
  const backend = new FakeBackend({
    turns,
    ...(options.runs ? { runs: options.runs } : {}),
  });
  let counter = 0;
  const engine = new ResponseEngine({
    store,
    backend,
    isGrantActive: options.grantActive ?? (() => true),
    now: () => 1_700_000_000_000,
    createId: () => {
      counter += 1;
      return `${counter}`.padStart(8, "0");
    },
  });
  return { engine, store, backend };
}

const initial: ParsedResponseRequest = {
  kind: "initial",
  stream: true,
  prompt: "hello",
};

function continuation(
  previousResponseId: string,
  callId: string,
  output: string,
): ParsedResponseRequest {
  return {
    kind: "continuation",
    stream: true,
    previousResponseId,
    callId,
    output,
  };
}

function followUp(
  previousResponseId: string,
  prompt = "not quite",
): ParsedResponseRequest {
  return {
    kind: "follow_up",
    stream: true,
    previousResponseId,
    prompt,
  };
}

/** Drains one segment, validating every event against the pinned schemas. */
async function drain(stream: AsyncGenerator<ResponseStreamEvent>): Promise<{
  readonly events: readonly ResponseStreamEvent[];
  readonly final: ResponseResource | undefined;
  readonly types: readonly string[];
}> {
  const events: ResponseStreamEvent[] = [];
  for await (const event of stream) {
    expect(
      validateAgainstSchema(streamingEventSchemaName(event.type), event),
    ).toEqual([]);
    // VAL-RESP-002: `event:` equals the JSON `type`. The pinned document does
    // not require this, so it is asserted locally.
    expect(
      encodeSseEvent(event).startsWith(`event: ${event.type}\ndata: {`),
    ).toBe(true);
    events.push(event);
  }
  const sequence = events.map((event) => event.sequence_number);
  expect(sequence).toEqual([...sequence].sort((a, b) => a - b));
  expect(new Set(sequence).size).toBe(sequence.length);
  const last = events.at(-1);
  const final =
    last && "response" in last
      ? (last.response as ResponseResource)
      : undefined;
  if (final)
    expect(validateAgainstSchema("ResponseResource", final)).toEqual([]);
  return { events, final, types: events.map((event) => event.type) };
}

async function failureCode(
  operation: Promise<unknown>,
): Promise<ResponseErrorCode> {
  try {
    await operation;
  } catch (error) {
    if (error instanceof ResponseApiError) return error.code;
    throw error;
  }
  throw new Error("expected the engine to reject this operation");
}

const call = (
  providerToken: string,
  name: string,
  args = "{}",
): BackendEvent => ({
  type: "tool.call",
  providerToken,
  name,
  arguments: args,
});
const text = (delta: string): BackendEvent => ({ type: "text.delta", delta });

describe("response engine protocol fit", () => {
  it("emits the full text lifecycle for a text-only run", async () => {
    const { engine } = harness([
      [text("Hel"), text("lo"), { type: "completed" }],
    ]);
    const { types, final } = await drain(
      await engine.createResponse(session, initial),
    );

    expect(types).toEqual([
      "response.created",
      "response.in_progress",
      "response.output_item.added",
      "response.content_part.added",
      "response.output_text.delta",
      "response.output_text.delta",
      "response.output_text.done",
      "response.content_part.done",
      "response.output_item.done",
      "response.completed",
    ]);
    expect(final?.status).toBe("completed");
    expect(final?.output).toEqual([
      {
        type: "message",
        id: expect.any(String),
        status: "completed",
        role: "assistant",
        content: [{ type: "output_text", text: "Hello", annotations: [] }],
      },
    ]);
    expect(final?.previous_response_id).toBeNull();
  });

  it("starts a completed-task follow-up as a new chain on the same provider session", async () => {
    const { engine, backend, store } = harness([], {
      runs: [
        [[text("first answer"), { type: "completed" }]],
        [[text("revised answer"), { type: "completed" }]],
      ],
    });
    const first = await drain(await engine.createResponse(session, initial));
    const second = await drain(
      await engine.createResponse(session, followUp(first.final!.id)),
    );

    expect(textOf(second.final)).toBe("revised answer");
    expect(second.final?.previous_response_id).toBe(first.final?.id);
    expect(backend.runs).toHaveLength(2);
    expect(backend.runs.map((run) => run.providerSessionId)).toEqual([
      session.providerSessionId,
      session.providerSessionId,
    ]);
    const chains = await store.listChains();
    expect(chains.map((chain) => chain.sessionTurn)).toEqual([1, 2]);
    expect(chains[1]?.continuedFromResponseId).toBe(first.final?.id);
  });

  it("rejects unlinked, stale, and provider-replaced follow-ups", async () => {
    const { engine } = harness([], {
      runs: [
        [[text("one"), { type: "completed" }]],
        [[text("two"), { type: "completed" }]],
      ],
    });
    const first = await drain(await engine.createResponse(session, initial));
    expect(await failureCode(engine.createResponse(session, initial))).toBe(
      "invalid_request",
    );
    const second = await drain(
      await engine.createResponse(session, followUp(first.final!.id)),
    );
    expect(
      await failureCode(
        engine.createResponse(session, followUp(first.final!.id)),
      ),
    ).toBe("previous_response_not_continuable");
    expect(
      await failureCode(
        engine.createResponse(
          { ...session, providerSessionId: "provider_replaced" },
          followUp(second.final!.id),
        ),
      ),
    ).toBe("previous_response_not_continuable");
  });

  it("admits only one of two initial chains racing on one session", async () => {
    const { engine } = harness([[]]);
    const outcomes = await Promise.allSettled([
      engine.createResponse(session, initial),
      engine.createResponse(session, initial),
    ]);
    expect(
      outcomes.filter((outcome) => outcome.status === "fulfilled"),
    ).toHaveLength(1);
    const rejected = outcomes.find((outcome) => outcome.status === "rejected");
    expect((rejected as PromiseRejectedResult).reason).toMatchObject({
      code: "response_busy",
    });
    await engine.closeAll();
  });

  it("makes an in-progress admission visible to provider-session repair", async () => {
    let releaseStart!: () => void;
    const mayStart = new Promise<void>((resolve) => {
      releaseStart = resolve;
    });
    const inner = new FakeBackend({
      turns: [[{ type: "completed" }]],
    });
    const backend: ResponseBackend = {
      kind: inner.kind,
      async start(request: BackendStartRequest): Promise<BackendRun> {
        await mayStart;
        return inner.start(request);
      },
    };
    const engine = new ResponseEngine({
      store: new InMemoryResponseStore(),
      backend,
      isGrantActive: () => true,
    });

    const starting = engine.createResponse(session, initial);
    expect(await engine.hasLiveChain(session.sessionId)).toBe(true);
    expect(
      await engine.runIfSessionIdle(session.sessionId, async () => "repaired"),
    ).toBeUndefined();
    releaseStart();
    await drain(await starting);
  });

  it("blocks response admission while provider-session repair owns the session", async () => {
    let releaseRepair!: () => void;
    const mayRepair = new Promise<void>((resolve) => {
      releaseRepair = resolve;
    });
    const { engine } = harness([[{ type: "completed" }]]);
    const repairing = engine.runIfSessionIdle(session.sessionId, async () => {
      await mayRepair;
      return "repaired";
    });

    expect(await failureCode(engine.createResponse(session, initial))).toBe(
      "response_busy",
    );
    releaseRepair();
    await expect(repairing).resolves.toBe("repaired");
    await drain(await engine.createResponse(session, initial));
  });

  it("admits only one of two completed-turn follow-ups racing on one head", async () => {
    const { engine } = harness([], {
      runs: [
        [[text("one"), { type: "completed" }]],
        [[text("two"), { type: "completed" }]],
      ],
    });
    const first = await drain(await engine.createResponse(session, initial));
    const body = followUp(first.final!.id);
    const outcomes = await Promise.allSettled([
      engine.createResponse(session, body),
      engine.createResponse(session, body),
    ]);
    expect(
      outcomes.filter((outcome) => outcome.status === "fulfilled"),
    ).toHaveLength(1);
    const rejected = outcomes.find((outcome) => outcome.status === "rejected");
    expect((rejected as PromiseRejectedResult).reason).toMatchObject({
      code: "response_busy",
    });
    const admitted = outcomes.find(
      (
        outcome,
      ): outcome is PromiseFulfilledResult<
        AsyncGenerator<ResponseStreamEvent>
      > => outcome.status === "fulfilled",
    );
    await drain(admitted!.value);
  });

  it("renders the six inert required fields as the documented constants", async () => {
    const { engine } = harness([[{ type: "completed" }]]);
    const { final } = await drain(
      await engine.createResponse(session, initial),
    );
    expect(final).toMatchObject({
      temperature: 1,
      top_p: 1,
      presence_penalty: 0,
      frequency_penalty: 0,
      top_logprobs: 0,
      service_tier: "default",
      model: "agent-connect/default",
      tool_choice: "auto",
      truncation: "disabled",
      parallel_tool_calls: false,
      store: true,
      background: false,
      text: { format: { type: "text" } },
      instructions: null,
      usage: null,
      reasoning: null,
      metadata: null,
    });
  });

  it("renders the immutable snapshot as tools on every response in the chain", async () => {
    const { engine } = harness([
      [call("provider_a", "set_page_message")],
      [{ type: "completed" }],
    ]);
    const first = await drain(await engine.createResponse(session, initial));
    const callId = callIdOf(first.final);
    const second = await drain(
      await engine.createResponse(
        session,
        // The continuation omits `tools` entirely.
        continuation(first.final!.id, callId, "{}"),
      ),
    );
    for (const resource of [first.final, second.final]) {
      expect(resource?.tools).toEqual([
        {
          type: "function",
          name: "set_page_message",
          description: "Replace the visible page message",
          parameters: expect.any(Object),
          strict: true,
        },
        {
          type: "function",
          name: "read_page_message",
          description: "Read the visible page message",
          parameters: expect.any(Object),
          strict: true,
        },
      ]);
    }
  });

  it("ends a segment at a function call and keeps the run alive", async () => {
    const { engine, backend } = harness([
      [text("working"), call("provider_a", "set_page_message", '{"a":1}')],
      [{ type: "completed" }],
    ]);
    const { types, final } = await drain(
      await engine.createResponse(session, initial),
    );

    expect(types).toEqual([
      "response.created",
      "response.in_progress",
      "response.output_item.added",
      "response.content_part.added",
      "response.output_text.delta",
      "response.output_text.done",
      "response.content_part.done",
      "response.output_item.done",
      "response.output_item.added",
      "response.function_call_arguments.done",
      "response.output_item.done",
      "response.completed",
    ]);
    expect(final?.status).toBe("completed");
    expect(final?.output.at(-1)).toEqual({
      type: "function_call",
      id: expect.any(String),
      call_id: expect.any(String),
      name: "set_page_message",
      arguments: '{"a":1}',
      status: "completed",
    });
    // The point of the design: the segment closed, the harness run did not.
    expect(backend.runs[0]?.closed).toBe(false);
  });

  it("never exposes the provider token as the public call id", async () => {
    const { engine, store } = harness([
      [call("provider_secret_token", "set_page_message")],
    ]);
    const { final } = await drain(
      await engine.createResponse(session, initial),
    );
    const callId = callIdOf(final);
    expect(callId).not.toContain("provider_secret_token");
    expect(JSON.stringify(final)).not.toContain("provider_secret_token");
    expect((await store.getCall(callId))?.providerToken).toBe(
      "provider_secret_token",
    );
    // Pinned `FunctionCallOutputItemParam.call_id` bounds.
    expect(callId.length).toBeGreaterThanOrEqual(1);
    expect(callId.length).toBeLessThanOrEqual(64);
  });

  it("completes two sequential calls and a final text on one run", async () => {
    const { engine, backend } = harness([
      [call("provider_a", "set_page_message")],
      [call("provider_b", "read_page_message")],
      [text("all done"), { type: "completed" }],
    ]);

    const first = await drain(await engine.createResponse(session, initial));
    const callOne = callIdOf(first.final);
    const second = await drain(
      await engine.createResponse(
        session,
        continuation(first.final!.id, callOne, '{"ok":1}'),
      ),
    );
    const callTwo = callIdOf(second.final);
    expect(callTwo).not.toBe(callOne);
    expect(second.final?.previous_response_id).toBe(first.final?.id);

    const third = await drain(
      await engine.createResponse(
        session,
        continuation(second.final!.id, callTwo, '{"ok":2}'),
      ),
    );
    expect(third.final?.status).toBe("completed");
    expect(textOf(third.final)).toBe("all done");
    expect(backend.runs).toHaveLength(1);
    expect(backend.runs[0]?.submitted).toEqual([
      { token: "provider_a", output: '{"ok":1}' },
      { token: "provider_b", output: '{"ok":2}' },
    ]);
  });

  it("advances the three call state axes across publication and delivery", async () => {
    const { engine, store } = harness([
      [call("provider_a", "set_page_message")],
      [{ type: "completed" }],
    ]);
    const first = await drain(await engine.createResponse(session, initial));
    const callId = callIdOf(first.final);

    const published = await store.getCall(callId);
    expect(published?.publication).toBe("published");
    expect(published?.result).toBe("none");
    expect(published?.output).toBeNull();

    await drain(
      await engine.createResponse(
        session,
        continuation(first.final!.id, callId, '{"ok":1}'),
      ),
    );
    const resolved = await store.getCall(callId);
    expect(resolved?.output).toBe('{"ok":1}');
    // A 202 acknowledgement is not proof of effect; a subsequent provider event is.
    expect(resolved?.result).toBe("provider_observed");
  });

  it("treats a repeated identical output as an idempotent redrive", async () => {
    const { engine } = harness([
      [call("provider_a", "set_page_message")],
      [call("provider_b", "read_page_message")],
      [{ type: "completed" }],
    ]);
    const first = await drain(await engine.createResponse(session, initial));
    const callId = callIdOf(first.final);
    await drain(
      await engine.createResponse(
        session,
        continuation(first.final!.id, callId, '{"ok":1}'),
      ),
    );
    // The same call, already observed by the provider, is no longer unresolved.
    expect(
      await failureCode(
        engine.createResponse(
          session,
          continuation(first.final!.id, callId, '{"ok":1}'),
        ),
      ),
    ).toBe("previous_response_not_found");
  });

  it("rejects a different output for an already recorded call", async () => {
    const { engine, store } = harness([
      [call("provider_a", "set_page_message")],
      [{ type: "completed" }],
    ]);
    const first = await drain(await engine.createResponse(session, initial));
    const callId = callIdOf(first.final);
    const record = await store.getCall(callId);
    await store.putCall({
      ...record!,
      result: "output_recorded",
      output: '{"ok":1}',
      outputFingerprint: "different",
    });
    expect(
      await failureCode(
        engine.createResponse(
          session,
          continuation(first.final!.id, callId, '{"ok":2}'),
        ),
      ),
    ).toBe("function_output_conflict");
  });

  it("rejects an unknown call id, an unknown chain, and a stale response id", async () => {
    const { engine } = harness([
      [call("provider_a", "set_page_message")],
      [call("provider_b", "read_page_message")],
      [{ type: "completed" }],
    ]);
    const first = await drain(await engine.createResponse(session, initial));
    const callOne = callIdOf(first.final);

    expect(
      await failureCode(
        engine.createResponse(
          session,
          continuation(first.final!.id, "call_nope", "{}"),
        ),
      ),
    ).toBe("function_call_not_found");
    expect(
      await failureCode(
        engine.createResponse(
          session,
          continuation("resp_nope", callOne, "{}"),
        ),
      ),
    ).toBe("previous_response_not_found");

    const second = await drain(
      await engine.createResponse(
        session,
        continuation(first.final!.id, callOne, "{}"),
      ),
    );
    // Only the most recent response in a chain is continuable.
    expect(
      await failureCode(
        engine.createResponse(
          session,
          continuation(first.final!.id, callIdOf(second.final), "{}"),
        ),
      ),
    ).toBe("previous_response_not_found");
  });

  it("refuses a chain belonging to another application session", async () => {
    const { engine } = harness([[call("provider_a", "set_page_message")]]);
    const first = await drain(await engine.createResponse(session, initial));
    expect(
      await failureCode(
        engine.createResponse(
          { ...session, sessionId: "acs_other" },
          continuation(first.final!.id, callIdOf(first.final), "{}"),
        ),
      ),
    ).toBe("previous_response_not_found");
  });

  it("refuses every operation once the grant is revoked", async () => {
    let active = true;
    const { engine } = harness([[call("provider_a", "set_page_message")]], {
      grantActive: () => active,
    });
    const first = await drain(await engine.createResponse(session, initial));
    active = false;
    expect(await failureCode(engine.createResponse(session, initial))).toBe(
      "tool_snapshot_mismatch",
    );
    expect(
      await failureCode(
        engine.createResponse(
          session,
          continuation(first.final!.id, callIdOf(first.final), "{}"),
        ),
      ),
    ).toBe("tool_snapshot_mismatch");
    expect(
      await failureCode(engine.describeChain(session, first.final!.id)),
    ).toBe("tool_snapshot_mismatch");
    expect(
      await failureCode(engine.cancelChain(session, first.final!.id)),
    ).toBe("tool_snapshot_mismatch");
  });

  it("rejects a second operation while one is active on the chain", async () => {
    const { engine, backend } = harness([
      [call("provider_a", "set_page_message")],
      // The second turn never terminates, so the segment stays open.
      [text("thinking")],
    ]);
    const first = await drain(await engine.createResponse(session, initial));
    const callId = callIdOf(first.final);
    const pending = engine.createResponse(
      session,
      continuation(first.final!.id, callId, "{}"),
    );
    const stream = await pending;
    const started = stream.next();

    expect(
      await failureCode(
        engine.createResponse(
          session,
          continuation(first.final!.id, callId, "{}"),
        ),
      ),
    ).toBe("response_busy");

    await started;
    await backend.runs[0]?.close();
    await drain(stream);
  });

  it("fails the segment when the harness reports an error", async () => {
    const { engine } = harness([
      [text("partial"), { type: "failed", message: "codex exploded" }],
    ]);
    const { types, final } = await drain(
      await engine.createResponse(session, initial),
    );
    expect(types.slice(-2)).toEqual(["error", "response.failed"]);
    expect(final?.status).toBe("failed");
    expect(final?.error).toEqual({
      code: "backend_protocol_error",
      message: "codex exploded",
    });
    // Text observed before the failure is still committed to the resource.
    expect(textOf(final)).toBe("partial");
  });

  it("fails the segment when the harness transport dies mid-run", async () => {
    const { engine, backend } = harness([[text("partial")]]);
    const stream = await engine.createResponse(session, initial);
    const first = await stream.next();
    expect(first.done).toBe(false);
    backend.runs[0]?.killTransport(new Error("omnigent went away"));
    const rest: ResponseStreamEvent[] = [];
    for await (const event of stream) rest.push(event);
    expect(rest.at(-1)?.type).toBe("response.failed");
    const failed = rest.at(-1);
    expect(
      failed && "response" in failed ? failed.response.error?.code : undefined,
    ).toBe("backend_unavailable");
  });

  it("refuses a function the approved snapshot does not contain", async () => {
    const { engine } = harness([[call("provider_a", "exfiltrate")]]);
    const { types, final } = await drain(
      await engine.createResponse(session, initial),
    );
    expect(types.at(-1)).toBe("response.failed");
    expect(final?.error?.code).toBe("backend_protocol_error");
  });

  it("fails rather than completing when the backend stream ends without a terminal event", async () => {
    const { engine, backend } = harness([[text("truncated")]]);
    const stream = await engine.createResponse(session, initial);
    backend.runs[0]?.endTransport();
    const { final } = await drain(stream);
    expect(final?.status).toBe("failed");
    expect(final?.error?.code).toBe("backend_protocol_error");
    expect(textOf(final)).toBe("truncated");
  });

  it("reports a backend that cannot be started as 502 before any event", async () => {
    const store = new InMemoryResponseStore();
    const backend = new FakeBackend({
      turns: [],
      failStart: new Error("omnigent refused"),
    });
    const engine = new ResponseEngine({
      store,
      backend,
      isGrantActive: () => true,
    });
    expect(await failureCode(engine.createResponse(session, initial))).toBe(
      "backend_unavailable",
    );
  });
});

describe("Agent Connect control extensions", () => {
  it("reconstructs a response that completed during an outage", async () => {
    const { engine } = harness([[text("done"), { type: "completed" }]]);
    const { final } = await drain(
      await engine.createResponse(session, initial),
    );
    const view = await engine.describeChain(session, final!.id);
    expect(view.recovery).toBe("terminal_reconstructed");
    expect(view.chainStatus).toBe("terminal");
    expect(view.response.status).toBe("completed");
    expect(textOf(view.response)).toBe("done");
  });

  it("redelivers an unresolved published call", async () => {
    const { engine } = harness([
      [call("provider_a", "set_page_message", '{"x":1}')],
    ]);
    const { final } = await drain(
      await engine.createResponse(session, initial),
    );
    expect(await engine.pendingFunctionCalls(session, final!.id)).toEqual([
      {
        callId: callIdOf(final),
        name: "set_page_message",
        arguments: '{"x":1}',
        responseId: final!.id,
      },
    ]);
    const view = await engine.describeChain(session, final!.id);
    expect(view.recovery).toBe("reattached_live");
    expect(view.chainStatus).toBe("waiting_for_output");
  });

  it("cancels a parked chain and refuses to continue it afterwards", async () => {
    const { engine, backend } = harness([
      [call("provider_a", "set_page_message")],
      [{ type: "completed" }],
    ]);
    const { final } = await drain(
      await engine.createResponse(session, initial),
    );
    const view = await engine.cancelChain(session, final!.id);
    expect(view.chainStatus).toBe("terminal");
    expect(backend.runs[0]?.cancelled).toBe(true);
    expect(backend.runs[0]?.closed).toBe(true);
    expect(
      await failureCode(
        engine.createResponse(
          session,
          continuation(final!.id, callIdOf(final), "{}"),
        ),
      ),
    ).toBe("response_cancelled");
  });

  it("cancels a busy segment without waiting for a backend cancellation event", async () => {
    const { engine, backend } = harness([[]]);
    const stream = await engine.createResponse(session, initial);
    const created = await stream.next();
    expect(created.done).toBe(false);
    const responseId =
      created.value && "response" in created.value
        ? created.value.response.id
        : "";

    const view = await engine.cancelChain(session, responseId);
    const rest = await drain(stream);

    expect(view.chainStatus).toBe("terminal");
    expect(backend.runs[0]?.cancelled).toBe(true);
    expect(rest.types.at(-1)).toBe("response.incomplete");
    expect(rest.final?.status).toBe("cancelled");
  });

  it("terminalizes a busy segment after the client disconnects", async () => {
    const { engine, backend } = harness([[]]);
    const stream = await engine.createResponse(session, initial);
    const created = await stream.next();
    expect(created.done).toBe(false);
    const responseId =
      created.value && "response" in created.value
        ? created.value.response.id
        : "";

    await engine.requestCancellation(responseId);
    const rest = await drain(stream);

    expect(backend.runs[0]?.cancelled).toBe(true);
    expect(rest.types.at(-1)).toBe("response.incomplete");
    expect(rest.final?.status).toBe("cancelled");
    expect(await engine.hasLiveChain(session.sessionId)).toBe(false);

    // The disconnected run no longer locks a new application session. The old
    // session cannot honestly restart on provider context that may be partial.
    const freshSession = {
      ...session,
      sessionId: "acs_after_disconnect",
      providerSessionId: "provider_after_disconnect",
    };
    await expect(
      engine.createResponse(freshSession, initial),
    ).resolves.toBeDefined();
    await engine.closeAll();
  });

  it("does not post a function output after cancellation wins the continuation race", async () => {
    let reachedOutputPersist!: () => void;
    let releaseOutputPersist!: () => void;
    const outputPersisted = new Promise<void>((resolve) => {
      reachedOutputPersist = resolve;
    });
    const mayContinue = new Promise<void>((resolve) => {
      releaseOutputPersist = resolve;
    });
    class PausingStore extends InMemoryResponseStore {
      override async putCall(
        record: Parameters<InMemoryResponseStore["putCall"]>[0],
      ): Promise<void> {
        await super.putCall(record);
        if (record.result === "output_recorded") {
          reachedOutputPersist();
          await mayContinue;
        }
      }
    }
    const store = new PausingStore();
    const backend = new FakeBackend({
      turns: [
        [call("provider_a", "set_page_message")],
        [{ type: "completed" }],
      ],
    });
    const engine = new ResponseEngine({
      store,
      backend,
      isGrantActive: () => true,
    });
    const { final } = await drain(
      await engine.createResponse(session, initial),
    );

    const continuing = engine.createResponse(
      session,
      continuation(final!.id, callIdOf(final), "done"),
    );
    await outputPersisted;
    await engine.cancelChain(session, final!.id);
    releaseOutputPersist();

    await expect(continuing).rejects.toMatchObject({
      code: "response_cancelled",
    });
    expect(backend.runs[0]?.submitted).toEqual([]);
  });

  it("resolves a chain whose harness died while parked as interrupted", async () => {
    const { engine, backend } = harness([
      [call("provider_a", "set_page_message")],
    ]);
    const { final } = await drain(
      await engine.createResponse(session, initial),
    );
    // Nobody is reading the run's events while the chain waits for the browser,
    // so a harness that dies here is invisible unless recovery asks.
    backend.runs[0]?.killTransport(new Error("omnigent process died"));

    const view = await engine.describeChain(session, final!.id);
    expect(view.recovery).toBe("interrupted");
    expect(view.chainStatus).toBe("terminal");
    expect(
      await failureCode(
        engine.createResponse(
          session,
          continuation(final!.id, callIdOf(final), "{}"),
        ),
      ),
    ).toBe("backend_unavailable");
  });

  it("resolves a chain whose live run was lost as interrupted", async () => {
    const { engine } = harness([[call("provider_a", "set_page_message")]]);
    const { final } = await drain(
      await engine.createResponse(session, initial),
    );
    // Losing the harness process is exactly this: the durable record survives,
    // the in-process parked awaiter does not.
    await engine.closeAll();

    const view = await engine.describeChain(session, final!.id);
    expect(view.recovery).toBe("interrupted");
    expect(view.chainStatus).toBe("terminal");
    expect(
      await failureCode(
        engine.createResponse(
          session,
          continuation(final!.id, callIdOf(final), "{}"),
        ),
      ),
    ).toBe("backend_unavailable");
  });
});

describe("one chain at a time, and no calls a chain can no longer take", () => {
  it("stops redelivering a parked call once the chain is cancelled", async () => {
    const { engine } = harness([[call("provider_a", "set_page_message")]]);
    const { final } = await drain(
      await engine.createResponse(session, initial),
    );
    expect(await engine.pendingFunctionCalls(session, final!.id)).toHaveLength(
      1,
    );

    await engine.cancelChain(session, final!.id);

    // The application must not run the side effect after the user cancelled:
    // its result could never be taken by the chain.
    expect(await engine.pendingFunctionCalls(session, final!.id)).toEqual([]);
  });

  it("stops redelivering a parked call once the harness is gone", async () => {
    const { engine, backend } = harness([
      [call("provider_a", "read_page_message")],
    ]);
    const { final } = await drain(
      await engine.createResponse(session, initial),
    );
    backend.runs[0]?.killTransport(new Error("omnigent process died"));

    expect(await engine.pendingFunctionCalls(session, final!.id)).toEqual([]);
    expect(await engine.describeChain(session, final!.id)).toMatchObject({
      recovery: "terminal_reconstructed",
    });
  });

  it("refuses a second initial response while a chain is live", async () => {
    const { engine } = harness([
      [call("provider_a", "set_page_message")],
      [{ type: "completed" }],
    ]);
    await drain(await engine.createResponse(session, initial));

    expect(await failureCode(engine.createResponse(session, initial))).toBe(
      "response_busy",
    );
  });

  it("requires a new application session after cancellation", async () => {
    const { engine, backend } = harness([
      [call("provider_a", "set_page_message")],
    ]);
    const { final } = await drain(
      await engine.createResponse(session, initial),
    );
    await engine.cancelChain(session, final!.id);

    expect(await failureCode(engine.createResponse(session, initial))).toBe(
      "invalid_request",
    );
    const freshSession = {
      ...session,
      sessionId: "acs_after_cancel",
      providerSessionId: "provider_after_cancel",
    };
    const second = await drain(
      await engine.createResponse(freshSession, initial),
    );
    expect(second.final!.id).not.toBe(final!.id);
    expect(backend.runs).toHaveLength(2);
  });

  it("retires a dead chain but requires a fresh application session", async () => {
    const { engine, backend } = harness([
      [call("provider_a", "set_page_message")],
    ]);
    const first = await drain(await engine.createResponse(session, initial));
    backend.runs[0]?.killTransport(new Error("omnigent process died"));

    expect(await failureCode(engine.createResponse(session, initial))).toBe(
      "invalid_request",
    );
    const freshSession = {
      ...session,
      sessionId: "acs_after_death",
      providerSessionId: "provider_after_death",
    };
    const second = await drain(
      await engine.createResponse(freshSession, initial),
    );
    expect(second.final!.id).not.toBe(first.final!.id);
    expect(await engine.hasLiveChain(session.sessionId)).toBe(false);
  });

  it("admits only one of two continuations racing on the same call", async () => {
    const { engine, backend } = harness([
      [call("provider_a", "set_page_message")],
      [text("after"), { type: "completed" }],
    ]);
    const { final } = await drain(
      await engine.createResponse(session, initial),
    );
    const body = continuation(final!.id, callIdOf(final), '{"ok":true}');

    // Both start before either has awaited its way to the run. The claim has
    // to be taken in the same synchronous step as the check, or both pass.
    const [first, second] = await Promise.allSettled([
      engine.createResponse(session, body),
      engine.createResponse(session, body),
    ]);
    const rejected = [first, second].filter(
      (outcome) => outcome.status === "rejected",
    );
    expect(rejected).toHaveLength(1);
    expect((rejected[0]!.reason as ResponseApiError).code).toBe(
      "response_busy",
    );
    expect(backend.runs[0]?.submitted).toHaveLength(1);
  });

  it("does not resurrect a chain that expired between admission and its first event", async () => {
    const { engine, store } = harness([[text("work"), { type: "completed" }]]);
    // The generator exists but has not been consumed, which is exactly the
    // window every caller has: admission finished and the backend started, but
    // the segment has not written its first record yet.
    const stream = await engine.createResponse(session, initial);
    await engine.expireSession(session.sessionId);

    const result = await drain(stream);
    expect(result.types.at(-1)).toBe("response.failed");

    const chains = await store.listChains();
    expect(chains).toHaveLength(1);
    // Durably terminal, not silently returned to `running`. A resurrected
    // chain would hand the application call IDs on a provider session the
    // gateway is already tearing down.
    expect(chains[0]?.status).toBe("terminal");
    expect(chains[0]?.terminalError?.message).toContain("expired");
  });

  it("leaves an in-flight admission claim to its own owner when a session expires", async () => {
    const { engine } = harness([[{ type: "completed" }]]);
    await engine.expireSession(session.sessionId);
    // Expiry releasing a claim it does not own would let a second admission
    // run concurrently with the first, so the claim must still be free here
    // and an ordinary response must still be admissible.
    const stream = await engine.createResponse(session, initial);
    expect((await drain(stream)).types.at(-1)).toBe("response.completed");
  });

  it("reports the lifecycle state each expiry clock is measured against", async () => {
    const { engine } = harness([[call("token_a", "set_page_message")]]);
    expect(await engine.sessionLifecycle(session.sessionId)).toEqual({
      kind: "idle",
    });

    const first = await drain(await engine.createResponse(session, initial));
    expect(first.types.at(-1)).toBe("response.completed");
    // A segment that ended on a function call leaves the session parked, and
    // the clock starts from the call the application was handed rather than
    // from whenever the chain last changed for some other reason.
    expect(await engine.sessionLifecycle(session.sessionId)).toMatchObject({
      kind: "parked",
    });

    await engine.expireSession(session.sessionId);
    expect(await engine.sessionLifecycle(session.sessionId)).toEqual({
      kind: "idle",
    });
  });
});

function callIdOf(resource: ResponseResource | undefined): string {
  const item = resource?.output.at(-1);
  if (!item || item.type !== "function_call") {
    throw new Error("expected the response to end with a function call");
  }
  return item.call_id;
}

function textOf(resource: ResponseResource | undefined): string {
  return (resource?.output ?? [])
    .filter((item) => item.type === "message")
    .flatMap((item) => item.content.map((part) => part.text))
    .join("");
}
