import { describe, expect, it, vi } from "vitest";

import { assertRuntimeCurrentUnlessAborted } from "../src/readiness.js";

describe("plugin startup readiness", () => {
  it("does not inspect the applied runtime after startup is cancelled", async () => {
    const stop = new AbortController();
    const assertRuntimeCurrent = vi.fn(async () => undefined);
    stop.abort();

    await assertRuntimeCurrentUnlessAborted(stop.signal, assertRuntimeCurrent);

    expect(assertRuntimeCurrent).not.toHaveBeenCalled();
  });
});
