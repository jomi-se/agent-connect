import { GatewayClient } from "@openclaw/gateway-client";
import { PROTOCOL_VERSION } from "@openclaw/gateway-protocol/version";

import {
  requireOpenClawUpstreamAuth,
  type OpenClawUpstreamAuth,
} from "./upstream-auth.js";

export interface StockOpenClawConfigGet {
  readonly valid?: unknown;
  readonly sourceConfig?: unknown;
  readonly hash?: unknown;
  readonly configRevisionHash?: unknown;
  readonly appliedConfigHash?: unknown;
}

export interface OpenClawRuntimePolicyVerifier {
  readonly appliedConfigHash: string;
  assertCurrent(): Promise<void>;
}

export type OpenClawConfigReader = () => Promise<StockOpenClawConfigGet>;

export async function createOpenClawRuntimePolicyVerifier(options: {
  readonly readConfig: OpenClawConfigReader;
  readonly validateSourceConfig: (value: unknown) => void;
}): Promise<OpenClawRuntimePolicyVerifier> {
  const initial = await options.readConfig();
  const appliedConfigHash = requireAppliedRevision(initial);
  options.validateSourceConfig(initial.sourceConfig);
  return {
    appliedConfigHash,
    async assertCurrent() {
      const current = await options.readConfig();
      if (requireAppliedRevision(current) !== appliedConfigHash) {
        throw new Error(
          "OpenClaw runtime configuration changed; controlled restart and reconsent required",
        );
      }
      options.validateSourceConfig(current.sourceConfig);
    },
  };
}

export async function readStockOpenClawConfig(options: {
  readonly upstreamBaseUrl: string;
  readonly upstreamAuth: OpenClawUpstreamAuth;
  readonly timeoutMs?: number;
}): Promise<StockOpenClawConfigGet> {
  return readStockOpenClawRpc(options, "config.get", {});
}

export async function readStockOpenClawRpc<T>(
  options: {
    readonly upstreamBaseUrl: string;
    readonly upstreamAuth: OpenClawUpstreamAuth;
    readonly timeoutMs?: number;
  },
  method: "config.get" | "chat.history",
  params: Record<string, unknown>,
): Promise<T> {
  const url = new URL(options.upstreamBaseUrl);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  const upstreamAuth = requireOpenClawUpstreamAuth(options.upstreamAuth);
  const timeoutMs = options.timeoutMs ?? 10_000;
  return await new Promise<T>((resolve, reject) => {
    let settled = false;
    let client: GatewayClient | undefined;
    const finish = (error?: Error, value?: T) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      client?.stop();
      if (error) reject(error);
      else resolve(value as T);
    };
    const timer = setTimeout(
      () => finish(new Error("OpenClaw config.get timed out")),
      timeoutMs,
    );
    try {
      client = new GatewayClient({
        url: url.href,
        ...(upstreamAuth.mode === "token"
          ? { token: upstreamAuth.credential }
          : upstreamAuth.mode === "password"
            ? { password: upstreamAuth.credential }
            : {}),
        role: "operator",
        scopes: ["operator.read"],
        clientVersion: "agent-connect-openclaw-plugin",
        minProtocol: PROTOCOL_VERSION,
        maxProtocol: PROTOCOL_VERSION,
        requestTimeoutMs: timeoutMs,
        hostDeps: {
          logDebug() {},
          logError() {},
          redactForLog: () => "OpenClaw gateway error",
        },
        onHelloOk: () => {
          const activeClient = client;
          if (!activeClient) {
            finish(new Error("OpenClaw gateway client was not initialized"));
            return;
          }
          void activeClient.request<T>(method, params, { timeoutMs }).then(
            (value) => finish(undefined, value),
            (error: unknown) => finish(asPrivateError(error)),
          );
        },
        onConnectError: (error) => finish(asPrivateError(error)),
        onClose: () =>
          finish(new Error("OpenClaw config.get connection closed")),
      });
      client.start();
    } catch (error) {
      finish(asPrivateError(error));
    }
  });
}

function requireAppliedRevision(snapshot: StockOpenClawConfigGet): string {
  if (snapshot.valid !== true) {
    throw new Error("OpenClaw config.get reported an invalid configuration");
  }
  if (typeof snapshot.hash !== "string" || snapshot.hash.length === 0) {
    throw new Error("OpenClaw config.get omitted its raw revision");
  }
  if (
    typeof snapshot.configRevisionHash !== "string" ||
    snapshot.configRevisionHash.length === 0 ||
    typeof snapshot.appliedConfigHash !== "string" ||
    snapshot.appliedConfigHash.length === 0
  ) {
    throw new Error(
      "OpenClaw config.get omitted its saved or applied runtime revision",
    );
  }
  if (snapshot.configRevisionHash !== snapshot.appliedConfigHash) {
    throw new Error(
      "OpenClaw saved configuration is not the revision applied by the running gateway",
    );
  }
  return snapshot.appliedConfigHash;
}

function asPrivateError(_error: unknown): Error {
  return new Error("OpenClaw gateway RPC failed");
}
