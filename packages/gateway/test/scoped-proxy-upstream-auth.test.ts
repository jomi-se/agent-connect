import { describe, expect, it } from "vitest";

import {
  openClawHttpAuthHeaders,
  resolveOpenClawUpstreamAuth,
} from "../src/scoped-proxy/upstream-auth.js";

describe("OpenClaw upstream authentication", () => {
  it("preserves standalone token compatibility", () => {
    expect(
      resolveOpenClawUpstreamAuth({ upstreamToken: "operator-token" }),
    ).toEqual({ mode: "token", credential: "operator-token" });
  });

  it("uses the resolved password as the pinned HTTP bearer credential", () => {
    expect(
      openClawHttpAuthHeaders({
        mode: "password",
        credential: "operator-password",
      }),
    ).toEqual({ authorization: "Bearer operator-password" });
  });

  it("omits HTTP authorization only for explicit no-auth mode", () => {
    expect(openClawHttpAuthHeaders({ mode: "none" })).toEqual({});
    expect(() => resolveOpenClawUpstreamAuth({})).toThrow(
      "upstream authentication must be explicit",
    );
  });
});
