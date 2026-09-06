import assert from "node:assert/strict";
import test from "node:test";
import { isStepCount, streamText } from "ai";
import {
  createAiSdkApplicationTools,
  createAiSdkOpenResponsesGenerationOptions,
  createAiSdkOpenResponsesModel,
  selectAiSdkOpenResponsesCheckpoint,
} from "../packages/web-sdk/dist/index.js";
import { startOpenClawTestRuntime } from "./openclaw-test-runtime.mjs";

test(
  "AI SDK composes two application tools and a contextual turn through real OpenClaw",
  { timeout: 150_000 },
  async (t) => {
    const firstResult = "application-first-result-47";
    const secondResult = "application-second-result-83";
    let inferenceStep = 0;
    const runtime = await startOpenClawTestRuntime({
      onModelRequest(body, inference) {
        const toolNames = body.tools.map((entry) => entry.function.name);
        assert.deepEqual(toolNames, ["first_action", "second_action"]);
        assert.ok(
          body.tools.every((entry) => !Object.hasOwn(entry.function, "strict")),
          "unconfigured strict must stay absent from the real tool wire",
        );

        const history = JSON.stringify(body.messages);
        const latestUser = body.messages
          .filter((message) => message.role === "user")
          .at(-1)?.content;
        if (JSON.stringify(latestUser).includes("FOLLOWUP")) {
          assert.equal(occurrences(history, firstResult), 1);
          assert.equal(occurrences(history, secondResult), 1);
          assert.equal(inferenceStep, 3);
          inferenceStep = 4;
          inference.text(
            "Context retained across the native OpenClaw session.",
          );
        } else if (history.includes(secondResult)) {
          assert.equal(occurrences(history, firstResult), 1);
          assert.equal(occurrences(history, secondResult), 1);
          assert.equal(inferenceStep, 2);
          inferenceStep = 3;
          inference.text("Both application actions completed.");
        } else if (history.includes(firstResult)) {
          assert.equal(occurrences(history, firstResult), 1);
          assert.equal(inferenceStep, 1);
          inferenceStep = 2;
          inference.tool("second_action", {});
        } else {
          assert.equal(inferenceStep, 0);
          inferenceStep = 1;
          inference.tool("first_action", {});
        }
      },
    });
    t.diagnostic(`Deterministic real-OpenClaw evidence: ${runtime.directory}`);

    try {
      await proveSdkComposition(runtime, () => inferenceStep);
    } finally {
      await runtime.close();
    }
  },
);

async function proveSdkComposition(runtime, inferenceStep) {
  const sessionKey = "agent:main:openresponses:ai-sdk-composition";
  const responsesRequests = [];
  const sessionKeys = [];
  const openClawFetch = async (input, init) => {
    const headers = new Headers(init?.headers);
    headers.set("x-openclaw-agent-id", runtime.agentId);
    headers.set("x-openclaw-session-key", sessionKey);
    sessionKeys.push(headers.get("x-openclaw-session-key"));
    responsesRequests.push(JSON.parse(String(init?.body)));
    return fetch(input, { ...init, headers });
  };
  const model = createAiSdkOpenResponsesModel({
    endpoint: `${runtime.baseUrl}/v1/responses`,
    model: runtime.model,
    getAccessToken: () => runtime.token,
    fetch: openClawFetch,
  });
  const executed = [];
  const tools = createAiSdkApplicationTools(
    [
      applicationTool("first_action", () => {
        executed.push("first_action");
        return "application-first-result-47";
      }),
      applicationTool("second_action", () => {
        executed.push("second_action");
        return "application-second-result-83";
      }),
    ],
    { connectionId: "disposable-owner-token-test" },
  );

  const first = streamText({
    model,
    prompt: "Run the two application actions in order.",
    tools,
    ...createAiSdkOpenResponsesGenerationOptions(),
    stopWhen: isStepCount(5),
  });
  await first.consumeStream();
  const firstFinalStep = await first.finalStep;
  assert.equal(firstFinalStep.text, "Both application actions completed.");
  assert.deepEqual(executed, ["first_action", "second_action"]);
  const checkpoint = selectAiSdkOpenResponsesCheckpoint(
    undefined,
    firstFinalStep,
  );
  assert.ok(checkpoint);

  const followup = streamText({
    model,
    prompt: "FOLLOWUP: confirm that both prior results remain in context.",
    tools,
    ...createAiSdkOpenResponsesGenerationOptions(checkpoint),
  });
  await followup.consumeStream();
  assert.equal(
    await followup.text,
    "Context retained across the native OpenClaw session.",
  );

  assert.equal(inferenceStep(), 4);
  assert.equal(responsesRequests.length, 4);
  assert.deepEqual(sessionKeys, Array(4).fill(sessionKey));
  assert.equal(responsesRequests[0].previous_response_id, undefined);
  assert.equal(responsesRequests[1].previous_response_id != null, true);
  assert.equal(responsesRequests[2].previous_response_id != null, true);
  assert.equal(responsesRequests[3].previous_response_id, checkpoint);
  assert.deepEqual(
    responsesRequests
      .slice(1, 3)
      .map((request) => request.input.map((item) => item.type)),
    [["function_call_output"], ["function_call_output"]],
  );
  assert.deepEqual(
    responsesRequests[3].input.map((item) => item.role),
    ["user"],
  );
}

function applicationTool(name, execute) {
  return {
    name,
    description: `Execute ${name}`,
    inputSchema: { type: "object", additionalProperties: false },
    execute,
  };
}

function occurrences(value, needle) {
  return value.split(needle).length - 1;
}
