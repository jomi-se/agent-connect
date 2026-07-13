export interface RuntimeSessionRequest {
  readonly appId: string;
  readonly origin: string;
  readonly toolHash: string;
}

export interface AgentRuntime {
  createSession(request: RuntimeSessionRequest): Promise<string>;
  isHealthy(providerSessionId: string): Promise<boolean>;
}
