import { describe, expect, it } from "vitest";

import type { VerifiedDelegatedGrant } from "../src/delegated-grants.js";
import {
  AgentConnectRequestError,
  buildBoundedUpstreamRequest,
} from "../src/runtime/request.js";

const grant = {
  applicationTools: [],
} as unknown as VerifiedDelegatedGrant;

describe("hosted Responses request bounds", () => {
  it("allows large transformation text within the total request envelope", () => {
    const largeHtml = `<article>${"text".repeat(32 * 1024)}</article>`;
    const result = buildBoundedUpstreamRequest(
      {
        model: "openclaw/default",
        input: largeHtml,
        instructions: largeHtml,
        tools: [],
      },
      grant,
    );
    expect(result.upstreamBody.input).toBe(largeHtml);
    expect(result.upstreamBody.instructions).toBe(largeHtml);
  });

  it("allows an explicit 65,536-token output request", () => {
    const result = buildBoundedUpstreamRequest(
      {
        model: "openclaw/default",
        input: "Rewrite the supplied HTML",
        tools: [],
        max_output_tokens: 65_536,
      },
      grant,
    );
    expect(result.upstreamBody.max_output_tokens).toBe(65_536);
  });

  it("still rejects output requests above the generous safety ceiling", () => {
    expect(() =>
      buildBoundedUpstreamRequest(
        {
          model: "openclaw/default",
          input: "Rewrite the supplied HTML",
          tools: [],
          max_output_tokens: 65_537,
        },
        grant,
      ),
    ).toThrow(AgentConnectRequestError);
  });
});
