declare module "openclaw/plugin-sdk/gateway-runtime" {
  export function resolveGatewayAuth(options: {
    readonly authConfig?: Record<string, unknown> | null;
    readonly authOverride?: Record<string, unknown> | null;
    readonly env?: NodeJS.ProcessEnv;
    readonly tailscaleMode?: string;
  }): {
    readonly mode: unknown;
    readonly token?: string;
    readonly password?: string;
  };
}

declare module "openclaw/plugin-sdk/config-runtime" {
  export function resolveConfiguredSecretInputString(options: {
    readonly config: Record<string, unknown>;
    readonly env: NodeJS.ProcessEnv;
    readonly value: unknown;
    readonly path: string;
    readonly unresolvedReasonStyle?: "generic" | "detailed";
  }): Promise<{
    readonly value?: string;
    readonly unresolvedRefReason?: string;
  }>;
}
