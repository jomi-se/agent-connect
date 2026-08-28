import { describe, expect, it } from "vitest";

import { OmnigentResponseBackend } from "../src/omnigent-response-backend.js";
import { BackendEventQueue } from "../src/responses/backend.js";

describe("OmnigentResponseBackend transport safeguards", () => {
  it("bounds an event post when the provider transport stops answering", async () => {
    let posts = 0;
    const stream = new ReadableStream<Uint8Array>();
    const fetchImplementation: typeof fetch = async (input, init) => {
      const url = String(input);
      if (url.endsWith("/stream")) {
        return new Response(stream, {
          status: 200,
          headers: { "Content-Type": "text/event-stream" },
        });
      }
      posts += 1;
      if (posts === 1) return new Response(null, { status: 204 });
      return new Promise<Response>((_resolve, reject) => {
        const signal = init?.signal;
        if (!signal) throw new Error("expected a bounded request signal");
        signal.addEventListener("abort", () => reject(signal.reason), {
          once: true,
        });
      });
    };
    const backend = new OmnigentResponseBackend({
      baseUrl: "http://omnigent.test",
      fetch: fetchImplementation,
      postTimeoutMs: 10,
    });
    const run = await backend.start({
      providerSessionId: "provider-session",
      prompt: "test prompt",
      tools: [],
    });

    await expect(run.submitOutput("call-id", "{}")).rejects.toThrow();
    await run.close();
  });

  it("fails explicitly instead of buffering provider events without bound", async () => {
    const queue = new BackendEventQueue(1);
    const events = queue.iterator();
    queue.push({ type: "text.delta", delta: "kept" });
    queue.push({ type: "text.delta", delta: "overflow" });

    await expect(events.next()).resolves.toMatchObject({
      value: { type: "text.delta", delta: "kept" },
      done: false,
    });
    await expect(events.next()).rejects.toThrow(
      "backend event buffer capacity exceeded",
    );
  });
});
