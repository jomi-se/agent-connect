import { createHash, randomBytes } from "node:crypto";

import type { GatewayToolDefinition } from "../tool-snapshot.js";
import type { BackendEvent, BackendRun, ResponseBackend } from "./backend.js";
import { ResponseApiError, type ResponseErrorCode } from "./errors.js";
import {
  buildResponseResource,
  projectTools,
  SequenceCounter,
  type ResponseFunctionTool,
  type ResponseOutputItem,
  type ResponseResource,
  type ResponseStatus,
  type ResponseStreamEvent,
} from "./protocol.js";
import type {
  CallRecord,
  ChainRecord,
  ResponseRecord,
  ResponseStore,
} from "./store.js";
import type { ParsedResponseRequest } from "./profile.js";

/** The authorized application session a response request is executed under. */
export interface EngineSession {
  readonly sessionId: string;
  readonly appId: string;
  readonly origin: string;
  readonly toolHash: string;
  readonly tools: readonly GatewayToolDefinition[];
  readonly authorizationGrantId: string;
  readonly providerSessionId: string;
}

export interface ResponseEngineOptions {
  readonly store: ResponseStore;
  readonly backend: ResponseBackend;
  /** Checked at every authorization boundary: create, continue, recover, cancel. */
  readonly isGrantActive: (grantId: string) => boolean;
  readonly now?: () => number;
  readonly createId?: () => string;
}

/** One of the four declared outcomes of a recovery attempt. */
export type RecoveryOutcome =
  | "reattached_live"
  | "reconciled_from_snapshot"
  | "terminal_reconstructed"
  | "interrupted";

export interface ChainView {
  readonly responseId: string;
  readonly chainStatus: ChainRecord["status"];
  readonly recovery: RecoveryOutcome;
  readonly response: ResponseResource;
}

export interface PendingCallView {
  readonly callId: string;
  readonly name: string;
  readonly arguments: string;
  readonly responseId: string;
}

interface ActiveChain {
  readonly run: BackendRun;
  readonly events: AsyncIterator<BackendEvent>;
  busy: boolean;
}

export class ResponseEngine {
  private readonly store: ResponseStore;
  private readonly backend: ResponseBackend;
  private readonly isGrantActive: (grantId: string) => boolean;
  private readonly now: () => number;
  private readonly createId: () => string;
  private readonly active = new Map<string, ActiveChain>();

  constructor(options: ResponseEngineOptions) {
    this.store = options.store;
    this.backend = options.backend;
    this.isGrantActive = options.isGrantActive;
    this.now = options.now ?? Date.now;
    this.createId = options.createId ?? (() => randomBytes(16).toString("hex"));
  }

  /**
   * Validates and starts one response segment. Rejects before any event is
   * produced, so a caller can map the failure onto an HTTP status; once the
   * returned generator has yielded, failures become `error` plus
   * `response.failed` frames instead.
   */
  async createResponse(
    session: EngineSession,
    request: ParsedResponseRequest,
  ): Promise<AsyncGenerator<ResponseStreamEvent>> {
    this.requireGrant(session.authorizationGrantId);
    if (request.kind === "initial") {
      return this.startInitial(session, request.prompt);
    }
    return this.startContinuation(
      session,
      request.previousResponseId,
      request.callId,
      request.output,
    );
  }

  private async startInitial(
    session: EngineSession,
    prompt: string,
  ): Promise<AsyncGenerator<ResponseStreamEvent>> {
    const timestamp = this.seconds();
    const chain: ChainRecord = {
      chainId: `chain_${this.createId()}`,
      appSessionId: session.sessionId,
      appId: session.appId,
      origin: session.origin,
      authorizationGrantId: session.authorizationGrantId,
      toolHash: session.toolHash,
      tools: session.tools,
      providerKind: this.backend.kind,
      providerSessionId: session.providerSessionId,
      status: "running",
      createdAt: timestamp,
      updatedAt: timestamp,
      latestResponseId: null,
      terminalError: null,
    };
    await this.store.putChain(chain);

    let run: BackendRun;
    try {
      run = await this.backend.start({
        providerSessionId: session.providerSessionId,
        prompt,
        tools: session.tools,
      });
    } catch (cause) {
      await this.store.putChain({
        ...chain,
        status: "terminal",
        updatedAt: this.seconds(),
        terminalError: {
          code: "backend_unavailable",
          message: "the selected user-owned runtime could not be reached",
        },
      });
      throw new ResponseApiError(
        "backend_unavailable",
        `the selected user-owned runtime could not be reached: ${describe(cause)}`,
      );
    }
    const state: ActiveChain = {
      run,
      events: run.events(),
      busy: true,
    };
    this.active.set(chain.chainId, state);
    return this.segment(chain.chainId, state, null);
  }

