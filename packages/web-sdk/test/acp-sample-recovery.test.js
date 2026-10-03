import { describe, expect, it } from "vitest";
import { getConversationRecoveryAction } from "../../../examples/acp-chat/recovery-policy.js";

describe("ACP sample recovery choices", () => {
  it.each([4404, 4410, 4413])(
    "offers recovery for resumable interruption %s",
    (closeCode) => {
      expect(
        getConversationRecoveryAction({
          sessionId: "known-session",
          closeCode,
          errorCode: "task_interrupted",
        }),
      ).toBe("recover");
    },
  );
  it.each([1009, 4400, 4409, 4415, 4418, 4500])(
    "offers a new connection rather than an unusable recovery retry for terminal transport %s",
    (closeCode) => {
      expect(
        getConversationRecoveryAction({
          sessionId: "known-session",
          closeCode,
        }),
      ).toBe("new-connection");
    },
  );
  it.each([
    [4401, "invalid_app_grant"],
    [4414, "invalid_app_grant"],
    [4403, "authorization_denied"],
  ])(
    "requests browser approval for authorization close %s",
    (closeCode, errorCode) => {
      expect(
        getConversationRecoveryAction({
          sessionId: "known-session",
          closeCode,
          errorCode,
        }),
      ).toBe("approval");
      expect(
        getConversationRecoveryAction({
          sessionId: "known-session",
          closeCode,
        }),
      ).toBe("approval");
    },
  );
  it.each([
    "session_superseded",
    "continuation_unavailable",
    "protocol_error",
    "frame_too_large",
    "webmcp_snapshot_invalidated",
  ])("offers a new connection for terminal typed error %s", (errorCode) => {
    expect(
      getConversationRecoveryAction({ sessionId: "known-session", errorCode }),
    ).toBe("new-connection");
  });
  it("reattaches a healthy stopped conversation and allows retry after a refused history load", () => {
    expect(getConversationRecoveryAction({ sessionId: "known-session" })).toBe(
      "recover",
    );
    expect(
      getConversationRecoveryAction({
        sessionId: "known-session",
        errorCode: -32603,
      }),
    ).toBe("recover");
  });
  it("starts a new connection when no conversation has been established", () => {
    expect(getConversationRecoveryAction({})).toBe("new-connection");
  });
});
