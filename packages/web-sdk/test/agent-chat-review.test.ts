import { expect, it, vi } from "vitest";
import {
  AgentSession,
  ResponsesProvider,
  createAgentChat,
  defineTool,
  type AgentProvider,
  type AgentProviderEvent,
} from "../src/index.js";

function gate() {
  let resolve!: () => void;
  let reject!: (cause: unknown) => void;
  const promise = new Promise<void>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
function setup(
  streamTask: AgentProvider["streamTask"],
  cancel: AgentProvider["cancel"] = async () => {},
) {
  const submitToolResult = vi.fn(async () => {});
  const session = new AgentSession({
    provider: { streamTask, cancel, submitToolResult },
    tools: [
      defineTool({
        name: "read",
        description: "Read",
        inputSchema: { type: "object" },
        execute: async (args) => {
          (args["nested"] as { values: string[] }).values.push(
            "handler mutation",
          );
          return "ok";
        },
      }),
    ],
  });
  return { session, chat: createAgentChat({ session }), submitToolResult };
}
const done = {
  type: "task.completed",
  continuationToken: "checkpoint",
} as const;

it("independent probe: snapshots retain nested arguments despite later handler mutation and duplicate request", async () => {
  const args = { nested: { values: ["original"] } };
  const call = {
    type: "tool.requested",
    name: "read",
    actionId: "a",
    requestToken: "r",
    arguments: args,
  } as const;
  const f = setup(async function* () {
    yield call;
    yield call;
    yield done;
  });
  const result = await f.chat.send("read");
  const part = result.parts[0];
  expect(part?.type).toBe("tool");
  if (part?.type !== "tool") throw new Error("missing tool");
  expect(part.arguments).toEqual({ nested: { values: ["original"] } });
  expect(
    Object.isFrozen(
      (part.arguments?.["nested"] as { values: unknown[] }).values,
    ),
  ).toBe(true);
  expect(f.submitToolResult).toHaveBeenCalledOnce();
  expect(result.parts).toHaveLength(1);
});

it("independent probe: an idle subscriber starts a follow-up without corrupting the previous result", async () => {
  const f = setup(async function* (request) {
    yield { type: "text.delta", delta: request.prompt };
    yield done;
  });
  let followup: ReturnType<typeof f.chat.send> | undefined;
  let started = false;
  f.chat.subscribe(() => {
    if (
      !started &&
      f.chat.getSnapshot().canSend &&
      f.chat.getSnapshot().messages.length === 2
    ) {
      started = true;
      followup = f.chat.send("second");
    }
  });
  const first = await f.chat.send("first");
  expect(first.parts[0]).toMatchObject({ text: "first" });
  expect((await followup)?.parts[0]).toMatchObject({ text: "second" });
  expect(f.chat.getSnapshot()).toMatchObject({ status: "idle", canSend: true });
  expect(f.chat.getSnapshot().messages).toHaveLength(4);
});

it("independent probe: late cancellation failure cannot overwrite a newly active turn", async () => {
  const entered = gate();
  const release = gate();
  const cancelled = gate();
  const nextEntered = gate();
  const nextRelease = gate();
  let calls = 0;
  const f = setup(
    async function* (): AsyncGenerator<AgentProviderEvent> {
      yield { type: "task.admitted" };
      if (++calls === 1) {
        entered.resolve();
        await release.promise;
      } else {
        nextEntered.resolve();
        await nextRelease.promise;
      }
      yield done;
    },
    () => cancelled.promise,
  );
  const first = f.chat.send("first");
  await entered.promise;
  const stop = f.chat.stop();
  const observedStop = expect(stop).rejects.toThrow("late failure");
  release.resolve();
  expect((await first).status).toBe("completed");
  const second = f.chat.send("second");
  await nextEntered.promise;
  cancelled.reject(new Error("late failure"));
  await observedStop;
  expect(f.chat.getSnapshot()).toMatchObject({
    status: "running",
    canSend: false,
  });
  expect(f.chat.getSnapshot().error).toBeUndefined();
  nextRelease.resolve();
  await second;
});

it("independent probe: failed disposal is idempotent and detaches observers throughout later drainage", async () => {
  const entered = gate();
  const release = gate();
  const f = setup(
    async function* () {
      yield { type: "task.admitted" } as const;
      entered.resolve();
      await release.promise;
      yield done;
    },
    async () => {
      throw new Error("cancel unavailable");
    },
  );
  const listener = vi.fn();
  f.chat.subscribe(listener);
  const pending = f.chat.send("first");
  await entered.promise;
  const disposal = f.chat.dispose();
  const count = listener.mock.calls.length;
  expect(f.chat.dispose()).toBe(disposal);
  await expect(disposal).rejects.toThrow("cancel unavailable");
  await expect(f.chat.send("forbidden")).rejects.toThrow("disposed");
  expect(() => f.chat.subscribe(listener)).toThrow("disposed");
  release.resolve();
  expect((await pending).status).toBe("completed");
  expect(listener).toHaveBeenCalledTimes(count);
  expect(f.chat.getSnapshot().status).toBe("disposed");
});

it("independent probe: a delayed Responses cancel response never aborts a newer request", async () => {
  const cancelEntered = gate();
  const cancelRelease = gate();
  const signals: AbortSignal[] = [];
  let count = 0;
  const provider = new ResponsesProvider({
    baseUrl: "https://gateway.test",
    fetch: async (input, init) => {
      if (String(input).endsWith("/cancel")) {
        cancelEntered.resolve();
        await cancelRelease.promise;
        return new Response("{}");
      }
      signals.push(init!.signal!);
      const id = `response_${++count}`;
      const events = [
        { type: "response.created", response: { id } },
        { type: "response.output_text.delta", delta: "hello" },
        {
          type: "response.completed",
          response: { id, status: "completed", output: [] },
        },
      ];
      return new Response(
        events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(""),
        { headers: { "Content-Type": "text/event-stream" } },
      );
    },
  });
  const first = provider.streamTask({ prompt: "first", tools: [] });
  expect((await first.next()).value).toMatchObject({ type: "task.admitted" });
  const stopping = provider.cancel();
  await cancelEntered.promise;
  for await (const _event of first) {
    /* buffered completion wins */
  }
  const second = provider.streamTask({
    prompt: "second",
    tools: [],
    continuationToken: "response_1",
  });
  await second.next();
  cancelRelease.resolve();
  await stopping;
  expect(signals[1]?.aborted).toBe(false);
  for await (const _event of second) {
    /* drain new request */
  }
});
