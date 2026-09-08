import type { ContinuationRecord } from "./continuations.js";

export function describeConversation(record: ContinuationRecord) {
  const canContinue = record.pendingCallIds.length === 0;
  return {
    conversationId: record.conversationId,
    expiresAt: record.expiresAt,
    canContinue,
    ...(canContinue ? { previousResponseId: record.responseId } : {}),
  };
}

/** Explicit allowlist: no provider metadata, reasoning, tool calls/results or
 * instructions. Native user text can be a learner prompt OR application output;
 * input deliberately does not assert human authorship or execution status. */
export function projectExecutionHistory(value: unknown) {
  const history = object(value);
  if (!history || !Array.isArray(history.messages)) {
    throw new Error("Invalid upstream history");
  }
  const entries: Array<{ kind: "input" | "assistant"; text: string }> = [];
  let remaining = 128 * 1024;
  let truncated = history.hasMore === true || history.messages.length > 200;
  for (const raw of history.messages.slice(-200)) {
    const message = object(raw);
    if (!message || !["user", "assistant"].includes(String(message.role)))
      continue;
    const content =
      typeof message.content === "string"
        ? message.content
        : Array.isArray(message.content)
          ? message.content
              .flatMap((rawBlock: unknown) => {
                const block = object(rawBlock);
                return block?.type === "text" && typeof block.text === "string"
                  ? [block.text]
                  : [];
              })
              .join("\n")
          : "";
    if (!content) continue;
    const length = Math.min(content.length, 16 * 1024, remaining);
    if (length < content.length) truncated = true;
    if (length)
      entries.push({
        kind: message.role === "user" ? "input" : "assistant",
        text: content.slice(0, length),
      });
    remaining -= length;
  }
  return { projection: "execution-history" as const, entries, truncated };
}

function object(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}
