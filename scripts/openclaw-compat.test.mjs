import assert from "node:assert/strict";
import test from "node:test";
import { writeFile } from "node:fs/promises";
import { startOpenClawTestRuntime } from "./openclaw-test-runtime.mjs";

const tool = {
  type: "function",
  name: "fixture_lookup",
  description: "Retrieve an application-owned value.",
  parameters: {
    type: "object",
    properties: { query: { type: "string" } },
    required: ["query"],
    additionalProperties: false,
  },
};

function eventsFromWire(wire) {
  return wire.split(/\r?\n\r?\n/).flatMap((frame) => {
    const data = frame
      .split(/\r?\n/)
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(5).trim())
      .join("\n");
    return !data || data === "[DONE]" ? [] : [JSON.parse(data)];
  });
}

test(
  "published OpenClaw: client tools, streaming, explicit history, and disconnect lifetime",
  { timeout: 150000 },
  async (t) => {
    const runtime = await startOpenClawTestRuntime({
      onModelRequest(body, inference) {
        assert.deepEqual(
          body.tools.map((entry) => entry.function.name),
          ["fixture_lookup"],
        );
        const userMessages = body.messages.filter(
          (message) => message.role === "user",
        );
        const latest = userMessages.at(-1)?.content ?? "";
        if (latest.includes("HOLD_INFERENCE")) return inference.hang();
        if (latest.includes("FOLLOWUP")) {
          assert.ok(
            userMessages.some((message) =>
              message.content.includes("application-value-42"),
            ),
          );
          return inference.text("Followup retains application-value-42.");
        }
        if (latest.includes("application-value-42"))
          return inference.text("Consumed application-value-42.");
        return inference.tool("fixture_lookup", { query: "example" });
      },
    });
    t.diagnostic(`Evidence: ${runtime.directory}`);
    try {
      const sessionKey = "agent:main:openresponses:compat-conversation";
      const firstResponse = await runtime.request(
        { input: "Retrieve example.", tools: [tool], stream: true },
        { sessionKey },
      );
      assert.equal(firstResponse.status, 200);
      assert.match(
        firstResponse.headers.get("content-type"),
        /text\/event-stream/,
      );
      const firstWire = await firstResponse.text();
      await writeFile(`${runtime.directory}/initial.sse`, firstWire);
      const events = eventsFromWire(firstWire);
      const first = events.find(
        (event) => event.type === "response.completed",
      )?.response;
      assert.ok(first, "stream has completed response");
      const call = first.output.find((item) => item.type === "function_call");
      assert.equal(call.name, "fixture_lookup");
      assert.deepEqual(JSON.parse(call.arguments), { query: "example" });
      const secondResponse = await runtime.request(
        {
          previous_response_id: first.id,
          input: [
            {
              type: "function_call_output",
              call_id: call.call_id,
              output: "application-value-42",
            },
          ],
          tools: [tool],
          stream: true,
        },
        { sessionKey },
      );
      assert.equal(secondResponse.status, 200);
      const secondWire = await secondResponse.text();
      await writeFile(`${runtime.directory}/continuation.sse`, secondWire);
      const secondEvents = eventsFromWire(secondWire);
      assert.ok(
        secondEvents.some(
          (event) =>
            event.type === "response.output_text.delta" &&
            event.delta.includes("application-value-42"),
        ),
      );
      const second = secondEvents.find(
        (event) => event.type === "response.completed",
      )?.response;
      assert.ok(second);
      const followupResponse = await runtime.request(
        {
          previous_response_id: second.id,
          input: "FOLLOWUP: recall the application result.",
          tools: [tool],
        },
        { sessionKey },
      );
      assert.equal(followupResponse.status, 200);
      const followup = await followupResponse.json();
      assert.match(followup.output[0].content[0].text, /application-value-42/);
      await writeFile(
        `${runtime.directory}/followup.json`,
        JSON.stringify(followup, null, 2),
      );
      // Pin the observed divergence: client result is projected as user text, not native tool output.
      const continuationMessages = runtime.modelRequests[1].body.messages;
      assert.ok(
        continuationMessages.some(
          (message) =>
            message.role === "user" &&
            message.content.includes("application-value-42"),
        ),
      );
      assert.ok(
        continuationMessages.some(
          (message) =>
            message.role === "tool" &&
            message.content.includes("delegated to client"),
        ),
      );

      const controller = new AbortController();
      const hanging = await runtime.request(
        { input: "HOLD_INFERENCE", tools: [tool], stream: true },
        {
          sessionKey: "agent:main:openresponses:compat-cancel",
          signal: controller.signal,
        },
      );
      assert.equal(hanging.status, 200);
      const deadline = Date.now() + 10000;
      while (runtime.modelRequests.length < 4 && Date.now() < deadline)
        await new Promise((resolve) => setTimeout(resolve, 50));
      const held = runtime.modelRequests[3];
      assert.ok(held, "real gateway started inference before cancellation");
      const disconnectedAt = Date.now();
      controller.abort();
      // Assert transport cancellation, not a fabricated completion or the 20-second timeout.
      while (!held.closed && Date.now() - disconnectedAt < 5000)
        await new Promise((resolve) => setTimeout(resolve, 100));
      const cancellation = {
        closed: held.closed,
        completed: held.completed,
        elapsedMs: Date.now() - disconnectedAt,
        agentTimeoutSeconds: 20,
      };
      await writeFile(
        `${runtime.directory}/cancellation.json`,
        JSON.stringify(cancellation, null, 2),
      );
      t.diagnostic(`Disconnect observation: ${JSON.stringify(cancellation)}`);
      assert.ok(
        held.closed,
        "upstream inference must close within five seconds of disconnect",
      );
      assert.equal(
        held.completed,
        false,
        "fixture did not manufacture completion",
      );
    } finally {
      await runtime.close();
    }
  },
);
