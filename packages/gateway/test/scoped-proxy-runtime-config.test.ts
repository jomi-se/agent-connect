import { describe, expect, it, vi } from "vitest";

import { createOpenClawRuntimePolicyVerifier } from "../src/scoped-proxy/runtime-config.js";

describe("stock OpenClaw runtime configuration fence", () => {
  it("pins the server-issued applied revision and checks every admission", async () => {
    const readConfig = vi.fn(async () => snapshot("revision-a"));
    const validateSourceConfig = vi.fn();
    const verifier = await createOpenClawRuntimePolicyVerifier({
      readConfig,
      validateSourceConfig,
    });
    expect(verifier.appliedConfigHash).toBe("revision-a");
    await verifier.assertCurrent();
    expect(readConfig).toHaveBeenCalledTimes(2);
    expect(validateSourceConfig).toHaveBeenCalledTimes(2);
  });

  it("fails closed for missing, unapplied or changed runtime revisions", async () => {
    await expect(
      createOpenClawRuntimePolicyVerifier({
        readConfig: async () => ({
          ...snapshot("revision-a"),
          appliedConfigHash: null,
        }),
        validateSourceConfig() {},
      }),
    ).rejects.toThrow(/omitted its saved or applied/);

    await expect(
      createOpenClawRuntimePolicyVerifier({
        readConfig: async () => ({
          ...snapshot("revision-a"),
          configRevisionHash: "revision-b",
        }),
        validateSourceConfig() {},
      }),
    ).rejects.toThrow(/not the revision applied/);

    let revision = "revision-a";
    const verifier = await createOpenClawRuntimePolicyVerifier({
      readConfig: async () => snapshot(revision),
      validateSourceConfig() {},
    });
    revision = "revision-b";
    await expect(verifier.assertCurrent()).rejects.toThrow(/changed/);
  });
});

function snapshot(revision: string) {
  return {
    valid: true,
    hash: `raw-${revision}`,
    configRevisionHash: revision,
    appliedConfigHash: revision,
    sourceConfig: { gateway: { auth: { token: "__OPENCLAW_REDACTED__" } } },
  };
}
