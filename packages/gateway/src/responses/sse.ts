import type { ResponseStreamEvent } from "./protocol.js";

export const SSE_DONE = "data: [DONE]\n\n";

/**
 * Every frame carries an `event:` value equal to the JSON `type`. The pinned
 * document does not require that, so `VAL-RESP-002` asserts it locally.
 */
export function encodeSseEvent(event: ResponseStreamEvent): string {
  return `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`;
}
