import { createHash, randomBytes } from "node:crypto";

import type { GatewayToolDefinition } from "../tool-snapshot.js";
import type { BackendEvent, BackendRun, ResponseBackend } from "./backend.js";
import { ResponseApiError, type ResponseErrorCode } from "./errors.js";
import {
  buildResponseResource,
  projectTools,
  type ResponseError,
  type ResponseOutputItem,
  type ResponseResource,
  type ResponseStatus,
  type ResponseStreamEvent,
} from "./protocol.js";
import { SegmentWriter } from "./segment-writer.js";
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

/** One of the three declared outcomes of a recovery attempt. */
export type RecoveryOutcome =
  "reattached_live" | "terminal_reconstructed" | "interrupted";

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
  cancelRequested: boolean;
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
    await this.requireNoLiveChain(session.sessionId);
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
      cancelRequested: false,
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
    const { chain, state } = await this.resumableChain(
      session,
      previousResponseId,
    );
    try {
      const call = await this.resolvableCall(chain, callId, output);
      if (state.cancelRequested) {
        throw new ResponseApiError(
          "response_cancelled",
          "the response chain was cancelled before its output was delivered",
        );
      }
      await this.deliverOutput(state, call, output, fingerprintOf(output));
      if (state.cancelRequested) {
        throw new ResponseApiError(
          "response_cancelled",
          "the response chain was cancelled while its output was being delivered",
        );
      }
      await this.store.putChain({
        ...chain,
        status: "running",
        updatedAt: this.seconds(),
      });
    } catch (cause) {
      state.busy = false;
      throw cause;
    }
    return this.segment(chain.chainId, state, {
      previousResponseId,
      callId,
    });
  }

  /**
   * Resolves the chain a continuation targets and proves it is still
   * continuable: owned by this session, not terminal, at its head, live, and
   * not already executing another operation.
   */
  private async resumableChain(
    session: EngineSession,
    previousResponseId: string,
  ): Promise<{ chain: ChainRecord; state: ActiveChain }> {
    const previous = await this.store.getResponse(previousResponseId);
    const chain = previous
      ? await this.store.getChain(previous.chainId)
      : undefined;
    if (!previous || !chain || !this.chainBelongsTo(chain, session)) {
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
    const state = this.liveRun(chain.chainId);
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
    // Claimed here, in the same synchronous step as the check. Every caller
    // awaits before it reaches the run, and a claim taken after those awaits
    // would let two continuations pass the guard together and deliver two
    // outputs for one parked call. The caller releases it if it then throws.
    state.busy = true;
    return { chain, state };
  }

  /**
   * The unresolved call a continuation names, proven to belong to this chain
   * and to be answerable with this output.
   */
  private async resolvableCall(
    chain: ChainRecord,
    callId: string,
    output: string,
  ): Promise<CallRecord> {
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
    if (
      call.result !== "none" &&
      call.outputFingerprint !== null &&
      call.outputFingerprint !== fingerprintOf(output)
    ) {
      throw new ResponseApiError(
        "function_output_conflict",
        "a different output has already been recorded for this call",
        "input",
      );
    }
    return call;
  }

  /**
   * Persists the canonical output before the provider is contacted, so a crash
   * between the two is recoverable as a same-output redrive.
   */
  private async deliverOutput(
    state: ActiveChain,
    call: CallRecord,
    output: string,
    fingerprint: string,
  ): Promise<void> {
    // A successful provider post was already durably recorded. Re-entering a
    // continuation must observe the retained run, not post the same output a
    // second time. `output_recorded` remains an intentionally uncertain
    // at-least-once boundary if the process died around the provider request.
    if (call.result === "delivery_attempted") return;
    const recorded: CallRecord = {
      ...call,
      result: "output_recorded",
      output,
      outputFingerprint: fingerprint,
      updatedAt: this.seconds(),
    };
    await this.store.putCall(recorded);
    if (state.cancelRequested) {
      throw new ResponseApiError(
        "response_cancelled",
        "the response chain was cancelled before its output was delivered",
      );
    }
    try {
      await state.run.submitOutput(call.providerToken, output);
    } catch (cause) {
      throw new ResponseApiError(
        "backend_unavailable",
        `the function output could not be delivered: ${describe(cause)}`,
      );
    }
    await this.store.putCall({
      ...recorded,
      result: "delivery_attempted",
      updatedAt: this.seconds(),
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
    const responseId = `resp_${this.createId()}`;
    const createdAt = this.seconds();
    const chain = await this.requireChain(chainId);
    const writer = new SegmentWriter({
      responseId,
      createdAt,
      previousResponseId: continuation?.previousResponseId ?? null,
      tools: projectTools(chain.tools),
      now: this.now,
      createId: this.createId,
    });
    let resolvedCall = continuation === null;

    const persist = (
      status: ResponseStatus,
      error: ResponseError | null = null,
    ): Promise<void> =>
      this.store.putResponse({
        responseId,
        chainId,
        previousResponseId: continuation?.previousResponseId ?? null,
        status,
        createdAt,
        completedAt: status === "in_progress" ? null : this.seconds(),
        output: [...writer.output],
        error,
      });

    await persist("in_progress");
    await this.store.putChain({
      ...chain,
      status: "running",
      latestResponseId: responseId,
      updatedAt: this.seconds(),
    });
    yield* writer.begin();

    try {
      for (;;) {
        const next = await state.events.next();
        if (state.cancelRequested) {
          yield* writer.closeText();
          await this.finishChain(chainId, "terminal", CANCELLED_ERROR);
          await persist("cancelled", CANCELLED_ERROR);
          yield* writer.cancelled(CANCELLED_ERROR);
          return;
        }
        if (next.done) {
          const error = {
            code: "backend_protocol_error",
            message:
              "the user-owned runtime stream ended without a terminal event",
          };
          yield* writer.closeText();
          await this.finishChain(chainId, "terminal", error);
          await persist("failed", error);
          yield* writer.failed(error, { type: "api_error", param: null });
          return;
        }
        if (next.value.type === "completed") {
          if (!resolvedCall && continuation) {
            resolvedCall = true;
            await this.observeCallResult(continuation.callId);
          }
          yield* writer.closeText();
          await this.finishChain(chainId, "terminal", null);
          await persist("completed");
          yield* writer.completed();
          return;
        }
        const event = next.value;
        if (event.type === "text.delta") {
          if (!resolvedCall && continuation) {
            resolvedCall = true;
            await this.observeCallResult(continuation.callId);
          }
          yield* writer.appendText(event.delta);
          continue;
        }
        if (event.type === "tool.call") {
          if (!resolvedCall && continuation) {
            resolvedCall = true;
            await this.observeCallResult(continuation.callId);
          }
          yield* writer.closeText();
          const item = await this.recordCall(chainId, responseId, event, chain);
          if (state.cancelRequested) {
            await this.finishChain(chainId, "terminal", CANCELLED_ERROR);
            await persist("cancelled", CANCELLED_ERROR);
            yield* writer.cancelled(CANCELLED_ERROR);
            return;
          }
          yield* writer.functionCall(item);
          await this.publishCall(item.call_id);
          // The segment ends here; the harness run is deliberately retained.
          await this.finishChain(chainId, "waiting_for_output", null);
          await persist("completed");
          yield* writer.completed();
          return;
        }
        yield* writer.closeText();
        const cancelled = event.type === "cancelled";
        const error = cancelled
          ? CANCELLED_ERROR
          : { code: "backend_protocol_error", message: event.message };
        await this.finishChain(chainId, "terminal", error);
        await persist(cancelled ? "cancelled" : "failed", error);
        yield* cancelled
          ? writer.cancelled(error)
          : writer.failed(error, { type: "api_error", param: null });
        return;
      }
    } catch (cause) {
      const error =
        cause instanceof ResponseApiError &&
        cause.code === "backend_protocol_error"
          ? { code: cause.code, message: cause.message }
          : {
              code: "backend_unavailable",
              message: `the user-owned runtime stream failed: ${describe(cause)}`,
            };
      await this.finishChain(chainId, "terminal", error);
      await persist("failed", error);
      yield* writer.failed(error, { type: "api_error", param: null });
    } finally {
      state.busy = false;
    }
  }

  /**
   * A provider event after an output was posted is the only evidence available
   * that the result took effect. A 202 acknowledgement alone is not.
   */
  private async observeCallResult(callId: string): Promise<void> {
    const call = await this.store.getCall(callId);
    if (!call) return;
    await this.store.putCall({
      ...call,
      result: "provider_observed",
      updatedAt: this.seconds(),
    });
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
    const live = this.liveRun(chain.chainId);
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
    if (chain.status !== "running" && chain.status !== "waiting_for_output") {
      // A cancelled, cancelling or interrupted chain cannot accept an output,
      // so redelivering its parked call would only invite the application to
      // run a side effect whose result the chain can never take. The record
      // stays unresolved for the ledger; it just stops being deliverable.
      return [];
    }
    if (!this.liveRun(chain.chainId)) {
      await this.markInterrupted(chain);
      return [];
    }
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
      if (live) live.cancelRequested = true;
      await this.store.putChain({
        ...chain,
        status: "cancelling",
        updatedAt: this.seconds(),
      });
      if (live) {
        await live.run.cancel().catch(() => {});
      }
      // Cancellation is an engine-owned decision. Omnigent does not promise a
      // follow-up cancellation event, so waiting for one can hang the open
      // segment and allow a later tool call to resurrect the chain.
      await this.finishChain(chain.chainId, "terminal", CANCELLED_ERROR);
    }
    return this.describeChain(session, responseId);
  }

  /**
   * Best-effort cancellation requested by an HTTP client disconnect. It is not
   * an authorization boundary: the request that opened the segment was already
   * authorized, and the caller is the gateway itself. A completion already
   * committed wins; otherwise the engine commits cancellation and closes the
   * retained run itself. Omnigent does not promise a cancellation event that
   * would wake the segment.
   */
  async requestCancellation(responseId: string): Promise<void> {
    const response = await this.store.getResponse(responseId);
    if (!response) return;
    const state = this.active.get(response.chainId);
    if (!state || !state.busy) return;
    state.cancelRequested = true;
    await state.run.cancel().catch(() => {});
    await this.finishChain(response.chainId, "terminal", CANCELLED_ERROR);
  }

  /**
   * Whether an application session still has a chain that is not terminal.
   * The session-refresh path uses this to refuse repairing a provider session
   * out from under an active chain: the chain's private call IDs belong to the
   * old provider session, so a replacement would silently break it.
   */
  async hasLiveChain(appSessionId: string): Promise<boolean> {
    return (await this.liveChains(appSessionId)).length > 0;
  }

  /**
   * The session's non-terminal chains whose harness run can still be reached.
   * A chain whose run did not survive is retired to terminal here rather than
   * counted: it can never continue, and leaving it standing would block both
   * the next response and the capability refresh that would repair the
   * session — permanently, since nothing else would ever look at it again.
   */
  private async liveChains(
    appSessionId: string,
  ): Promise<readonly ChainRecord[]> {
    const live: ChainRecord[] = [];
    for (const chain of await this.store.listChains()) {
      if (chain.appSessionId !== appSessionId) continue;
      if (chain.status === "terminal") continue;
      if (this.liveRun(chain.chainId)) live.push(chain);
      else await this.markInterrupted(chain);
    }
    return live;
  }

  /**
   * One application session drives one chain at a time. Its provider session
   * is a single harness conversation, so a second initial response would
   * interleave two conversations on it and hand the application call IDs from
   * both.
   */
  private async requireNoLiveChain(appSessionId: string): Promise<void> {
    if ((await this.liveChains(appSessionId)).length > 0) {
      throw new ResponseApiError(
        "response_busy",
        "this application session already has an active response chain",
      );
    }
  }

  /** Releases live runs; used on shutdown and by tests. */
  async closeAll(): Promise<void> {
    const runs = [...this.active.values()];
    this.active.clear();
    await Promise.all(runs.map((state) => state.run.close().catch(() => {})));
  }

  /**
   * The chain's run, only if the harness can still be reached. A run that died
   * while the chain was parked is not a recovery path, and treating it as one
   * would report `reattached_live` for a chain that can never continue.
   */
  private liveRun(chainId: string): ActiveChain | undefined {
    const state = this.active.get(chainId);
    if (!state) return undefined;
    if (state.run.isAlive()) return state;
    this.active.delete(chainId);
    return undefined;
  }

  private async recordCall(
    chainId: string,
    responseId: string,
    event: Extract<BackendEvent, { type: "tool.call" }>,
    chain: ChainRecord,
  ): Promise<Extract<ResponseOutputItem, { type: "function_call" }>> {
    if (!chain.tools.some((tool) => tool.name === event.name)) {
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
    const state = this.active.get(chainId);
    if (state?.cancelRequested && status !== "terminal") {
      status = "terminal";
      terminalError = CANCELLED_ERROR;
    }
    await this.store.putChain({
      ...chain,
      status,
      terminalError,
      updatedAt: this.seconds(),
    });
    if (status === "terminal") {
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

const CANCELLED_ERROR: ResponseError = {
  code: "response_cancelled",
  message: "the response chain was cancelled",
};

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
