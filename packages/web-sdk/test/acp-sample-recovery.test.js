import { describe, expect, it } from "vitest";
import {
  getConversationRecoveryAction,
  getConversationRecoveryState,
} from "../../../examples/acp-chat/recovery-policy.js";

describe("ACP sample recovery choices", () => {
  it("disables send and exposes a deliberate new connection when an idle session is ended by its owner", () => {
    expect(
      getConversationRecoveryState({
        sessionId: "known-session",
        closeCode: 4415,
        errorCode: "session_superseded",
        status: "idle",
        canSend: true,
        needsNewSession: false,
      }),
    ).toEqual({
      action: "new-connection",
      canSend: false,
      needsNewSession: true,
    });
  });
  it("blocks idle sending after revocation and requests approval instead of a new session", () => {
    expect(
      getConversationRecoveryState({
        sessionId: "known-session",
        closeCode: 4414,
        errorCode: "invalid_app_grant",
        status: "idle",
        canSend: true,
        needsNewSession: false,
      }),
    ).toEqual({ action: "approval", canSend: false, needsNewSession: false });
  });
  it("waits for an active interrupted presenter to settle before offering a new connection", () => {
    expect(
      getConversationRecoveryState({
        sessionId: "known-session",
        closeCode: 4415,
        errorCode: "session_superseded",
        status: "running",
        canSend: false,
        needsNewSession: false,
      }),
    ).toEqual({
      action: "new-connection",
      canSend: false,
      needsNewSession: false,
    });
  });
  it("preserves send availability on a healthy idle connection before its first prompt", () => {
    expect(
      getConversationRecoveryState({
        status: "idle",
        canSend: true,
        needsNewSession: false,
      }),
    ).toEqual({
      action: "new-connection",
      canSend: true,
      needsNewSession: false,
    });
  });
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
