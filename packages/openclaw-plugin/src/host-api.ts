import type { IncomingMessage, ServerResponse } from "node:http";

export interface OpenClawConfigMutationResult {
  readonly changed: boolean;
  readonly reason?: string;
}

export interface StockPluginApi {
  readonly id: string;
  readonly rootDir?: string;
  readonly registrationMode:
    | "full"
    | "discovery"
    | "tool-discovery"
    | "setup-only"
    | "setup-runtime"
    | "cli-metadata";
  readonly pluginConfig?: Record<string, unknown>;
  readonly runtime: {
    readonly version: string;
    readonly config: {
      current(): Readonly<Record<string, unknown>>;
      mutateConfigFile<T>(options: {
        readonly afterWrite: { readonly mode: "none"; readonly reason: string };
        readonly mutate: (
          draft: Record<string, unknown>,
        ) => T | void | Promise<T | void>;
      }): Promise<{ readonly result: T | undefined }>;
    };
    readonly gateway: {
      request<T = unknown>(
        method: string,
        params?: Record<string, unknown>,
        options?: { readonly timeoutMs?: number },
      ): Promise<T>;
    };
    readonly state: {
      resolveStateDir(): string;
    };
  };
  readonly logger: {
    info(message: string): void;
    warn(message: string): void;
    error(message: string): void;
  };
  registerHttpRoute(route: {
    readonly path: string;
    readonly auth: "plugin";
    readonly match: "exact" | "prefix";
    readonly handler: (
      request: IncomingMessage,
      response: ServerResponse,
    ) => Promise<void> | void;
  }): void;
  registerService(service: {
    readonly id: string;
    readonly start: (context: {
      readonly config: Record<string, unknown>;
      readonly stateDir: string;
      readonly serviceHealth?: {
        reportFailure(error: unknown): void;
        clearFailure(): void;
      };
    }) => Promise<void> | void;
    readonly stop?: () => Promise<void> | void;
  }): void;
  registerCli(
    registrar: (context: {
      readonly program: CommanderProgram;
    }) => Promise<void> | void,
    options: {
      readonly descriptors: readonly {
        readonly name: string;
        readonly description: string;
        readonly hasSubcommands: boolean;
      }[];
    },
  ): void;
}

export interface CommanderProgram {
  command(name: string): CommanderCommand;
}

export interface CommanderCommand {
  description(value: string): this;
  option(flags: string, description: string, defaultValue?: string): this;
  action(handler: (options: Record<string, unknown>) => Promise<void>): this;
  command(name: string): CommanderCommand;
}
