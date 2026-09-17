import type { IncomingMessage } from "node:http";

import type { DelegatedGrantService } from "../delegated-grants.js";

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
  readonly ownerConsolePath: string;
  readonly ownerLoginPath: string;
  readonly ownerRevokePath: string;
  readonly ownerRevokeAllPath: string;
  readonly ownerForgetPath: string;
  readonly healthPath: string;
  readonly responsesPath: string;
  readonly conversationsPath: string;
}

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
    ownerConsolePath: "/agent-connect/owner",
    ownerLoginPath: "/agent-connect/owner/login",
    ownerRevokePath: "/agent-connect/owner/grants/revoke",
    ownerRevokeAllPath: "/agent-connect/owner/grants/revoke-all",
    ownerForgetPath: "/agent-connect/owner/forget",
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
  readonly endpoints: AgentConnectEndpointLayout;
  readonly grantService: DelegatedGrantService;
  readonly ownerVerifier: OwnerVerifier;
  readonly allowedOwnerProfileIds: readonly string[];
  readonly now?: () => number;
}
