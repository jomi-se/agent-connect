declare module "openclaw/plugin-sdk/authenticated-http-principal" {
  import type { IncomingMessage } from "node:http";

  export function authenticateVerifiedPluginHttpPrincipal(
    request: IncomingMessage,
    options: { readonly authMethods: readonly ["tailscale"] },
  ): Promise<
    | {
        readonly profileId: string;
        readonly scopes: readonly string[];
        readonly authMethod: "tailscale";
      }
    | undefined
  >;

  export function getAuthenticatedPluginHttpPrincipal():
    | { readonly profileId: string; readonly scopes: readonly string[] }
    | undefined;
}

declare module "openclaw/plugin-sdk/openresponses-application-policy" {
  export function fingerprintOpenResponsesApplicationPolicy(
    config: unknown,
    policy: { readonly policyRef: string },
  ): string | undefined;
}