  private async startContinuation(
    session: EngineSession,
    previousResponseId: string,
    callId: string,
    output: string,
  ): Promise<AsyncGenerator<ResponseStreamEvent>> {
    const previous = await this.store.getResponse(previousResponseId);
    if (!previous) {
      throw new ResponseApiError(
        "previous_response_not_found",
        "previous_response_id is unknown or no longer continuable",
        "previous_response_id",
      );
    }
    const chain = await this.store.getChain(previous.chainId);
    if (!chain || !this.chainBelongsTo(chain, session)) {
      throw new ResponseApiError(
        "previous_response_not_found",
        "previous_response_id is unknown or no longer continuable",
        "previous_response_id",
      );
    }
    if (chain.status === "terminal") {
      // A terminal chain reports why it is terminal: `response_cancelled` and
      // `backend_unavailable` (an interrupted chain) are materially different
      // answers for a client deciding whether to retry.
      throw new ResponseApiError(
        terminalErrorCode(chain),
        chain.terminalError?.message ??
          "the response chain has already reached a terminal state",
        "previous_response_id",
      );
    }
    if (chain.latestResponseId !== previousResponseId) {
      throw new ResponseApiError(
        "previous_response_not_found",
        "only the most recent response in a chain can be continued",
        "previous_response_id",
      );
    }

    const state = this.active.get(chain.chainId);
    if (!state) {
      // The live run did not survive. Persist-before-publication tells us the
      // call existed; nothing restores the parked awaiter inside the harness.
      await this.markInterrupted(chain);
      throw new ResponseApiError(
        "backend_unavailable",
        "the harness run backing this chain is no longer available; the chain is interrupted",
      );
    }
    if (state.busy) {
      throw new ResponseApiError(
        "response_busy",
        "another operation is already active on this response chain",
      );
    }

    const call = await this.store.getCall(callId);
    if (
      !call ||
      call.chainId !== chain.chainId ||
      call.result === "provider_observed"
    ) {
      throw new ResponseApiError(
        "function_call_not_found",
        "call_id does not match the unresolved function call on this chain",
        "input",
      );
    }
    const fingerprint = fingerprintOf(output);
    if (
      call.result !== "none" &&
      call.outputFingerprint !== null &&
      call.outputFingerprint !== fingerprint
    ) {
      throw new ResponseApiError(
        "function_output_conflict",
        "a different output has already been recorded for this call",
        "input",
      );
    }

    state.busy = true;
    try {
      // Persist the canonical output before the provider is contacted, so a
      // crash between the two is recoverable as a same-output redrive.
      const recorded: CallRecord = {
        ...call,
        result: "output_recorded",
        output,
        outputFingerprint: fingerprint,
        updatedAt: this.seconds(),
      };
      await this.store.putCall(recorded);
      await state.run.submitOutput(call.providerToken, output);
      await this.store.putCall({
        ...recorded,
        result: "delivery_attempted",
        updatedAt: this.seconds(),
      });
    } catch (cause) {
      state.busy = false;
      throw new ResponseApiError(
        "backend_unavailable",
        `the function output could not be delivered: ${describe(cause)}`,
      );
    }
    await this.store.putChain({
      ...chain,
      status: "running",
      updatedAt: this.seconds(),
    });
    return this.segment(chain.chainId, state, {
      previousResponseId,
      callId,
    });
  }

