/** Cumulative spend attributed to one provider session, as the provider reports it. */
export interface RuntimeSessionUsage {
  readonly status: string | null;
  readonly runnerOnline: boolean;
  readonly totalCostUsd: number | null;
  readonly totalTokens: number | null;
  readonly contextWindow: number | null;
}
