import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";

const repositoryRoot = resolve(import.meta.dirname, "../../../..");
export const OPEN_RESPONSES_OPENAPI_PATH = join(
  repositoryRoot,
  "contract/open-responses/openapi.json",
);

interface OpenApiDocument {
  readonly openapi: string;
  readonly info: { readonly version: string };
  readonly components: {
    readonly schemas: Record<string, Record<string, unknown>>;
  };
}

export const openApiDocument = JSON.parse(
  readFileSync(OPEN_RESPONSES_OPENAPI_PATH, "utf8"),
) as OpenApiDocument;

/**
 * A deliberately small JSON Schema evaluator covering the keywords the pinned
 * Open Responses document actually uses for the version 0 shapes. It exists so
 * that gateway output is checked against the standard's own schemas instead of
 * against hand-written expectations; it is not a general validator.
 */
export function validateAgainstSchema(
  schemaName: string,
  value: unknown,
): readonly string[] {
  const schema = openApiDocument.components.schemas[schemaName];
  if (!schema) return [`unknown schema: ${schemaName}`];
  const errors: string[] = [];
  check(schema, value, schemaName, errors);
  return errors;
}

function resolveSchema(
  schema: Record<string, unknown>,
): Record<string, unknown> {
  const reference = schema["$ref"];
  if (typeof reference !== "string") return schema;
  const name = reference.replace("#/components/schemas/", "");
  const target = openApiDocument.components.schemas[name];
  if (!target) throw new Error(`unresolvable $ref: ${reference}`);
  return resolveSchema(target);
}

function check(
  rawSchema: Record<string, unknown>,
  value: unknown,
  path: string,
  errors: string[],
): void {
  const schema = resolveSchema(rawSchema);

  for (const key of ["anyOf", "oneOf"] as const) {
    const branches = schema[key];
    if (Array.isArray(branches)) {
      const matched = branches.some((branch) => {
        const branchErrors: string[] = [];
        check(branch as Record<string, unknown>, value, path, branchErrors);
        return branchErrors.length === 0;
      });
      if (!matched) errors.push(`${path}: matched no ${key} branch`);
      return;
    }
  }
  const allOf = schema["allOf"];
  if (Array.isArray(allOf)) {
    for (const branch of allOf) {
      check(branch as Record<string, unknown>, value, path, errors);
    }
  }

  const enumeration = schema["enum"];
  if (Array.isArray(enumeration) && !enumeration.includes(value)) {
    errors.push(`${path}: ${JSON.stringify(value)} is not one of the enum`);
  }

  const type = schema["type"];
  if (typeof type === "string" && !matchesType(type, value)) {
    errors.push(`${path}: expected ${type}, received ${describe(value)}`);
    return;
  }

  if (typeof value === "string") {
    const maxLength = schema["maxLength"];
    if (typeof maxLength === "number" && value.length > maxLength) {
      errors.push(`${path}: longer than maxLength ${maxLength}`);
    }
    const minLength = schema["minLength"];
    if (typeof minLength === "number" && value.length < minLength) {
      errors.push(`${path}: shorter than minLength ${minLength}`);
    }
    const pattern = schema["pattern"];
    if (typeof pattern === "string" && !new RegExp(pattern).test(value)) {
      errors.push(`${path}: does not match pattern ${pattern}`);
    }
  }

  if (Array.isArray(value)) {
    const items = schema["items"];
    if (isRecord(items)) {
      value.forEach((entry, index) => {
        check(items, entry, `${path}[${index}]`, errors);
      });
    }
    return;
  }

  if (!isRecord(value)) return;

  const required = schema["required"];
  if (Array.isArray(required)) {
    for (const key of required) {
      if (typeof key === "string" && !(key in value)) {
        errors.push(`${path}: missing required property ${key}`);
      }
    }
  }
  const properties = schema["properties"];
  if (isRecord(properties)) {
    for (const [key, propertySchema] of Object.entries(properties)) {
      if (!(key in value) || !isRecord(propertySchema)) continue;
      check(propertySchema, value[key], `${path}.${key}`, errors);
    }
    if (schema["additionalProperties"] === false) {
      for (const key of Object.keys(value)) {
        if (!(key in properties)) {
          errors.push(`${path}: unexpected property ${key}`);
        }
      }
    }
  }
}

function matchesType(type: string, value: unknown): boolean {
  switch (type) {
    case "object":
      return isRecord(value);
    case "array":
      return Array.isArray(value);
    case "string":
      return typeof value === "string";
    case "number":
      return typeof value === "number";
    case "integer":
      return typeof value === "number" && Number.isInteger(value);
    case "boolean":
      return typeof value === "boolean";
    case "null":
      return value === null;
    default:
      return true;
  }
}

function describe(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  return typeof value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Maps a produced stream event onto the pinned schema that describes it. */
export function streamingEventSchemaName(type: string): string {
  const names: Readonly<Record<string, string>> = {
    "response.created": "ResponseCreatedStreamingEvent",
    "response.in_progress": "ResponseInProgressStreamingEvent",
    "response.completed": "ResponseCompletedStreamingEvent",
    "response.failed": "ResponseFailedStreamingEvent",
    "response.incomplete": "ResponseIncompleteStreamingEvent",
    "response.output_item.added": "ResponseOutputItemAddedStreamingEvent",
    "response.output_item.done": "ResponseOutputItemDoneStreamingEvent",
    "response.content_part.added": "ResponseContentPartAddedStreamingEvent",
    "response.content_part.done": "ResponseContentPartDoneStreamingEvent",
    "response.output_text.delta": "ResponseOutputTextDeltaStreamingEvent",
    "response.output_text.done": "ResponseOutputTextDoneStreamingEvent",
    "response.function_call_arguments.done":
      "ResponseFunctionCallArgumentsDoneStreamingEvent",
    error: "ErrorStreamingEvent",
  };
  const name = names[type];
  if (!name) throw new Error(`no pinned schema for event type ${type}`);
  return name;
}