  /**
   * Emits one public response segment. A segment ends at the first application
   * function call or at the run's own terminal event; the underlying run is
   * deliberately retained in the former case.
   */
  private async *segment(
    chainId: string,
    state: ActiveChain,
    continuation: { previousResponseId: string; callId: string } | null,
  ): AsyncGenerator<ResponseStreamEvent> {
    const sequence = new SequenceCounter();
    const responseId = `resp_${this.createId()}`;
    const createdAt = this.seconds();
    const chain = await this.requireChain(chainId);
    const tools = projectTools(chain.tools);
    const output: ResponseOutputItem[] = [];
    let outputIndex = 0;
    let text: { readonly id: string; value: string } | undefined;
    let resolvedCall = continuation === null;

    const resource = (
      status: ResponseStatus,
      error: ResponseResource["error"] = null,
    ): ResponseResource =>
      buildResponseResource({
        id: responseId,
        createdAt,
        completedAt: status === "in_progress" ? null : this.seconds(),
        status,
        previousResponseId: continuation?.previousResponseId ?? null,
        output: [...output],
        error,
        tools,
      });

    const persist = async (
      status: ResponseStatus,
      error: ResponseRecord["error"] = null,
    ): Promise<void> => {
      const record: ResponseRecord = {
        responseId,
        chainId,
        previousResponseId: continuation?.previousResponseId ?? null,
        status,
        createdAt,
        completedAt: status === "in_progress" ? null : this.seconds(),
        output: [...output],
        error,
      };
      await this.store.putResponse(record);
    };

    const closeText = function* (): Generator<ResponseStreamEvent> {
      if (!text) return;
      const part = {
        type: "output_text" as const,
        text: text.value,
        annotations: [] as readonly never[],
      };
      const item: ResponseOutputItem = {
        type: "message",
        id: text.id,
        status: "completed",
        role: "assistant",
        content: [part],
      };
      yield {
        type: "response.output_text.done",
        sequence_number: sequence.take(),
        item_id: text.id,
        output_index: outputIndex,
        content_index: 0,
        text: text.value,
      };
      yield {
        type: "response.content_part.done",
        sequence_number: sequence.take(),
        item_id: text.id,
        output_index: outputIndex,
        content_index: 0,
        part,
      };
      output.push(item);
      yield {
        type: "response.output_item.done",
        sequence_number: sequence.take(),
        output_index: outputIndex,
        item,
      };
      outputIndex += 1;
      text = undefined;
    };

    await persist("in_progress");
    await this.store.putChain({
      ...chain,
      status: "running",
      latestResponseId: responseId,
      updatedAt: this.seconds(),
    });
    yield {
      type: "response.created",
      sequence_number: sequence.take(),
      response: resource("in_progress"),
    };
    yield {
      type: "response.in_progress",
      sequence_number: sequence.take(),
      response: resource("in_progress"),
    };

    try {
      for (;;) {
        const next = await state.events.next();
        if (!resolvedCall && continuation) {
          // The provider produced something after the output was posted, which
          // is the only evidence available that the result took effect. A 202
          // acknowledgement alone is not.
          resolvedCall = true;
          const call = await this.store.getCall(continuation.callId);
          if (call) {
            await this.store.putCall({
              ...call,
              result: "provider_observed",
              updatedAt: this.seconds(),
            });
          }
        }
        if (next.done) {
          yield* closeText();
          await this.finishChain(chainId, "terminal", null);
          await persist("completed");
          yield {
            type: "response.completed",
            sequence_number: sequence.take(),
            response: resource("completed"),
          };
          return;
        }
        const event = next.value;
        if (event.type === "text.delta") {
          if (!text) {
            text = { id: `msg_${this.createId()}`, value: "" };
            yield {
              type: "response.output_item.added",
              sequence_number: sequence.take(),
              output_index: outputIndex,
              item: {
                type: "message",
                id: text.id,
                status: "in_progress",
                role: "assistant",
                content: [],
              },
            };
            yield {
              type: "response.content_part.added",
              sequence_number: sequence.take(),
              item_id: text.id,
              output_index: outputIndex,
              content_index: 0,
              part: { type: "output_text", text: "", annotations: [] },
            };
          }
          text.value += event.delta;
          yield {
            type: "response.output_text.delta",
            sequence_number: sequence.take(),
            item_id: text.id,
            output_index: outputIndex,
            content_index: 0,
            delta: event.delta,
          };
          continue;
        }
        if (event.type === "tool.call") {
          yield* closeText();
          const item = await this.recordCall(chainId, responseId, event, tools);
          yield {
            type: "response.output_item.added",
            sequence_number: sequence.take(),
            output_index: outputIndex,
            item: { ...item, status: "in_progress" },
          };
          yield {
            type: "response.function_call_arguments.done",
            sequence_number: sequence.take(),
            item_id: item.id,
            output_index: outputIndex,
            arguments: item.arguments,
          };
          output.push(item);
          yield {
            type: "response.output_item.done",
            sequence_number: sequence.take(),
            output_index: outputIndex,
            item,
          };
          outputIndex += 1;
          await this.publishCall(item.call_id);
          await this.finishChain(chainId, "waiting_for_output", null);
          await persist("completed");
          yield {
            type: "response.completed",
            sequence_number: sequence.take(),
            response: resource("completed"),
          };
          return;
        }
        if (event.type === "completed") {
          yield* closeText();
          await this.finishChain(chainId, "terminal", null);
          await persist("completed");
          yield {
            type: "response.completed",
            sequence_number: sequence.take(),
            response: resource("completed"),
          };
          return;
        }
        if (event.type === "cancelled") {
          yield* closeText();
          const error = {
            code: "response_cancelled",
            message: "the response chain was cancelled",
          };
          await this.finishChain(chainId, "terminal", error);
          await persist("cancelled", error);
          // The pinned document has no `response.cancelled` event; a cancelled
          // segment terminates as `response.incomplete` carrying the cancelled
          // resource status.
          yield {
            type: "response.incomplete",
            sequence_number: sequence.take(),
            response: resource("cancelled", error),
          };
          return;
        }
        yield* closeText();
        const error = {
          code: "backend_protocol_error",
          message: event.message,
        };
        await this.finishChain(chainId, "terminal", error);
        await persist("failed", error);
        yield {
          type: "error",
          sequence_number: sequence.take(),
          error: {
            type: "api_error",
            code: "backend_protocol_error",
            message: event.message,
            param: null,
          },
        };
        yield {
          type: "response.failed",
          sequence_number: sequence.take(),
          response: resource("failed", error),
        };
        return;
      }
    } catch (cause) {
      const error = {
        code: "backend_unavailable",
        message: `the user-owned runtime stream failed: ${describe(cause)}`,
      };
      await this.finishChain(chainId, "terminal", error);
      await persist("failed", error);
      yield {
        type: "error",
        sequence_number: sequence.take(),
        error: {
          type: "api_error",
          code: "backend_unavailable",
          message: error.message,
          param: null,
        },
      };
      yield {
        type: "response.failed",
        sequence_number: sequence.take(),
        response: resource("failed", error),
      };
    } finally {
      state.busy = false;
    }
  }

