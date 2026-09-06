declare module "openclaw/plugin-sdk/authenticated-http-principal" {
  import type { IncomingMessage } from "node:http";

  export function authenticateManagedTailscaleOwnerConsent(
    request: IncomingMessage,
  ): Promise<
    | { readonly profileId: string; readonly scopes: readonly string[] }
    | undefined
  >;

  export function getAuthenticatedPluginHttpPrincipal():
    | { readonly profileId: string; readonly scopes: readonly string[] }
    | undefined;
}

declare module "openclaw/plugin-sdk/openresponses-application-policy" {
  export function fingerprintOpenResponsesApplicationPolicy(
    config: unknown,
    policy: {
      readonly policyRef: string;
      readonly agentId: string;
      readonly nativeCapabilities: readonly (
        "public_web_search" | "sandbox_code_execution"
      )[];
    },
  ): string | undefined;
}
