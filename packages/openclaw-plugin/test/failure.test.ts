import { describe, expect, it } from "vitest";

import { classifyUpstreamFailure } from "../src/runtime/handler.js";

describe("upstream failure classification", () => {
  it("maps model-provider authentication failures to a stable public error", () => {
    expect(
      classifyUpstreamFailure({
        code: "server_error",
        message:
          "No route-compatible authentication source is configured for openai.",
      }),
    ).toEqual({
      code: "agent_authentication_failed",
      message:
        "The underlying agent cannot authenticate with its configured model provider. Ask the agent operator to repair provider authentication, then start a new conversation.",
    });
  });

  it("does not expose an arbitrary upstream failure message", () => {
    const failure = classifyUpstreamFailure({
      code: "api_error",
      message: "internal path /secret and credential abc123",
    });
    expect(failure.code).toBe("agent_execution_failed");
    expect(failure.message).not.toContain("/secret");
    expect(failure.message).not.toContain("abc123");
  });
});
