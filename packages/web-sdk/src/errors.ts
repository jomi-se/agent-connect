import type { AgentConnectErrorCode } from "./types.js";

export class AgentConnectError extends Error {
  readonly code: AgentConnectErrorCode;
  readonly status: number | undefined;
  /**
   * Where the person can resolve this themselves, when the gateway offers such
   * a page. Set for `session_capacity`, whose only real remedy is for the owner
   * to end a session; an application should offer this as a link rather than
   * asking the user to retry into a full gateway.
   */
  readonly manageUrl: string | undefined;

  constructor(
    code: AgentConnectErrorCode,
    message: string,
    options: {
      readonly status?: number;
      readonly cause?: unknown;
      readonly manageUrl?: string;
    } = {},
  ) {
    super(message, options.cause === undefined ? {} : { cause: options.cause });
    this.name = "AgentConnectError";
    this.code = code;
    this.status = options.status;
    this.manageUrl = options.manageUrl;
  }
}