  /** Agent Connect extension: chain status plus the latest complete response. */
  async describeChain(
    session: EngineSession,
    responseId: string,
  ): Promise<ChainView> {
    this.requireGrant(session.authorizationGrantId);
    const { chain, response } = await this.requireOwnedResponse(
      session,
      responseId,
    );
    const live = this.active.get(chain.chainId);
    const recovery: RecoveryOutcome =
      chain.status === "terminal"
        ? "terminal_reconstructed"
        : live
          ? "reattached_live"
          : "interrupted";
    if (recovery === "interrupted") await this.markInterrupted(chain);
    return {
      responseId: response.responseId,
      chainStatus: recovery === "interrupted" ? "terminal" : chain.status,
      recovery,
      response: buildResponseResource({
        id: response.responseId,
        createdAt: response.createdAt,
        completedAt: response.completedAt,
        status: response.status,
        previousResponseId: response.previousResponseId,
        output: response.output,
        error: response.error,
        tools: projectTools(chain.tools),
      }),
    };
  }

  /** Agent Connect extension: unresolved application calls, for redelivery. */
  async pendingFunctionCalls(
    session: EngineSession,
    responseId: string,
  ): Promise<readonly PendingCallView[]> {
    this.requireGrant(session.authorizationGrantId);
    const { chain } = await this.requireOwnedResponse(session, responseId);
    const calls = await this.store.unresolvedCalls(chain.chainId);
    return calls
      .filter((call) => call.publication === "published")
      .map((call) => ({
        callId: call.callId,
        name: call.name,
        arguments: call.arguments,
        responseId: call.responseId,
      }));
  }

  /** Agent Connect extension: cancel the logical chain. */
  async cancelChain(
    session: EngineSession,
    responseId: string,
  ): Promise<ChainView> {
    this.requireGrant(session.authorizationGrantId);
    const { chain } = await this.requireOwnedResponse(session, responseId);
    const live = this.active.get(chain.chainId);
    if (chain.status !== "terminal") {
      await this.store.putChain({
        ...chain,
        status: "cancelling",
        updatedAt: this.seconds(),
      });
      if (live) {
        await live.run.cancel();
        if (!live.busy) {
          // Nothing is consuming the run, so no segment will observe the
          // cancellation; commit the terminal state here.
          await live.run.close();
          this.active.delete(chain.chainId);
          await this.finishChain(chain.chainId, "terminal", {
            code: "response_cancelled",
            message: "the response chain was cancelled",
          });
        }
      } else {
        await this.finishChain(chain.chainId, "terminal", {
          code: "response_cancelled",
          message: "the response chain was cancelled",
        });
      }
    }
    return this.describeChain(session, responseId);
  }

  /** Releases live runs; used on shutdown and by tests. */
  async closeAll(): Promise<void> {
    const runs = [...this.active.values()];
    this.active.clear();
    await Promise.all(runs.map((state) => state.run.close().catch(() => {})));
  }

