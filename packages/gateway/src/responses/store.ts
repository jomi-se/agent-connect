import type { GatewayToolDefinition } from "../tool-snapshot.js";
import type {
  ResponseError,
  ResponseOutputItem,
  ResponseStatus,
} from "./protocol.js";

/**
 * The three orthogonal durable axes of one application function call. See "Call
 * state is three axes, not one" in
 * docs/plan/open-responses-vertical-slice.md: `pending -> delivered -> resolved`
 * conflates publication with provider delivery and has nowhere to record
 * "output persisted but not yet posted".
 */
export type CallPublicationState =
  "recorded" | "publication_started" | "published";

export type CallResultState =
  "none" | "output_recorded" | "delivery_attempted" | "provider_observed";

export type ChainStatus =
  "running" | "waiting_for_output" | "cancelling" | "terminal";

export interface ChainRecord {
  readonly chainId: string;
  readonly appSessionId: string;
  readonly appId: string;
  readonly origin: string;
  readonly authorizationGrantId: string;
  readonly toolHash: string;
  readonly tools: readonly GatewayToolDefinition[];
  readonly providerKind: string;
  readonly providerSessionId: string;
  readonly status: ChainStatus;
  readonly createdAt: number;
  readonly updatedAt: number;
  readonly latestResponseId: string | null;
  readonly terminalError: ResponseError | null;
}

export interface ResponseRecord {
  readonly responseId: string;
  readonly chainId: string;
  readonly previousResponseId: string | null;
  readonly status: ResponseStatus;
  readonly createdAt: number;
  readonly completedAt: number | null;
  readonly output: readonly ResponseOutputItem[];
  readonly error: ResponseError | null;
}

export interface CallRecord {
  readonly callId: string;
  readonly chainId: string;
  readonly responseId: string;
  /** Never leaves the gateway; the browser only ever sees `callId`. */
  readonly providerToken: string;
  readonly name: string;
  readonly arguments: string;
  readonly publication: CallPublicationState;
  readonly result: CallResultState;
  readonly output: string | null;
  readonly outputFingerprint: string | null;
  readonly createdAt: number;
  readonly updatedAt: number;
}

/**
 * The narrow persistence seam the engine depends on. Every mutation must be
 * durable before the caller publishes anything derived from it.
 */
export interface ResponseStore {
  putChain(chain: ChainRecord): Promise<void>;
  getChain(chainId: string): Promise<ChainRecord | undefined>;
  putResponse(response: ResponseRecord): Promise<void>;
  getResponse(responseId: string): Promise<ResponseRecord | undefined>;
  putCall(call: CallRecord): Promise<void>;
  getCall(callId: string): Promise<CallRecord | undefined>;
  /** Calls of one chain whose result has not yet been observed by the provider. */
  unresolvedCalls(chainId: string): Promise<readonly CallRecord[]>;
}

export class InMemoryResponseStore implements ResponseStore {
  private readonly chains = new Map<string, ChainRecord>();
  private readonly responses = new Map<string, ResponseRecord>();
  private readonly calls = new Map<string, CallRecord>();

  async putChain(chain: ChainRecord): Promise<void> {
    this.chains.set(chain.chainId, chain);
  }

  async getChain(chainId: string): Promise<ChainRecord | undefined> {
    return this.chains.get(chainId);
  }

  async putResponse(response: ResponseRecord): Promise<void> {
    this.responses.set(response.responseId, response);
  }

  async getResponse(responseId: string): Promise<ResponseRecord | undefined> {
    return this.responses.get(responseId);
  }

  async putCall(call: CallRecord): Promise<void> {
    this.calls.set(call.callId, call);
  }

  async getCall(callId: string): Promise<CallRecord | undefined> {
    return this.calls.get(callId);
  }

  async unresolvedCalls(chainId: string): Promise<readonly CallRecord[]> {
    return [...this.calls.values()].filter(
      (call) => call.chainId === chainId && call.result !== "provider_observed",
    );
  }
}
