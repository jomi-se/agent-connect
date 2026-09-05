import { createHash, randomUUID } from "node:crypto";
import type { GatewayToolDefinition } from "../tool-snapshot.js";
import { ResponseApiError } from "./errors.js";
import {
  buildResponseResource,
  projectTools,
  type ResponseResource,
  type ResponseStreamEvent,
  type ResponseOutputItem,
} from "./protocol.js";
import type {
  CallRecord,
  ChainRecord,
  ResponseRecord,
  ResponseStore,
} from "./store.js";
import type { ParsedResponseRequest } from "./profile.js";
import { OpenClawResponses } from "./openclaw.js";

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
  readonly upstream: OpenClawResponses;
  readonly isGrantActive: (grantId: string) => boolean;
  readonly now?: () => number;
}
export type SessionLifecycle =
  | { readonly kind: "running" | "parked"; readonly since: number }
  | { readonly kind: "idle" | "interrupted" };
export type SessionEndReason =
  "expired" | "idle" | "unanswered_call" | "stalled" | "ended_by_owner";
export interface ChainView {
  readonly responseId: string;
  readonly chainStatus: ChainRecord["status"];
  readonly recovery:
    "reattached_live" | "terminal_reconstructed" | "interrupted";
  readonly response: ResponseResource;
}
interface Admission {
  readonly controller: AbortController;
  readonly since: number;
  chainId?: string;
}