  private async recordCall(
    chainId: string,
    responseId: string,
    event: Extract<BackendEvent, { type: "tool.call" }>,
    tools: readonly ResponseFunctionTool[],
  ): Promise<Extract<ResponseOutputItem, { type: "function_call" }>> {
    if (!tools.some((tool) => tool.name === event.name)) {
      throw new ResponseApiError(
        "backend_protocol_error",
        `the runtime requested a function outside the approved snapshot: ${event.name}`,
      );
    }
    const callId = `call_${this.createId()}`;
    const timestamp = this.seconds();
    // Durable before publication. This record is the only source of truth for
    // an unresolved call: the harness snapshot does not report parked calls.
    await this.store.putCall({
      callId,
      chainId,
      responseId,
      providerToken: event.providerToken,
      name: event.name,
      arguments: event.arguments,
      publication: "recorded",
      result: "none",
      output: null,
      outputFingerprint: null,
      createdAt: timestamp,
      updatedAt: timestamp,
    });
    const recorded = await this.store.getCall(callId);
    if (recorded) {
      await this.store.putCall({
        ...recorded,
        publication: "publication_started",
        updatedAt: this.seconds(),
      });
    }
    return {
      type: "function_call",
      id: `fc_${this.createId()}`,
      call_id: callId,
      name: event.name,
      arguments: event.arguments,
      status: "completed",
    };
  }

  private async publishCall(callId: string): Promise<void> {
    const call = await this.store.getCall(callId);
    if (!call) return;
    await this.store.putCall({
      ...call,
      publication: "published",
      updatedAt: this.seconds(),
    });
  }

  private async finishChain(
    chainId: string,
    status: ChainRecord["status"],
    terminalError: ChainRecord["terminalError"],
  ): Promise<void> {
    const chain = await this.store.getChain(chainId);
    if (!chain) return;
    if (chain.status === "terminal") return;
    await this.store.putChain({
      ...chain,
      status,
      terminalError,
      updatedAt: this.seconds(),
    });
    if (status === "terminal") {
      const state = this.active.get(chainId);
      this.active.delete(chainId);
      await state?.run.close().catch(() => {});
    }
  }

  private async markInterrupted(chain: ChainRecord): Promise<void> {
    if (chain.status === "terminal") return;
    await this.store.putChain({
      ...chain,
      status: "terminal",
      terminalError: {
        code: "backend_unavailable",
        message:
          "the harness run backing this chain was lost; the chain is interrupted",
      },
      updatedAt: this.seconds(),
    });
  }

  private async requireOwnedResponse(
    session: EngineSession,
    responseId: string,
  ): Promise<{ chain: ChainRecord; response: ResponseRecord }> {
    const response = await this.store.getResponse(responseId);
    const chain = response
      ? await this.store.getChain(response.chainId)
      : undefined;
    if (!response || !chain || !this.chainBelongsTo(chain, session)) {
      throw new ResponseApiError(
        "previous_response_not_found",
        "the response is unknown or not authorized for this application session",
      );
    }
    return { chain, response };
  }

  private chainBelongsTo(chain: ChainRecord, session: EngineSession): boolean {
    return (
      chain.appSessionId === session.sessionId &&
      chain.appId === session.appId &&
      chain.origin === session.origin &&
      chain.toolHash === session.toolHash &&
      chain.authorizationGrantId === session.authorizationGrantId
    );
  }

  private async requireChain(chainId: string): Promise<ChainRecord> {
    const chain = await this.store.getChain(chainId);
    if (!chain) {
      throw new ResponseApiError(
        "previous_response_not_found",
        "the response chain record is missing",
      );
    }
    return chain;
  }

  private requireGrant(grantId: string): void {
    if (!this.isGrantActive(grantId)) {
      throw new ResponseApiError(
        "tool_snapshot_mismatch",
        "the authorization grant for this application session is no longer active",
      );
    }
  }

  private seconds(): number {
    return Math.floor(this.now() / 1000);
  }
}

const CONTINUABLE_TERMINAL_CODES: ReadonlySet<string> = new Set([
  "response_cancelled",
  "backend_unavailable",
  "backend_protocol_error",
]);

function terminalErrorCode(chain: ChainRecord): ResponseErrorCode {
  const code = chain.terminalError?.code;
  return code && CONTINUABLE_TERMINAL_CODES.has(code)
    ? (code as ResponseErrorCode)
    : "previous_response_not_found";
}

function fingerprintOf(output: string): string {
  return createHash("sha256").update(output).digest("base64url");
}

function describe(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}
