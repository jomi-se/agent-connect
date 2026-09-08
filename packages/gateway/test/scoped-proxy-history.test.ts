import { describe, expect, it } from "vitest";
import { projectExecutionHistory } from "../src/scoped-proxy/history.js";

describe("execution history projection", () => {
  it("does not claim input authorship or expose reasoning, instructions and tool placeholders", () => {
    expect(
      projectExecutionHistory({
        sessionKey: "private",
        messages: [
          { role: "system", content: "private instructions" },
          { role: "developer", content: "private instructions" },
          {
            role: "user",
            content: [{ type: "text", text: "42" }],
            __openclaw: { senderIsOwner: true },
          },
          {
            role: "assistant",
            content: [
              { type: "thinking", text: "private reasoning" },
              { type: "toolCall", name: "private" },
              { type: "text", text: "done" },
            ],
          },
          { role: "toolResult", content: "pending" },
        ],
      }),
    ).toEqual({
      projection: "execution-history",
      entries: [
        { kind: "input", text: "42" },
        { kind: "assistant", text: "done" },
      ],
      truncated: false,
    });
  });
  it("bounds projected text and preserves the upstream partial-history flag", () => {
    const result = projectExecutionHistory({
      hasMore: true,
      messages: Array.from({ length: 200 }, () => ({
        role: "user",
        content: "x".repeat(20_000),
      })),
    });
    expect(result.truncated).toBe(true);
    expect(
      result.entries.reduce((size, entry) => size + entry.text.length, 0),
    ).toBe(128 * 1024);
    expect(() => projectExecutionHistory({})).toThrow(
      "Invalid upstream history",
    );
  });
});
