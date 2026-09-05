import assert from "node:assert/strict";
import test from "node:test";
import { isSupportedOpenClawNode } from "./openclaw-test-runtime.mjs";

test("supported operator/test profile is Node 24 LTS >=24.15, not every newer major", () => {
  for (const version of [
    "22.22.3",
    "23.11.0",
    "24.14.9",
    "25.0.0",
    "25.9.0",
    "26.0.0",
  ]) {
    assert.equal(isSupportedOpenClawNode(version), false, version);
  }
  for (const version of ["24.15.0", "24.15.1", "24.16.0"]) {
    assert.equal(isSupportedOpenClawNode(version), true, version);
  }
});