/** Local authority and no-redrive ledger only. OpenClaw owns execution and history. */
export class ResponseEngine {
  private readonly active = new Map<string, Admission>();
  private readonly poisoned = new Set<string>();
  private readonly revisions = new Map<string, number>();
  private revision(id: string) {
    return this.revisions.get(id) ?? 0;
  }
  private changed(id: string) {
    this.revisions.set(id, this.revision(id) + 1);
  }
  private readonly now: () => number;
  constructor(private readonly options: ResponseEngineOptions) {
    this.now = options.now ?? Date.now;
  }
  private get store() {
    return this.options.store;
  }
  private seconds() {
    return Math.floor(this.now() / 1000);
  }
  private async authorize(session: EngineSession, admission?: Admission) {
    if (
      !this.options.isGrantActive(session.authorizationGrantId) ||
      admission?.controller.signal.aborted ||
      this.poisoned.has(session.sessionId) ||
      (await this.store.isSessionRetired(session.sessionId))
    ) {
      throw new ResponseApiError(
        "response_cancelled",
        "the application session is no longer active",
      );
    }
    // Retirement/revocation can happen during the store await.
    if (
      !this.options.isGrantActive(session.authorizationGrantId) ||
      admission?.controller.signal.aborted
    )
      throw new ResponseApiError(
        "response_cancelled",
        "the application session is no longer active",
      );
  }
  private async owned(session: EngineSession, id: string) {
    await this.authorize(session);
    const response = await this.store.getResponse(id);
    const chain = response && (await this.store.getChain(response.chainId));
    if (
      !response ||
      !chain ||
      chain.appSessionId !== session.sessionId ||
      chain.appId !== session.appId ||
      chain.origin !== session.origin ||
      chain.toolHash !== session.toolHash ||
      chain.authorizationGrantId !== session.authorizationGrantId
    ) {
      throw new ResponseApiError(
        "previous_response_not_found",
        "response does not belong to this application session",
      );
    }
    return { response, chain };
  }
  async createResponse(
    session: EngineSession,
    request: ParsedResponseRequest,
  ): Promise<AsyncGenerator<ResponseStreamEvent>> {
    if (this.active.has(session.sessionId))
      throw new ResponseApiError(
        "response_busy",
        "one response may run per application session",
      );
    const admission: Admission = {
      controller: new AbortController(),
      since: this.seconds(),
    };
    this.active.set(session.sessionId, admission);
    this.changed(session.sessionId);
    let admitted: ChainRecord | undefined;
    try {
      await this.authorize(session, admission);
      const chains = (await this.store.listChains())
        .filter((c) => c.appSessionId === session.sessionId)
        .sort((a, b) => b.sessionTurn - a.sessionTurn);
      const head = chains[0];
      const previousId =
        request.kind === "initial" ? null : request.previousResponseId;
      let prior: Awaited<ReturnType<ResponseEngine["owned"]>> | undefined;
      let call: CallRecord | undefined;
      if (previousId) prior = await this.owned(session, previousId);
      if (request.kind === "continuation") {
        call = await this.store.getCall(request.callId);
        if (
          !prior ||
          !call ||
          call.chainId !== prior.chain.chainId ||
          call.responseId !== previousId
        )
          throw new ResponseApiError(
            "function_call_not_found",
            "call does not belong to this response",
          );
        if (call.output !== null) {
          throw new ResponseApiError(
            call.output === request.output
              ? "previous_response_not_continuable"
              : "function_output_conflict",
            "this output was already submitted and will not be redelivered",
          );
        }
        if (
          prior.chain.status !== "waiting_for_output" ||
          call.result !== "none"
        )
          throw new ResponseApiError(
            "previous_response_not_continuable",
            "function call cannot be continued",
          );
      } else if (
        prior &&
        (prior.chain.status !== "terminal" ||
          prior.response.status !== "completed")
      ) {
        throw new ResponseApiError(
          "previous_response_not_continuable",
          "the previous turn is not complete",
        );
      }
      if (
        head &&
        (head.providerKind !== "openclaw" ||
          head.latestResponseId !== previousId ||
          head.terminalError ||
          (head.status === "running" && head.chainId !== admission.chainId))
      ) {
        throw new ResponseApiError(
          "previous_response_not_continuable",
          "only the latest healthy OpenClaw checkpoint can be continued; create a new session after interruption or migration",
        );
      }
      if (!previousId && head)
        throw new ResponseApiError(
          "invalid_request",
          "previous_response_id is required",
        );
      await this.authorize(session, admission);
      const timestamp = this.seconds();
      const chain: ChainRecord = {
        chainId: "chain_" + randomUUID(),
        appSessionId: session.sessionId,
        appId: session.appId,
        origin: session.origin,
        authorizationGrantId: session.authorizationGrantId,
        toolHash: session.toolHash,
        tools: session.tools,
        providerKind: "openclaw",
        providerSessionId: session.providerSessionId,
        sessionTurn: (head?.sessionTurn ?? 0) + 1,
        continuedFromResponseId: previousId,
        status: "running",
        createdAt: timestamp,
        updatedAt: timestamp,
        latestResponseId: null,
        terminalError: null,
      };
      await this.store.putChain(chain);
      admitted = chain;
      admission.chainId = chain.chainId;
      if (call && request.kind === "continuation") {
        // Commit the no-redrive boundary before the network call. A crash from here
        // onward is ambiguous, even if no bytes actually reached OpenClaw.
        await this.store.putCall({
          ...call,
          output: request.output,
          outputFingerprint: createHash("sha256")
            .update(request.output)
            .digest("hex"),
          result: "delivery_attempted",
          updatedAt: timestamp,
        });
      }
      await this.authorize(session, admission);
      const stream = await this.options.upstream.create(
        session.providerSessionId,
        session.tools,
        request,
        admission.controller.signal,
      );
      await this.authorize(session, admission);
      return this.mediate(session, chain, admission, stream, call);
    } catch (error) {
      admission.controller.abort();
      try {
        if (admitted)
          await this.interrupt(
            admitted,
            "upstream acceptance is uncertain; no automatic replay",
          );
      } finally {
        this.active.delete(session.sessionId);
      }
      throw error;
    }
  }
  private async *mediate(
    session: EngineSession,
    initial: ChainRecord,
    admission: Admission,
    stream: AsyncGenerator<ResponseStreamEvent>,
    submitted?: CallRecord,
  ): AsyncGenerator<ResponseStreamEvent> {
    let chain = initial;
    let response: ResponseRecord | undefined;
    let completed = false;
    const held: ResponseStreamEvent[] = [];
    const items = new Map<string, ResponseOutputItem>();
    try {
      for await (const event of stream) {
        await this.authorize(session, admission);
        if ("response" in event) {
          const resource = event.response;
          if (
            resource.status === "in_progress" &&
            resource.output.some((item) => item.type === "function_call")
          )
            throw protocolError();
          if (response && response.responseId !== resource.id)
            throw protocolError();
          const existing = await this.store.getResponse(resource.id);
          if (existing && existing.chainId !== chain.chainId)
            throw protocolError();
          response = {
            responseId: resource.id,
            chainId: chain.chainId,
            previousResponseId: chain.continuedFromResponseId,
            status: resource.status,
            createdAt: resource.created_at,
            completedAt: resource.completed_at,
            output: resource.output,
            error: resource.error,
          };
          await this.store.putResponse(response);
          chain = {
            ...chain,
            latestResponseId: resource.id,
            updatedAt: this.seconds(),
          };
          await this.store.putChain(chain);
        }
        if (!response) throw protocolError();
        if ("item" in event) {
          this.validateItem(session, event.item);
          if (event.type === "response.output_item.done") {
            if (items.has(event.item.id)) throw protocolError();
            items.set(event.item.id, event.item);
          }
          if (event.item.type === "function_call") {
            held.push(event);
            continue;
          }
        }
        if (event.type === "response.function_call_arguments.done") {
          held.push(event);
          continue;
        }
        const terminal =
          event.type === "response.completed" ||
          event.type === "response.failed" ||
          event.type === "response.incomplete";
        if (terminal && "response" in event) {
          const calls = event.response.output.filter(
            (item) => item.type === "function_call",
          );
          for (const item of event.response.output)
            this.validateItem(session, item);
          if (calls.length > 1) throw protocolError();
          for (const call of calls)
            if (!items.has(call.id) || call.status !== "completed")
              throw protocolError();
          for (const pending of held) {
            if ("item" in pending && pending.item.type === "function_call") {
              const item = pending.item;
              if (
                !calls.some(
                  (call) =>
                    call.id === item.id &&
                    call.call_id === item.call_id &&
                    call.name === item.name &&
                    call.arguments === item.arguments,
                )
              )
                throw protocolError();
            } else if (
              pending.type === "response.function_call_arguments.done"
            ) {
              if (
                !calls.some(
                  (call) =>
                    call.id === pending.item_id &&
                    call.arguments === pending.arguments,
                )
              )
                throw protocolError();
            }
          }
          for (const item of items.values())
            if (
              item.type === "function_call" &&
              !calls.some(
                (call) => JSON.stringify(call) === JSON.stringify(item),
              )
            )
              throw protocolError();
          if (event.type !== "response.completed" && calls.length)
            throw protocolError();
          for (const item of calls) {
            if (await this.store.getCall(item.call_id)) throw protocolError();
            await this.store.putCall({
              callId: item.call_id,
              chainId: chain.chainId,
              responseId: response.responseId,
              providerToken: item.call_id,
              name: item.name,
              arguments: item.arguments,
              publication: "published",
              result: "none",
              output: null,
              outputFingerprint: null,
              createdAt: this.seconds(),
              updatedAt: this.seconds(),
            });
          }
          chain = {
            ...chain,
            status: calls.length ? "waiting_for_output" : "terminal",
            terminalError: event.response.error,
            updatedAt: this.seconds(),
          };
          await this.store.putChain(chain);
          if (submitted) {
            const recorded = await this.store.getCall(submitted.callId);
            if (recorded)
              await this.store.putCall({
                ...recorded,
                result: "provider_observed",
                updatedAt: this.seconds(),
              });
          }
          await this.authorize(session, admission);
          completed = true;
          for (const pending of held) {
            await this.authorize(session, admission);
            yield pending;
          }
          await this.authorize(session, admission);
          yield event;
          return;
        }
        if (held.length) {
          held.push(event);
          continue;
        }
        await this.authorize(session, admission);
        yield event;
      }
      throw protocolError();
    } catch (error) {
      await this.interrupt(
        chain,
        admission.controller.signal.aborted
          ? "cancelled locally; upstream stop is unconfirmed"
          : "delivery interrupted; continuation is uncertain and will not be replayed",
      );
      throw error instanceof ResponseApiError
        ? error
        : new ResponseApiError(
            "backend_unavailable",
            "OpenClaw response interrupted; use recovery to inspect the checkpoint",
          );
    } finally {
      admission.controller.abort();
      try {
        if (!completed)
          await this.interrupt(
            chain,
            "delivery interrupted; no automatic replay",
          );
      } finally {
        this.active.delete(session.sessionId);
      }
    }
  }
  private validateItem(session: EngineSession, item: ResponseOutputItem) {
    if (
      item.type === "function_call" &&
      !session.tools.some((tool) => tool.name === item.name)
    )
      throw new ResponseApiError(
        "backend_protocol_error",
        "upstream requested an unapproved application tool",
      );
  }
  private async interrupt(chain: ChainRecord, message: string) {
    this.changed(chain.appSessionId);
    try {
      const current = (await this.store.getChain(chain.chainId)) ?? chain;
      await this.store.putChain({
        ...current,
        status: "terminal",
        updatedAt: this.seconds(),
        terminalError: { code: "backend_unavailable", message },
      });
    } catch (error) {
      this.poisoned.add(chain.appSessionId);
      throw error;
    }
  }
  async describeChain(session: EngineSession, id: string): Promise<ChainView> {
    const revision = this.revision(session.sessionId);
    let { chain, response } = await this.owned(session, id);
    if (
      chain.providerKind !== "openclaw" ||
      (chain.status === "running" && !this.active.has(session.sessionId))
    ) {
      await this.interrupt(
        chain,
        "interrupted runtime or migrated provider; create a new application session",
      );
      chain = (await this.store.getChain(chain.chainId))!;
    }
    const head = (await this.store.listChains())
      .filter((c) => c.appSessionId === session.sessionId)
      .sort((a, b) => b.sessionTurn - a.sessionTurn)[0];
    const unavailableCall =
      chain.status === "waiting_for_output" &&
      (head?.chainId !== chain.chainId ||
        this.active.get(session.sessionId)?.controller.signal.aborted === true);
    await this.authorize(session);
    const interrupted =
      !!chain.terminalError ||
      unavailableCall ||
      revision !== this.revision(session.sessionId);
    // A terminal upstream resource is persisted before its call ledger commit.
    // Recovery must not turn that intermediate write into tool publication.
    const canPublishCalls =
      !interrupted && chain.status === "waiting_for_output";
    return {
      responseId: id,
      chainStatus: chain.status,
      recovery: interrupted
        ? "interrupted"
        : chain.status === "terminal"
          ? "terminal_reconstructed"
          : "reattached_live",
      response: buildResponseResource({
        id,
        createdAt: response.createdAt,
        completedAt: response.completedAt,
        status: interrupted ? "failed" : response.status,
        previousResponseId: response.previousResponseId,
        output: canPublishCalls
          ? response.output
          : response.output.filter((item) => item.type !== "function_call"),
        error: chain.terminalError ?? response.error,
        tools: projectTools(chain.tools),
      }),
    };
  }
  async pendingFunctionCalls(session: EngineSession, id: string) {
    const revision = this.revision(session.sessionId);
    const view = await this.describeChain(session, id);
    const { chain } = await this.owned(session, id);
    const head = (await this.store.listChains())
      .filter((c) => c.appSessionId === session.sessionId)
      .sort((a, b) => b.sessionTurn - a.sessionTurn)[0];
    if (
      view.recovery === "interrupted" ||
      chain.status !== "waiting_for_output" ||
      head?.chainId !== chain.chainId
    )
      return [];
    const calls = await this.store.unresolvedCalls(chain.chainId);
    await this.authorize(session);
    if (revision !== this.revision(session.sessionId)) return [];
    return calls
      .filter((call) => call.result === "none")
      .map((call) => ({
        callId: call.callId,
        name: call.name,
        arguments: call.arguments,
        responseId: call.responseId,
      }));
  }
  async cancelChain(session: EngineSession, id: string) {
    const { chain } = await this.owned(session, id);
    const admission = this.active.get(session.sessionId);
    if (admission && admission.chainId !== chain.chainId)
      throw new ResponseApiError(
        "previous_response_not_continuable",
        "only the active response may be cancelled",
      );
    this.changed(session.sessionId);
    admission?.controller.abort();
    await this.interrupt(
      chain,
      "cancelled locally; upstream stop is unconfirmed",
    );
    return this.describeChain(session, id);
  }
  async requestCancellation(id: string) {
    const response = await this.store.getResponse(id);
    const chain = response && (await this.store.getChain(response.chainId));
    if (chain) {
      this.active.get(chain.appSessionId)?.controller.abort();
      await this.interrupt(
        chain,
        "client disconnected; upstream stop is unconfirmed",
      );
    }
  }
  cancelAdmission(id: string) {
    this.changed(id);
    this.active.get(id)?.controller.abort();
  }
  async expireSession(id: string, reason: SessionEndReason = "expired") {
    this.changed(id);
    this.active.get(id)?.controller.abort();
    for (const chain of await this.store.listChains())
      if (chain.appSessionId === id)
        await this.interrupt(chain, reason + "; upstream stop is unconfirmed");
  }
  async sessionLifecycle(id: string): Promise<SessionLifecycle> {
    const active = this.active.get(id);
    if (active) return { kind: "running", since: active.since };
    const head = (await this.store.listChains())
      .filter((c) => c.appSessionId === id)
      .sort((a, b) => b.sessionTurn - a.sessionTurn)[0];
    if (
      head &&
      (head.providerKind !== "openclaw" ||
        head.terminalError ||
        head.status === "running")
    )
      return { kind: "interrupted" };
    if (
      head?.providerKind === "openclaw" &&
      head.status === "waiting_for_output" &&
      !head.terminalError
    )
      return { kind: "parked", since: head.updatedAt };
    return { kind: "idle" };
  }
}
function protocolError() {
  return new ResponseApiError(
    "backend_protocol_error",
    "OpenClaw returned an invalid bounded Responses stream",
  );
}
