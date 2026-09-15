import { describe, expect, it } from "vitest";

import { AgentConnectAdmissionController } from "../src/runtime/admission.js";

describe("Agent Connect admission controller", () => {
  it("bounds HTTP work and releases leases idempotently", () => {
    const admission = new AgentConnectAdmissionController({
      maxHttpRequests: 2,
    });
    const first = admission.tryEnterHttp();
    const second = admission.tryEnterHttp();
    expect(first).toBeDefined();
    expect(second).toBeDefined();
    expect(admission.tryEnterHttp()).toBeUndefined();

    first?.release();
    first?.release();
    expect(admission.tryEnterHttp()).toBeDefined();
  });

  it("keeps one grant from consuming every inference slot", () => {
    const admission = new AgentConnectAdmissionController({
      maxInferenceRequests: 3,
      maxInferenceRequestsPerGrant: 2,
    });
    const first = admission.tryEnterInference("grant-a");
    const second = admission.tryEnterInference("grant-a");
    expect(first.accepted).toBe(true);
    expect(second.accepted).toBe(true);
    expect(admission.tryEnterInference("grant-a")).toEqual({
      accepted: false,
      retryAfterSeconds: 1,
    });

    const other = admission.tryEnterInference("grant-b");
    expect(other.accepted).toBe(true);
    expect(admission.tryEnterInference("grant-c")).toEqual({
      accepted: false,
      retryAfterSeconds: 1,
    });

    if (first.accepted) first.lease.release();
    expect(admission.tryEnterInference("grant-c").accepted).toBe(true);
  });

  it("rate-limits each grant without an in-memory queue", () => {
    let now = 1_000;
    const admission = new AgentConnectAdmissionController({
      maxRequestsPerGrantPerMinute: 2,
      now: () => now,
    });
    for (let count = 0; count < 2; count += 1) {
      const result = admission.tryEnterInference("grant-a");
      expect(result.accepted).toBe(true);
      if (result.accepted) result.lease.release();
    }
    expect(admission.tryEnterInference("grant-a")).toEqual({
      accepted: false,
      retryAfterSeconds: 60,
    });

    now += 60_000;
    expect(admission.tryEnterInference("grant-a").accepted).toBe(true);
  });

  it("bounds tracked rate buckets", () => {
    const admission = new AgentConnectAdmissionController({
      maxTrackedGrants: 1,
    });
    const first = admission.tryEnterInference("grant-a");
    expect(first.accepted).toBe(true);
    if (first.accepted) first.lease.release();
    expect(admission.tryEnterInference("grant-b")).toEqual({
      accepted: false,
      retryAfterSeconds: 60,
    });
  });
});
