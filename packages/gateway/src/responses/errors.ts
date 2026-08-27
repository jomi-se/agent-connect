import type { ResponseErrorPayload } from "./protocol.js";

/**
 * The pinned version 0 error codes. Provider messages are never forwarded as
 * API behavior; see "Public response and stream" in
 * docs/plan/open-responses-vertical-slice.md.
 */
export type ResponseErrorCode =
  | "invalid_request"
  | "unsupported_feature"
  | "model_not_found"
  | "previous_response_not_found"
  | "tool_snapshot_mismatch"
  | "function_call_not_found"
  | "function_output_conflict"
  | "response_busy"
  | "response_cancelled"
  | "backend_unavailable"
  | "backend_protocol_error";

const STATUS: Readonly<Record<ResponseErrorCode, number>> = {
  invalid_request: 400,
  unsupported_feature: 400,
  model_not_found: 400,
  previous_response_not_found: 404,
  tool_snapshot_mismatch: 403,
  function_call_not_found: 409,
  function_output_conflict: 409,
  response_busy: 409,
  response_cancelled: 409,
  backend_unavailable: 502,
  backend_protocol_error: 502,
};

const TYPE: Readonly<Record<ResponseErrorCode, string>> = {
  invalid_request: "invalid_request_error",
  unsupported_feature: "invalid_request_error",
  model_not_found: "invalid_request_error",
  previous_response_not_found: "invalid_request_error",
  tool_snapshot_mismatch: "authorization_error",
  function_call_not_found: "invalid_request_error",
  function_output_conflict: "invalid_request_error",
  response_busy: "invalid_request_error",
  response_cancelled: "invalid_request_error",
  backend_unavailable: "api_error",
  backend_protocol_error: "api_error",
};

export class ResponseApiError extends Error {
  readonly code: ResponseErrorCode;
  readonly param: string | null;

  constructor(
    code: ResponseErrorCode,
    message: string,
    param: string | null = null,
  ) {
    super(message);
    this.name = "ResponseApiError";
    this.code = code;
    this.param = param;
  }

  get status(): number {
    return STATUS[this.code];
  }

  get type(): string {
    return TYPE[this.code];
  }

  /** The `error` member of a non-streaming failure body. */
  toBody(): { readonly error: ResponseErrorPayload } {
    return { error: this.toPayload() };
  }

  /** The payload of a streaming `error` event. */
  toPayload(): ResponseErrorPayload {
    return {
      type: this.type,
      code: this.code,
      message: this.message,
      param: this.param,
    };
  }
}
