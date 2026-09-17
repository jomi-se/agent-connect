import { describe, expect, it } from "vitest";

import {
  InvalidToolSnapshotError,
  hashToolSnapshot,
  validateToolSnapshot,
} from "../src/tool-snapshot.js";

function tool(name: string) {
  return {
    name,
    description: "Set one visible page message",
    inputSchema: {
      type: "object",
      properties: { message: { type: "string" } },
      required: ["message"],
      additionalProperties: false,
    },
  };
}

// The Open Responses `FunctionToolParam.name` pattern is `^[a-zA-Z0-9_-]+$`
// with maxLength 64. The snapshot validator must stay inside it so that every
// approvable tool can be rendered on the wire and inside a hashed grant.
const OPEN_RESPONSES_TOOL_NAME = /^[a-zA-Z0-9_-]{1,64}$/;

describe("tool name charset", () => {
  const accepted = [
    "set_page_message",
    "getState",
    "a",
    "_private",
    "add-comment",
    `a${"b".repeat(63)}`,
  ];

  for (const name of accepted) {
    it(`accepts ${name} and stays representable on the wire`, () => {
      expect(validateToolSnapshot([tool(name)])).toHaveLength(1);
      expect(OPEN_RESPONSES_TOOL_NAME.test(name)).toBe(true);
    });
  }

  const rejected = [
    ["a dotted name the standard pattern cannot carry", "app.doThing"],
    ["a leading digit", "1tool"],
    ["a leading hyphen", "-tool"],
    ["a name over 64 characters", `a${"b".repeat(64)}`],
    ["an empty name", ""],
    ["a name with a space", "set page"],
  ] as const;

  for (const [reason, name] of rejected) {
    it(`rejects ${reason}`, () => {
      expect(() => validateToolSnapshot([tool(name)])).toThrow(
        InvalidToolSnapshotError,
      );
    });
  }
});

describe("snapshot hashing", () => {
  it("is stable across property order", () => {
    const ordered = hashToolSnapshot(validateToolSnapshot([tool("a_tool")]));
    const reordered = hashToolSnapshot(
      validateToolSnapshot([
        {
          inputSchema: tool("a_tool").inputSchema,
          name: "a_tool",
          description: "Set one visible page message",
        },
      ]),
    );
    expect(reordered).toBe(ordered);
  });

  it("differs when a definition differs", () => {
    expect(hashToolSnapshot(validateToolSnapshot([tool("a_tool")]))).not.toBe(
      hashToolSnapshot(validateToolSnapshot([tool("b_tool")])),
    );
  });
});
