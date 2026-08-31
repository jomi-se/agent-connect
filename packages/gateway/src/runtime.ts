export interface RuntimeSessionRequest {
  readonly appId: string;
  readonly origin: string;
  readonly toolHash: string;
  readonly approvedToolNames: readonly string[];
}

/** Cumulative spend attributed to one provider session, as the provider reports it. */
export interface RuntimeSessionUsage {
  readonly status: string | null;
  readonly runnerOnline: boolean;
  readonly totalCostUsd: number | null;
  readonly totalTokens: number | null;
  readonly contextWindow: number | null;
}

export interface AgentRuntime {
  createSession(request: RuntimeSessionRequest): Promise<string>;
  isHealthy(providerSessionId: string): Promise<boolean>;
  /**
   * Releases the provider session and everything provisioned alongside it.
   * Optional so an embedding host can supply a runtime that owns no disposable
   * resources; the gateway treats teardown as best-effort either way, because
   * a failure here must never keep an expired application session alive.
   */
  destroySession?(providerSessionId: string): Promise<void>;
  /**
   * Cumulative usage for the operator console. Optional and best-effort: the
   * console renders a session without usage rather than failing when the
   * provider cannot answer.
   */
  describeSession?(
    providerSessionId: string,
  ): Promise<RuntimeSessionUsage | undefined>;
}
