export interface ModelRequestBody {
  messages: Array<{ role: string; content: unknown; [key: string]: unknown }>;
  tools?: Array<{
    type: string;
    function: { name: string; [key: string]: unknown };
  }>;
  [key: string]: unknown;
}

export interface ModelObservation {
  path: string;
  body: ModelRequestBody;
  closed: boolean;
  completed: boolean;
}

export interface InferenceFixture {
  text(text: string): void;
  tool(name: string, args: unknown, id?: string): void;
  hang(text?: string): void;
  observation: ModelObservation;
}

export interface OpenClawTestRuntime {
  baseUrl: string;
  token: string;
  agentId: "main";
  model: "openclaw";
  directory: string;
  modelRequests: ModelObservation[];
  request(
    body: Record<string, unknown>,
    options?: { sessionKey?: string; signal?: AbortSignal },
  ): Promise<Response>;
  close(): Promise<void>;
}

export const compatibility: {
  package: string;
  version: string;
  tarball: string;
  integrity: string;
  minimumNodeVersion: string;
  maximumNodeMajorExclusive: number;
  runtime: string;
};
export function preflightOpenClaw(): string;
export function isSupportedOpenClawNode(version: string): boolean;
export function startOpenClawTestRuntime(options?: {
  onModelRequest?: (
    body: ModelRequestBody,
    inference: InferenceFixture,
  ) => void | Promise<void>;
}): Promise<OpenClawTestRuntime>;
