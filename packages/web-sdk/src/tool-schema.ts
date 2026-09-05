import {
  dereference,
  validate,
  Validator,
  type Schema,
  type ValidationResult,
} from "@cfworker/json-schema";
import { draft7MetaSchema } from "./draft7-meta-schema.js";
import type { JsonSchema } from "./types.js";

const metaValidator = new Validator(draft7MetaSchema, "7", false);
const schemaMaps = ["properties", "patternProperties", "definitions", "$defs"];
const schemaSingles = [
  "additionalProperties",
  "additionalItems",
  "contains",
  "propertyNames",
  "not",
  "if",
  "then",
  "else",
];
// The previous draft-7 Ajv instance ignored these; cfworker otherwise interprets
// them even with draft="7". Do not accidentally strengthen the public contract.
const laterKeywords = [
  "$anchor",
  "$dynamicAnchor",
  "$dynamicRef",
  "$recursiveAnchor",
  "$recursiveRef",
  "$vocabulary",
  "prefixItems",
  "unevaluatedItems",
  "unevaluatedProperties",
  "dependentRequired",
  "dependentSchemas",
  "minContains",
  "maxContains",
];

/** An interpreting, immutable validator for dynamic application tool schemas. */
export function createToolValidator(
  input: JsonSchema,
): (value: unknown) => ValidationResult {
  // cfworker annotates its schema with internal reference locations. Both that
  // mutation and our compatibility normalization must stay off caller snapshots.
  const schema = JSON.parse(JSON.stringify(input)) as Schema;
  const validity = metaValidator.validate(schema);
  if (!validity.valid) {
    throw new TypeError(
      `Invalid application tool schema: ${describeErrors(validity)}`,
    );
  }
  normalize(schema);
  const lookup = dereference(schema);
  for (const candidate of Object.values(lookup)) {
    if (typeof candidate === "boolean") continue;
    if (candidate.$ref !== undefined) {
      const ref = candidate.__absolute_ref__ ?? candidate.$ref;
      if (lookup[ref] === undefined) {
        throw new TypeError(
          `Unresolved application tool schema reference: ${candidate.$ref}`,
        );
      }
    }
  }
  return (value) => validate(value, schema, "7", lookup, false);
}

export function describeErrors(result: ValidationResult): string {
  return result.errors
    .map((error) => `${error.instanceLocation} ${error.error}`)
    .join("; ");
}

function normalize(schema: Schema | boolean): void {
  if (typeof schema === "boolean") return;
  // cfworker's multipleOf tolerance can accept nonmultiples. Fail closed until
  // the interpreter can preserve this constraint without weakening validation.
  if (schema.multipleOf !== undefined) {
    throw new TypeError(
      "multipleOf is not supported by the CSP-safe validator",
    );
  }
  // These are interpreter-owned annotations, never caller-controlled hints.
  delete schema.__absolute_uri__;
  delete schema.__absolute_ref__;
  delete schema.__absolute_recursive_ref__;
  if (
    schema.$schema !== undefined &&
    !/^https?:\/\/json-schema\.org\/draft-07\/schema#?$/.test(schema.$schema)
  ) {
    throw new TypeError(
      `Unsupported application tool schema dialect: ${schema.$schema}`,
    );
  }
  if (schema.id !== undefined || schema.$async !== undefined) {
    throw new TypeError(
      "Unsupported application tool schema keyword: id or $async",
    );
  }
  if (schema.nullable !== undefined) {
    if (typeof schema.nullable !== "boolean" || schema.type === undefined) {
      throw new TypeError(
        "Application tool schema nullable requires a type and a boolean value",
      );
    }
    const types = Array.isArray(schema.type) ? schema.type : [schema.type];
    if (schema.nullable === false && types.includes("null")) {
      throw new TypeError(
        "Application tool schema nullable:false conflicts with type:null",
      );
    }
    if (schema.nullable && !types.includes("null"))
      schema.type = [...types, "null"];
    delete schema.nullable;
  }
  // Ajv without ajv-formats treated formats as annotations, including custom ones.
  delete schema.format;
  for (const keyword of laterKeywords) delete schema[keyword];
  if (schema.pattern !== undefined) new RegExp(schema.pattern, "u");
  for (const pattern of Object.keys(schema.patternProperties ?? {}))
    new RegExp(pattern, "u");
  for (const keyword of schemaMaps) {
    const map = schema[keyword] as Record<string, Schema | boolean> | undefined;
    if (map) {
      for (const child of Object.values(map)) {
        // $defs is accepted by Ajv but not covered by the draft-7 meta-schema.
        if (keyword === "$defs" && !metaValidator.validate(child).valid) {
          throw new TypeError("Invalid application tool schema definition");
        }
        normalize(child);
      }
    }
  }
  for (const keyword of schemaSingles) {
    const child = schema[keyword] as Schema | boolean | undefined;
    if (child !== undefined) normalize(child);
  }
  for (const keyword of ["allOf", "anyOf", "oneOf", "items"]) {
    const child = schema[keyword] as
      Schema | boolean | (Schema | boolean)[] | undefined;
    if (Array.isArray(child)) child.forEach(normalize);
    else if (child !== undefined) normalize(child);
  }
  for (const child of Object.values(schema.dependencies ?? {})) {
    if (!Array.isArray(child)) normalize(child);
  }
  // Ajv applies $ref siblings even in draft 7. Keep the reference at its original
  // location (including $id scope), but select cfworker's sibling-aware behavior
  // locally through an equivalent allOf rather than switching the entire draft.
  if (schema.$ref !== undefined) {
    const ref = schema.$ref || "#";
    delete schema.$ref;
    schema.allOf = [...(schema.allOf ?? []), { $ref: ref }];
  }
}
