import assert from "node:assert/strict";
import test from "node:test";
import { validateOperatorEnvironment } from "./openclaw-gateway.mjs";

const valid = {
  OPENCLAW_BASE_URL: "http://127.0.0.1:18789",
  OPENCLAW_TOKEN: "test-only",
  OPENCLAW_AGENT_ID: "main",
  AGENT_CONNECT_STATE_PATH: "/tmp/test-state.json",
  AGENT_CONNECT_PUBLIC_ENDPOINT: "https://gateway.example",
};
test("operator launcher fails closed on missing authority and unsafe upstream routing", () => {
  assert.doesNotThrow(() => validateOperatorEnvironment(valid));
  for (const key of Object.keys(valid))
    assert.throws(() => validateOperatorEnvironment({ ...valid, [key]: "" }));
  for (const baseUrl of [
    "http://remote.example",
    "https://user:secret@remote.example",
    "https://remote.example/v1",
    "https://remote.example?token=secret",
    "file:///tmp/a",
  ]) {
    assert.throws(() =>
      validateOperatorEnvironment({ ...valid, OPENCLAW_BASE_URL: baseUrl }),
    );
  }
  assert.throws(() =>
    validateOperatorEnvironment({ ...valid, AGENT_CONNECT_HOST: "0.0.0.0" }),
  );
  assert.throws(() =>
    validateOperatorEnvironment({
      ...valid,
      AGENT_CONNECT_STATE_PATH: "relative.json",
    }),
  );
  assert.throws(() =>
    validateOperatorEnvironment({
      ...valid,
      OPENCLAW_AGENT_ID: "main:foreign",
    }),
  );
});
