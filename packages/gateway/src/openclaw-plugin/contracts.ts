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

export interface AgentConnectEndpointLayout {
  readonly issuerPath: string;
  readonly authorizationServerMetadataPath: string;
  readonly protectedResourceMetadataPath: string;
  readonly authorizationPath: string;
  readonly tokenPath: string;
  readonly revocationPath: string;
  readonly parPath: string;
  readonly ownerLoginPath: string;
  readonly healthPath: string;
  readonly responsesPath: string;
  readonly conversationsPath: string;
}

export const STANDALONE_ENDPOINT_LAYOUT: AgentConnectEndpointLayout =
  Object.freeze({
    issuerPath: "",
    authorizationServerMetadataPath: "/.well-known/oauth-authorization-server",
    protectedResourceMetadataPath: "/.well-known/oauth-protected-resource",
    authorizationPath: "/agent-connect/oauth/authorize",
    tokenPath: "/agent-connect/oauth/token",
    revocationPath: "/agent-connect/oauth/revoke",
    parPath: "/agent-connect/oauth/par",
    ownerLoginPath: "/agent-connect/owner/login",
    healthPath: "/healthz",
    responsesPath: "/v1/responses",
    conversationsPath: "/v1/agent-connect/conversations",
  });

export const STOCK_PLUGIN_ENDPOINT_LAYOUT: AgentConnectEndpointLayout =
  Object.freeze({
    issuerPath: "/agent-connect",
    authorizationServerMetadataPath:
      "/.well-known/oauth-authorization-server/agent-connect",
    protectedResourceMetadataPath:
      "/.well-known/oauth-protected-resource/agent-connect/v1/responses",
    authorizationPath: "/agent-connect/oauth/authorize",
    tokenPath: "/agent-connect/oauth/token",
    revocationPath: "/agent-connect/oauth/revoke",
    parPath: "/agent-connect/oauth/par",
    ownerLoginPath: "/agent-connect/owner/login",
    healthPath: "/agent-connect/healthz",
    responsesPath: "/agent-connect/v1/responses",
    conversationsPath: "/agent-connect/v1/conversations",
  });

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
  /** Canonical HTTPS issuer URL hosting these endpoints. */
  readonly issuer: string;
  /** Exact application-facing Responses resource URL. */
  readonly resource: string;
  readonly endpoints?: AgentConnectEndpointLayout;
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
