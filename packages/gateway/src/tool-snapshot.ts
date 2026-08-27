import { createHash } from "node:crypto";

// Narrower than the Open Responses `FunctionToolParam.name` pattern
// `^[a-zA-Z0-9_-]+$` (maxLength 64), so an approvable tool is always
// representable on the wire. The leading character stays restricted to a
// letter or underscore; a dot is not permitted because the standard's pattern
// cannot carry one.
const TOOL_NAME = /^[A-Za-z_][A-Za-z0-9_-]{0,63}$/;

export interface GatewayToolDefinition {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: Readonly<Record<string, unknown>>;
}

export function validateToolSnapshot(value: unknown): GatewayToolDefinition[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > 32) {
    throw new InvalidToolSnapshotError(
      "tools must contain between 1 and 32 definitions",
    );
  }
  const names = new Set<string>();
  return value.map((candidate) => {
    if (!isRecord(candidate)) {
      throw new InvalidToolSnapshotError("each tool must be an object");
    }
    const { name, description, inputSchema } = candidate;
    if (typeof name !== "string" || !TOOL_NAME.test(name)) {
      throw new InvalidToolSnapshotError(`invalid tool name: ${String(name)}`);
    }
    if (names.has(name)) {
      throw new InvalidToolSnapshotError(`duplicate tool name: ${name}`);
    }
    names.add(name);
    if (
      typeof description !== "string" ||
      description.length === 0 ||
      description.length > 2_000
    ) {
      throw new InvalidToolSnapshotError(
        `tool ${name} requires a description of at most 2000 characters`,
      );
    }
    if (!isRecord(inputSchema)) {
      throw new InvalidToolSnapshotError(
        `tool ${name} inputSchema must be an object`,
      );
    }
    return { name, description, inputSchema };
  });
}

export function hashToolSnapshot(
  tools: readonly GatewayToolDefinition[],
): string {
  return createHash("sha256").update(canonicalJson(tools)).digest("base64url");
}

export function hashOmnigentToolEnvelope(value: unknown): string | undefined {
  if (!Array.isArray(value)) return undefined;
  try {
    return hashToolSnapshot(
      validateToolSnapshot(
        value.map((candidate) => {
          if (!isRecord(candidate) || candidate.type !== "function") {
            throw new InvalidToolSnapshotError("invalid provider tool");
          }
          const fn = candidate.function;
          if (!isRecord(fn)) {
            throw new InvalidToolSnapshotError("invalid provider function");
          }
          return {
            name: fn.name,
            description: fn.description,
            inputSchema: fn.parameters,
          };
        }),
      ),
    );
  } catch {
    return undefined;
  }
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(",")}]`;
  }
  if (isRecord(value)) {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export class InvalidToolSnapshotError extends Error {}
