// Presentation policy only. The provider remains responsible for deciding
// whether it can load history, and never repeats an uncertain prompt or effect.
export function getConversationRecoveryAction({
  sessionId,
  closeCode,
  errorCode,
}) {
  if (
    [4401, 4403, 4414].includes(closeCode) ||
    ["invalid_app_grant", "authorization_denied"].includes(errorCode)
  )
    return "approval";
  if (
    !sessionId ||
    (closeCode !== undefined && ![4404, 4410, 4413].includes(closeCode))
  )
    return "new-connection";
  if (
    [
      "session_superseded",
      "continuation_unavailable",
      "protocol_error",
      "frame_too_large",
      "webmcp_snapshot_invalidated",
    ].includes(errorCode)
  )
    return "new-connection";
  return "recover";
}
