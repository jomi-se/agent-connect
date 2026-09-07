import type { IncomingMessage } from "node:http";

import type {
  DelegatedGrantService,
  DelegatedNativeCapability,
  OfferedDelegatedPolicy,
} from "../delegated-grants.js";

export const OPENCLAW_PLUGIN_ID = "agent-connect-openclaw";
export const FIXED_TOOLS_AUTHORIZATION_DETAIL = "agent_connect";
export const RESPONSES_SCOPE = "responses";
export const OPENCLAW_MODEL_ALIAS = "openclaw/default";

export interface AuthenticatedOwnerPrincipal {
  readonly profileId: string;
  readonly scopes: readonly string[];
}

export type OwnerVerifier = (
  request: IncomingMessage,
) =>
  | AuthenticatedOwnerPrincipal
  | undefined
  | Promise<AuthenticatedOwnerPrincipal | undefined>;

export interface OpenClawOAuthOptions {
  /** Canonical HTTPS origin hosting these endpoints. */
  readonly issuer: string;
  /** Exact configured native OpenClaw /v1/responses URL. */
  readonly resource: string;
  readonly grantService: DelegatedGrantService;
  readonly ownerVerifier: OwnerVerifier;
  readonly allowedOwnerProfileIds: readonly string[];
  readonly now?: () => number;
}

export interface OpenClawPluginPolicyConfig {
  readonly ref: string;
  readonly label: string;
  readonly description?: string;
  readonly agentId: string;
  readonly nativeCapabilities: readonly DelegatedNativeCapability[];
}

export interface OpenClawPluginConfig {
  readonly issuer: string;
  readonly resource: string;
  readonly statePath: string;
  readonly ownerProfileIds: readonly string[];
  readonly policies: readonly OpenClawPluginPolicyConfig[];
}

export interface OpenResponsesClientTool {
  readonly name: string;
  readonly description?: string;
  readonly inputSchema: Readonly<Record<string, unknown>>;
  readonly strict?: boolean;
}

export interface OpenResponsesApplicationAuthProvider {
  resolveBrowserOrigin?(request: HostHttpRequest): {
    readonly origin: string;
    readonly allowHeaders: readonly string[];
  } | null;
  authenticate(request: HostHttpRequest):
    | { readonly status: "pass" }
    | { readonly status: "deny"; readonly reason?: string }
    | {
        readonly status: "authenticated";
        readonly principal: OpenResponsesApplicationPrincipal;
      };
  authorize(input: {
    readonly principal: OpenResponsesApplicationPrincipal;
    readonly request: {
      readonly clientTools: readonly OpenResponsesClientTool[];
      readonly toolChoice: unknown;
      readonly hasMediaInput: boolean;
    };
  }): boolean;
}

export interface OpenResponsesApplicationPrincipal {
  readonly subject: string;
  readonly policyRef: string;
  readonly policyRevision: string;
  readonly context?: unknown;
}

export interface HostHttpRequest {
  readonly headers: Record<string, string | readonly string[] | undefined>;
}

export interface HostPluginApi {
  readonly pluginConfig: unknown;
  readonly config: unknown;
  registerHttpRoute(route: {
    readonly path: string;
    readonly auth: "plugin" | "gateway";
    readonly match: "exact";
    readonly gatewayRuntimeScopeSurface?: "trusted-operator";
    readonly handler: (request: unknown, response: unknown) => Promise<void>;
  }): void;
  registerOpenResponsesApplicationAuth(
    provider: OpenResponsesApplicationAuthProvider,
  ): void;
}

export type PolicyFingerprint = (
  config: unknown,
  policy: {
    readonly policyRef: string;
  },
) => string | undefined;

export function toOfferedPolicy(
  policy: OpenClawPluginPolicyConfig,
  fingerprint: string,
): OfferedDelegatedPolicy {
  return { ...policy, fingerprint };
}
