import { describe, expect, it } from "vitest";

import { ResponseApiError } from "../src/responses/errors.js";
import { parseResponseRequest } from "../src/responses/profile.js";
import { AGENT_CONNECT_MODEL } from "../src/responses/protocol.js";
import {
  hashToolSnapshot,
  validateToolSnapshot,
} from "../src/tool-snapshot.js";

const tools = validateToolSnapshot([
  {
    name: "set_page_message",
    description: "Replace the visible page message",
    inputSchema: {
      type: "object",
      properties: { message: { type: "string" } },
      required: ["message"],
      additionalProperties: false,
    },
  },
]);
const approved = { tools, toolHash: hashToolSnapshot(tools) };
const wireTools = tools.map((tool) => ({
  type: "function",
  name: tool.name,
  description: tool.description,
  parameters: tool.inputSchema,
}));

function parse(body: Record<string, unknown>) {
  return parseResponseRequest(body, approved);
}

function failureOf(body: Record<string, unknown>): ResponseApiError {
  try {
    parse(body);
  } catch (error) {
    if (error instanceof ResponseApiError) return error;
    throw error;
  }
  throw new Error("expected the profile to reject this request");
}

describe("version 0 request profile", () => {
  describe("accepted", () => {
    it("takes a bare string input as the initial user message", () => {
      expect(parse({ model: AGENT_CONNECT_MODEL, input: "hello" })).toEqual({
        kind: "initial",
        stream: false,
        prompt: "hello",
      });
    });

    it("takes one user message with one input_text part", () => {
      expect(
        parse({
          model: AGENT_CONNECT_MODEL,
          stream: true,
          input: [
            {
              type: "message",
              role: "user",
              content: [{ type: "input_text", text: "hello" }],
            },
          ],
        }),
      ).toEqual({ kind: "initial", stream: true, prompt: "hello" });
    });

    it("takes one user message with string content", () => {
      expect(
        parse({
          model: AGENT_CONNECT_MODEL,
          input: [{ type: "message", role: "user", content: "hello" }],
        }),
      ).toEqual({ kind: "initial", stream: false, prompt: "hello" });
    });

    it("accepts the exact approved snapshot on the wire", () => {
      expect(
        parse({ model: AGENT_CONNECT_MODEL, input: "hi", tools: wireTools })
          .kind,
      ).toBe("initial");
    });

    it("accepts strict: true, which the profile fixes rather than negotiates", () => {
      expect(
        parse({
          model: AGENT_CONNECT_MODEL,
          input: "hi",
          tools: wireTools.map((tool) => ({ ...tool, strict: true })),
        }).kind,
      ).toBe("initial");
    });

    it("accepts the permitted defaults spelled out explicitly", () => {
      expect(
        parse({
          model: AGENT_CONNECT_MODEL,
          input: "hi",
          tool_choice: "auto",
          parallel_tool_calls: false,
          store: true,
          previous_response_id: null,
        }).kind,
      ).toBe("initial");
    });

    it("treats an explicit null on an unsupported field as absent", () => {
      // Several standard clients serialize unset options as null.
      expect(
        parse({
          model: AGENT_CONNECT_MODEL,
          input: "hi",
          temperature: null,
          metadata: null,
          instructions: null,
        }).kind,
      ).toBe("initial");
    });

    it("takes one function_call_output as a continuation", () => {
      expect(
        parse({
          model: AGENT_CONNECT_MODEL,
          previous_response_id: "resp_1",
          input: [
            {
              type: "function_call_output",
              call_id: "call_1",
              output: '{"ok":true}',
            },
          ],
        }),
      ).toEqual({
        kind: "continuation",
        stream: false,
        previousResponseId: "resp_1",
        callId: "call_1",
        output: '{"ok":true}',
      });
    });
  });

  describe("rejected", () => {
    const cases: readonly [string, Record<string, unknown>, string, string][] =
      [
        [
          "a different model",
          { model: "gpt-5.2", input: "hi" },
          "model_not_found",
          "model",
        ],
        ["a missing model", { input: "hi" }, "model_not_found", "model"],
        [
          "an unknown field",
          { model: AGENT_CONNECT_MODEL, input: "hi", agent_connect: true },
          "invalid_request",
          "agent_connect",
        ],
        [
          "a sampling field",
          { model: AGENT_CONNECT_MODEL, input: "hi", temperature: 0.2 },
          "unsupported_feature",
          "temperature",
        ],
        [
          "the constant profile's own value supplied by the client",
          { model: AGENT_CONNECT_MODEL, input: "hi", temperature: 1 },
          "unsupported_feature",
          "temperature",
        ],
        [
          "instructions",
          { model: AGENT_CONNECT_MODEL, input: "hi", instructions: "be terse" },
          "unsupported_feature",
          "instructions",
        ],
        [
          "background mode",
          { model: AGENT_CONNECT_MODEL, input: "hi", background: true },
          "unsupported_feature",
          "background",
        ],
        [
          "store: false",
          { model: AGENT_CONNECT_MODEL, input: "hi", store: false },
          "unsupported_feature",
          "store",
        ],
        [
          "a forced tool choice",
          {
            model: AGENT_CONNECT_MODEL,
            input: "hi",
            tool_choice: { type: "function", name: "set_page_message" },
          },
          "unsupported_feature",
          "tool_choice",
        ],
        [
          "required tool choice",
          { model: AGENT_CONNECT_MODEL, input: "hi", tool_choice: "required" },
          "unsupported_feature",
          "tool_choice",
        ],
        [
          "parallel tool calls",
          {
            model: AGENT_CONNECT_MODEL,
            input: "hi",
            parallel_tool_calls: true,
          },
          "unsupported_feature",
          "parallel_tool_calls",
        ],
        [
          "an assistant message",
          {
            model: AGENT_CONNECT_MODEL,
            input: [{ type: "message", role: "assistant", content: "hello" }],
          },
          "unsupported_feature",
          "input",
        ],
        [
          "an image content part",
          {
            model: AGENT_CONNECT_MODEL,
            input: [
              {
                type: "message",
                role: "user",
                content: [{ type: "input_image", image_url: "https://x/y" }],
              },
            ],
          },
          "unsupported_feature",
          "input",
        ],
        [
          "two input items",
          {
            model: AGENT_CONNECT_MODEL,
            input: [
              { type: "message", role: "user", content: "a" },
              { type: "message", role: "user", content: "b" },
            ],
          },
          "unsupported_feature",
          "input",
        ],
        [
          "an empty prompt",
          { model: AGENT_CONNECT_MODEL, input: "  " },
          "invalid_request",
          "input",
        ],
        [
          "two function outputs in one continuation",
          {
            model: AGENT_CONNECT_MODEL,
            previous_response_id: "resp_1",
            input: [
              { type: "function_call_output", call_id: "c1", output: "{}" },
              { type: "function_call_output", call_id: "c2", output: "{}" },
            ],
          },
          "unsupported_feature",
          "input",
        ],
        [
          "a non-string function output",
          {
            model: AGENT_CONNECT_MODEL,
            previous_response_id: "resp_1",
            input: [
              { type: "function_call_output", call_id: "c1", output: { a: 1 } },
            ],
          },
          "unsupported_feature",
          "input",
        ],
        [
          "a call_id longer than the pinned maximum",
          {
            model: AGENT_CONNECT_MODEL,
            previous_response_id: "resp_1",
            input: [
              {
                type: "function_call_output",
                call_id: "c".repeat(65),
                output: "{}",
              },
            ],
          },
          "invalid_request",
          "input",
        ],
        [
          "a hosted tool",
          {
            model: AGENT_CONNECT_MODEL,
            input: "hi",
            tools: [{ type: "web_search" }],
          },
          "unsupported_feature",
          "tools",
        ],
        [
          "strict: false",
          {
            model: AGENT_CONNECT_MODEL,
            input: "hi",
            tools: wireTools.map((tool) => ({ ...tool, strict: false })),
          },
          "tool_snapshot_mismatch",
          "tools",
        ],
        [
          "a mutated tool description",
          {
            model: AGENT_CONNECT_MODEL,
            input: "hi",
            tools: wireTools.map((tool) => ({
              ...tool,
              description: "Do something else entirely",
            })),
          },
          "tool_snapshot_mismatch",
          "tools",
        ],
        [
          "an added tool",
          {
            model: AGENT_CONNECT_MODEL,
            input: "hi",
            tools: [
              ...wireTools,
              {
                type: "function",
                name: "exfiltrate",
                description: "Not approved",
                parameters: { type: "object" },
              },
            ],
          },
          "tool_snapshot_mismatch",
          "tools",
        ],
        [
          "a dotted tool name the wire cannot carry",
          {
            model: AGENT_CONNECT_MODEL,
            input: "hi",
            tools: [
              {
                type: "function",
                name: "app.doThing",
                description: "Dotted",
                parameters: { type: "object" },
              },
            ],
          },
          "tool_snapshot_mismatch",
          "tools",
        ],
      ];

    it.each(cases)("rejects %s", (_label, body, code, param) => {
      const error = failureOf(body);
      expect(error.code).toBe(code);
      expect(error.param).toBe(param);
    });

    it("rejects a non-object body", () => {
      expect(() => parseResponseRequest("hello", approved)).toThrow(
        ResponseApiError,
      );
    });
  });

  describe("error envelope", () => {
    it("carries a stable status, type, code, message, and param", () => {
      const error = failureOf({
        model: AGENT_CONNECT_MODEL,
        input: "hi",
        temperature: 0.2,
      });
      expect(error.status).toBe(400);
      expect(error.toBody()).toEqual({
        error: {
          type: "invalid_request_error",
          code: "unsupported_feature",
          message: expect.any(String),
          param: "temperature",
        },
      });
    });

    it("maps a snapshot mismatch to 403", () => {
      expect(
        failureOf({
          model: AGENT_CONNECT_MODEL,
          input: "hi",
          tools: [
            {
              type: "function",
              name: "exfiltrate",
              description: "Not approved",
              parameters: { type: "object" },
            },
          ],
        }).status,
      ).toBe(403);
    });
  });
});
