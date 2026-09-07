import { describe, expect, it } from "vitest";

import type { VerifiedDelegatedGrant } from "../src/delegated-grants.js";
import { ContinuationRegistry } from "../src/scoped-proxy/continuations.js";

const grant = {
  grantId: "ac_grant_fixture",
  authorizationVersion: "authorization-version",
  accessTokenVersion: "access-version-one",
  accessTokenExpiresAt: "2099-01-01T00:00:00.000Z",
  subject: "agent-connect:grant:ac_grant_fixture",
  ownerSubject: "local-owner",
  clientId: "https://app.example",
  resource: "https://gateway.example/v1/responses",
  agentId: "restricted",
  policyRef: "application-tools-only",
  policyFingerprint: "sha256:policy",
  nativeCapabilities: [],
  applicationTools: [],
  toolHash: "sha256:tools",
  createdAt: "2026-09-07T00:00:00.000Z",
  grantExpiresAt: "2099-01-01T00:00:00.000Z",
} satisfies VerifiedDelegatedGrant;

describe("bounded continuation registry", () => {
  it("uses a canonical private key, preserves grant identity across refresh and consumes linearly", () => {
    const registry = new ContinuationRegistry();
    const reservation = registry.reserveNew(grant);
    expect(reservation.sessionKey).toMatch(
      /^agent:restricted:openresponses:agent-connect-[a-f0-9]+$/,
    );
    expect(registry.reserveResponseId(reservation, "resp_1")).toBe(true);
    registry.complete(reservation, "resp_1", ["call_1"]);
    const refreshed = { ...grant, accessTokenVersion: "access-version-two" };
    expect(registry.peek("resp_1", refreshed)?.pendingCallIds).toEqual([
      "call_1",
    ]);
    const continuation = registry.consume("resp_1", refreshed);
    expect(continuation?.sessionKey).toBe(reservation.sessionKey);
    expect(registry.peek("resp_1", refreshed)).toBeUndefined();
    expect(
      registry.reserveResponseId(
        continuation as NonNullable<typeof continuation>,
        "resp_1",
      ),
    ).toBe(false);
    registry.fail(continuation as NonNullable<typeof continuation>);
  });

  it("loses authority on expiry, failed admission and process restart", () => {
    let now = 1000;
    const registry = new ContinuationRegistry({ ttlMs: 10, now: () => now });
    const failed = registry.reserveNew(grant);
    expect(registry.reserveResponseId(failed, "resp_reused")).toBe(true);
    registry.fail(failed);
    const replacement = registry.reserveNew(grant);
    expect(registry.reserveResponseId(replacement, "resp_reused")).toBe(true);
    registry.complete(replacement, "resp_reused", []);
    now += 11;
    expect(registry.peek("resp_reused", grant)).toBeUndefined();

    const live = registry.reserveNew(grant);
    expect(registry.reserveResponseId(live, "resp_restart")).toBe(true);
    registry.complete(live, "resp_restart", []);
    expect(
      new ContinuationRegistry().peek("resp_restart", grant),
    ).toBeUndefined();
  });
});
