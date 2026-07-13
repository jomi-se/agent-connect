import { createWebSocketStream } from "@agentclientprotocol/sdk/experimental/ws-client";
import type { Stream } from "@agentclientprotocol/sdk";

import type { BrowserAcpStreamOptions } from "./types.js";

/**
 * Create an ACP stream using the browser's native WebSocket implementation.
 *
 * Browsers cannot set arbitrary WebSocket headers. Authentication should use
 * secure cookies, a negotiated subprotocol, or another conductor-supported
 * browser mechanism.
 */
export function createBrowserAcpStream(
  url: string,
  options: BrowserAcpStreamOptions = {},
): Stream {
  const protocols = options.protocols
    ? Array.from(options.protocols)
    : undefined;

  return createWebSocketStream(url, {
    ...(protocols ? { protocols } : {}),
    ...(options.cookies ? { cookies: options.cookies } : {}),
  });
}
