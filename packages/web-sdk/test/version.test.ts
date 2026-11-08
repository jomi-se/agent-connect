import { describe, expect, it } from "vitest";
import manifest from "../package.json" with { type: "json" };
import { SDK_VERSION } from "../src/version.js";

describe("SDK_VERSION", () => {
  it("is the version in package.json", () => {
    expect(SDK_VERSION).toBe(manifest.version);
  });
});
