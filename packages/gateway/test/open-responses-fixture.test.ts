import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import {
  openApiDocument,
  OPEN_RESPONSES_OPENAPI_PATH,
} from "./support/openapi-schema.js";

// The plan pins the standard by commit, document version, and checksum. If the
// vendored file drifts from that pin, every schema assertion below it silently
// changes meaning, so the pin is asserted first.
describe("pinned Open Responses fixture", () => {
  it("matches the checksum recorded in the plan and ADR", () => {
    const bytes = readFileSync(OPEN_RESPONSES_OPENAPI_PATH);
    expect(createHash("sha256").update(bytes).digest("hex")).toBe(
      "693f26090d206230ed22b336681f547a2882cf5b131e86743966cf71bbdeedab",
    );
  });

  it("declares the pinned OpenAPI and document versions", () => {
    expect(openApiDocument.openapi).toBe("3.1.0");
    expect(openApiDocument.info.version).toBe("2026-04-24");
  });

  it("still requires the six inert response fields the profile renders as constants", () => {
    const resource = openApiDocument.components.schemas["ResponseResource"];
    const required = resource?.["required"] as readonly string[];
    const properties = resource?.["properties"] as Record<
      string,
      Record<string, unknown>
    >;
    for (const field of [
      "temperature",
      "top_p",
      "presence_penalty",
      "frequency_penalty",
      "top_logprobs",
      "service_tier",
    ]) {
      expect(required).toContain(field);
      // Non-nullable: this is why they cannot simply be emitted as null.
      expect(properties[field]?.["anyOf"]).toBeUndefined();
    }
  });
});
