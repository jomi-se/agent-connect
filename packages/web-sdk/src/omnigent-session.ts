import { AgentSession } from "./agent-session.js";
import { OmnigentProvider } from "./omnigent-provider.js";
import type { ApplicationTool, OmnigentProviderOptions } from "./types.js";

export interface ConnectOmnigentOptions extends OmnigentProviderOptions {
  readonly tools: readonly ApplicationTool[];
}

/**
 * Bind the harness-neutral application API to an existing OmniGENT session.
 * Session provisioning and runner launch belong to the user-owned runtime.
 */
export function connectOmnigent(options: ConnectOmnigentOptions): AgentSession {
  return new AgentSession({
    provider: new OmnigentProvider(options),
    tools: options.tools,
  });
}
