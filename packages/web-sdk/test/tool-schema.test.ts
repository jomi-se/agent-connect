import { describe, expect, it } from "vitest";
import { createToolValidator } from "../src/tool-schema.js";
import type { JsonSchema } from "../src/types.js";

describe("CSP-safe tool schema validation", () => {
  it("rejects nested multipleOf before invocation and retains integer meta constraints", () => {
    expect(() =>
      createToolValidator({
        type: "object",
        properties: { n: { type: "number", multipleOf: 1 } },
      }),
    ).toThrow("multipleOf is not supported by the CSP-safe validator");
    expect(() => createToolValidator({ minItems: 1e-8 })).toThrow(
      "Invalid application tool schema",
    );
  });
  it.each([
    [{ type: "string", nullable: true }, null, true],
    [{ type: "string", nullable: true, enum: ["yes"] }, null, false],
    [{ type: "string", format: "email" }, "not-email", true],
    [{ type: "object", unevaluatedProperties: false }, { x: 1 }, true],
    [{ type: "array", prefixItems: [{ type: "string" }] }, [1], true],
    [
      { type: "array", contains: { type: "integer" }, minContains: 2 },
      [1],
      true,
    ],
    [{ type: "string", pattern: "^.$" }, "😀", true],
    [{ type: "number", minimum: 1, maximum: 5 }, 6, false],
  ] satisfies [JsonSchema, unknown, boolean][])(
    "preserves measured schema semantics: %j",
    (schema, value, expected) => {
      expect(createToolValidator(schema)(value).valid).toBe(expected);
    },
  );

  it.each([
    { properties: { x: { type: 42 } } },
    { properties: { x: { $ref: "#/missing" } } },
    { properties: { x: { pattern: "[" } } },
    { patternProperties: { "[": {} } },
    { $schema: "https://json-schema.org/draft/2020-12/schema" },
    { nullable: true },
    { type: "null", nullable: false },
    { $ref: "#/missing", __absolute_ref__: "https://github.com/cfworker" },
  ] as JsonSchema[])(
    "rejects unusable schemas before any invocation: %j",
    (schema) => {
      expect(() => createToolValidator(schema)).toThrow();
    },
  );

  it("preserves local refs, ref siblings, and original allOf pointer locations", () => {
    const validator = createToolValidator({
      definitions: { number: { type: "number" } },
      properties: {
        x: {
          $ref: "#/definitions/number",
          minimum: 2,
          allOf: [{ maximum: 4 }],
        },
        y: { $ref: "#/properties/x/allOf/0" },
      },
      allOf: [{ properties: { x: { maximum: 4 } } }],
    });
    expect(validator({ x: 1 }).valid).toBe(false);
    expect(validator({ x: 3 }).valid).toBe(true);
    expect(validator({ x: 5 }).valid).toBe(false);
    expect(validator({ y: 5 }).valid).toBe(false);
  });

  it("keeps recursive refs and dependencies on the interpreter", () => {
    const validator = createToolValidator({
      type: "object",
      properties: { value: { type: "integer" }, child: { $ref: "" } },
      dependencies: { child: ["value"] },
      additionalProperties: false,
    });
    expect(validator({ value: 1, child: { value: 2 } }).valid).toBe(true);
    expect(validator({ value: 1, child: { value: "bad" } }).valid).toBe(false);
    expect(validator({ child: {} }).valid).toBe(false);
  });

  it("does not mutate frozen schemas or data, and owns its snapshot", () => {
    const property = { type: "string", nullable: true, default: "default" };
    const schema = {
      type: "object",
      properties: { x: property },
      additionalProperties: false,
    };
    const validator = createToolValidator(schema);
    property.type = "number";
    expect(validator({ x: "yes" }).valid).toBe(true);
    expect(validator({ x: 1 }).valid).toBe(false);
    const data = Object.freeze({});
    expect(validator(data).valid).toBe(true);
    expect(data).toEqual({});
    const frozen = Object.freeze({
      type: "object",
      properties: Object.freeze({ x: Object.freeze({ type: "string" }) }),
    });
    expect(createToolValidator(frozen)({ x: "yes" }).valid).toBe(true);
    expect(Object.getOwnPropertyNames(frozen)).toEqual(["type", "properties"]);
  });
});
