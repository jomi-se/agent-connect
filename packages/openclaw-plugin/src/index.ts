import { existsSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import { join } from "node:path";
import { resolveConfiguredSecretInputString } from "openclaw/plugin-sdk/config-runtime";
import { resolveGatewayAuth } from "openclaw/plugin-sdk/gateway-runtime";

import { ConnectorAuth } from "../../gateway/src/connector-auth.js";
import { DelegatedGrantService } from "../../gateway/src/delegated-grants.js";
import { STOCK_PLUGIN_ENDPOINT_LAYOUT } from "../../gateway/src/openclaw-plugin/contracts.js";
import {
  createScopedResponsesHandler,
  type ScopedResponsesHandler,
} from "../../gateway/src/scoped-proxy/server.js";
import {
  readStockOpenClawConfig,
  readStockOpenClawRpc,
} from "../../gateway/src/scoped-proxy/runtime-config.js";
import {
  openClawHttpAuthHeaders,
  type OpenClawUpstreamAuth,
} from "../../gateway/src/scoped-proxy/upstream-auth.js";
import {
  applySetupMutation,
  DEFAULT_AGENT_ID,
  inspectSetup,
  parsePluginConfig,
  PLUGIN_ID,
  resolveSupportedRuntime,
  setupReadiness,
  type StockPluginConfig,
} from "./config.js";
import type { StockPluginApi } from "./host-api.js";

const OWNER_STATE_FILE = "owner.json";
const GRANT_STATE_FILE = "delegated-grants.json";
const OWNER_SUBJECT = "local-owner";
const READY_TIMEOUT_MS = 15_000;

interface ActiveService {
  handler: ScopedResponsesHandler;
  ready: boolean;
  readiness: Promise<void>;
  stop: AbortController;
}

export default {
  id: PLUGIN_ID,
  name: "Agent Connect",
  description: "Application-scoped delegation hosted by stock OpenClaw",
  register(api: StockPluginApi): void {
    registerCli(api);
    if (api.registrationMode !== "full") return;

    let service: ActiveService | undefined;
    let startupCode = "not_configured";

    const dispatch = async (
      request: IncomingMessage,
      response: ServerResponse,
    ): Promise<void> => {
      if (!service?.ready) {
        sendUnavailable(response, startupCode);
        return;
      }
      await service.handler.handle(request, response);
    };

    api.registerHttpRoute({
      path: STOCK_PLUGIN_ENDPOINT_LAYOUT.authorizationServerMetadataPath,
      auth: "plugin",
      match: "exact",
      handler: dispatch,
    });
    api.registerHttpRoute({
      path: STOCK_PLUGIN_ENDPOINT_LAYOUT.protectedResourceMetadataPath,
      auth: "plugin",
      match: "exact",
      handler: dispatch,
    });
    api.registerHttpRoute({
      path: "/agent-connect/",
      auth: "plugin",
      match: "prefix",
      handler: dispatch,
    });

    api.registerService({
      id: "agent-connect-gateway",
      async start(context) {
        startupCode = "initializing";
        try {
          const pluginConfig = parsePluginConfig(api.pluginConfig);
          const statePaths = resolveStatePaths(context.stateDir);
          if (!existsSync(statePaths.owner)) {
            throw new Error(
              'owner identity is missing; run "openclaw agent-connect setup --apply"',
            );
          }
          const runtimeConfig = api.runtime.config.current();
          const resolvedGatewayAuth =
            await resolveActiveGatewayAuth(runtimeConfig);
          const gatewayAuthResolver = () => resolvedGatewayAuth;
          const initial = resolveSupportedRuntime(runtimeConfig, pluginConfig, {
            stateDir: context.stateDir,
            resolveGatewayAuth: gatewayAuthResolver,
          });
          const ownerAuth = new ConnectorAuth({
            statePath: statePaths.owner,
            publicEndpoint: initial.issuer,
            transportProfile: "explicit-owner-login",
          });
          const grantService = new DelegatedGrantService({
            resource: initial.resource,
            offeredPolicies: [initial.policy],
            statePath: statePaths.grants,
          });
          const assertRuntimeCurrent = () => {
            const current = resolveSupportedRuntime(
              api.runtime.config.current(),
              pluginConfig,
              {
                stateDir: context.stateDir,
                resolveGatewayAuth: gatewayAuthResolver,
              },
            );
            if (current.fingerprint !== initial.fingerprint) {
              throw new Error(
                "relevant OpenClaw policy changed; restart and reconsent required",
              );
            }
          };
          const assertAppliedRuntimeCurrent = async () => {
            const snapshot = await readStockOpenClawConfig({
              upstreamBaseUrl: initial.upstreamBaseUrl,
              upstreamAuth: initial.upstreamAuth,
            });
            assertAppliedSourceConfig(snapshot, pluginConfig, {
              stateDir: context.stateDir,
              resolveGatewayAuth: gatewayAuthResolver,
            });
            assertRuntimeCurrent();
          };
          const handler = createScopedResponsesHandler({
            issuer: initial.issuer,
            resource: initial.resource,
            upstreamBaseUrl: initial.upstreamBaseUrl,
            upstreamAuth: initial.upstreamAuth,
            grantService,
            ownerAuth,
            ownerSubject: OWNER_SUBJECT,
            endpoints: STOCK_PLUGIN_ENDPOINT_LAYOUT,
            policySnapshot: {
              assertUnchanged: assertRuntimeCurrent,
              async assertRuntimeCurrent() {
                await assertAppliedRuntimeCurrent();
              },
            },
            readHistory: (sessionKey) =>
              readStockOpenClawRpc(
                {
                  upstreamBaseUrl: initial.upstreamBaseUrl,
                  upstreamAuth: initial.upstreamAuth,
                },
                "chat.history",
                { sessionKey, limit: 200 },
              ),
          });
          const stop = new AbortController();
          const active: ActiveService = {
            handler,
            ready: false,
            stop,
            readiness: Promise.resolve(),
          };
          service = active;
          active.readiness = waitForNativeResponses(
            initial.upstreamBaseUrl,
            initial.upstreamAuth,
            stop.signal,
          )
            .then(assertAppliedRuntimeCurrent)
            .then(
              () => {
                if (service === active && !stop.signal.aborted) {
                  active.ready = true;
                  startupCode = "ready";
                  context.serviceHealth?.clearFailure();
                }
              },
              (error: unknown) => {
                if (stop.signal.aborted) return;
                startupCode = "native_responses_unavailable";
                context.serviceHealth?.reportFailure(error);
                api.logger.error(
                  "Agent Connect native Responses readiness failed; run openclaw agent-connect doctor",
                );
              },
            );
        } catch (error) {
          startupCode = "unsupported_configuration";
          context.serviceHealth?.reportFailure(error);
          api.logger.warn(
            "Agent Connect is installed but unavailable; run openclaw agent-connect doctor",
          );
        }
      },
      async stop() {
        const active = service;
        service = undefined;
        startupCode = "stopped";
        if (!active) return;
        active.stop.abort();
        await active.handler.close();
        await active.readiness;
      },
    });
  },
};

function registerCli(api: StockPluginApi): void {
  api.registerCli(
    ({ program }) => {
      const root = program
        .command("agent-connect")
        .description("Inspect and configure the Agent Connect plugin");
      root
        .command("doctor")
        .description("Inspect compatibility without changing configuration")
        .option("--origin <url>", "public HTTPS gateway origin")
        .option("--agent-id <id>", "restricted agent id", DEFAULT_AGENT_ID)
        .action(async (options) => runDoctor(api, options));
      root
        .command("setup")
        .description("Preview setup; pass --apply to persist it")
        .option("--origin <url>", "public HTTPS gateway origin")
        .option("--agent-id <id>", "restricted agent id", DEFAULT_AGENT_ID)
        .option("--apply", "persist the reviewed setup")
        .action(async (options) => runSetup(api, options));
    },
    {
      descriptors: [
        {
          name: "agent-connect",
          description: "Inspect and configure Agent Connect",
          hasSubcommands: true,
        },
      ],
    },
  );
}

async function runDoctor(
  api: StockPluginApi,
  options: Record<string, unknown>,
): Promise<void> {
  const stateDir = api.runtime.state.resolveStateDir();
  const config = requestedConfig(api, options);
  const runtimeConfig = api.runtime.config.current();
  const resolvedGatewayAuth = await resolveActiveGatewayAuth(runtimeConfig);
  const inspection = inspectSetup(runtimeConfig, config, {
    stateDir,
    resolveGatewayAuth: () => resolvedGatewayAuth,
  });
  const ownerReady = existsSync(resolveStatePaths(stateDir).owner);
  const readiness = setupReadiness(inspection, ownerReady);
  process.stdout.write(
    `${JSON.stringify(
      {
        ok: readiness.ok,
        status: readiness.status,
        publicOrigin: config.publicOrigin,
        issuer: `${config.publicOrigin}/agent-connect`,
        resource: `${config.publicOrigin}/agent-connect/v1/responses`,
        agentId: config.agentId,
        ownerIdentity: ownerReady ? "initialized" : "missing",
        changes: inspection.changes,
        errors: inspection.errors,
        warnings: inspection.warnings,
        trustedOperatorRace:
          "config is rechecked before dispatch but the following internal HTTP admission is not atomic",
      },
      null,
      2,
    )}\n`,
  );
  if (!readiness.ok) process.exitCode = 2;
}

async function runSetup(
  api: StockPluginApi,
  options: Record<string, unknown>,
): Promise<void> {
  const stateDir = api.runtime.state.resolveStateDir();
  const config = requestedConfig(api, options);
  const runtimeConfig = api.runtime.config.current();
  const resolvedGatewayAuth = await resolveActiveGatewayAuth(runtimeConfig);
  const gatewayAuthResolver = () => resolvedGatewayAuth;
  const inspection = inspectSetup(runtimeConfig, config, {
    stateDir,
    resolveGatewayAuth: gatewayAuthResolver,
  });
  if (!inspection.supported) {
    process.stdout.write(
      `${JSON.stringify(
        {
          applied: false,
          status: "unsupported_host",
          preview: inspection.changes,
          errors: inspection.errors,
          warnings: inspection.warnings,
        },
        null,
        2,
      )}\n`,
    );
    process.exitCode = 2;
    return;
  }
  if (options.apply !== true) {
    process.stdout.write(
      `${JSON.stringify(
        {
          applied: false,
          status:
            inspection.changes.length > 0
              ? "changes_planned"
              : "configuration_ready",
          preview: inspection.changes,
          warnings: inspection.warnings,
          note: "No configuration was changed. Re-run with --apply after review.",
        },
        null,
        2,
      )}\n`,
    );
    return;
  }
  await api.runtime.config.mutateConfigFile({
    afterWrite: {
      mode: "none",
      reason:
        "Agent Connect setup requires an explicit reviewed gateway restart",
    },
    mutate(draft) {
      applySetupMutation(draft, config, stateDir, gatewayAuthResolver);
    },
  });
  const paths = resolveStatePaths(stateDir);
  await mkdir(paths.directory, { recursive: true, mode: 0o700 });
  await mkdir(paths.workspace, { recursive: true, mode: 0o700 });
  let enrollmentPassphrase: string | undefined;
  if (!existsSync(paths.owner)) {
    new ConnectorAuth({
      statePath: paths.owner,
      publicEndpoint: `${config.publicOrigin}/agent-connect`,
      transportProfile: "explicit-owner-login",
      onEnrollmentBundle(bundle) {
        enrollmentPassphrase = bundle.enrollmentPassphrase;
      },
    });
  }
  process.stdout.write(
    `${JSON.stringify(
      {
        applied: true,
        changed: inspection.changes,
        warnings: inspection.warnings,
        enrollmentPassphrase:
          enrollmentPassphrase ??
          "unchanged; use the passphrase shown by the first successful setup",
        next: "restart the OpenClaw gateway, then run openclaw agent-connect doctor",
      },
      null,
      2,
    )}\n`,
  );
}

function requestedConfig(
  api: StockPluginApi,
  options: Record<string, unknown>,
): StockPluginConfig {
  const existing = (() => {
    try {
      return parsePluginConfig(api.pluginConfig);
    } catch {
      return undefined;
    }
  })();
  return parsePluginConfig({
    publicOrigin: options.origin ?? existing?.publicOrigin,
    agentId: options.agentId ?? existing?.agentId ?? DEFAULT_AGENT_ID,
  });
}

async function resolveActiveGatewayAuth(
  config: Readonly<Record<string, unknown>>,
): Promise<ReturnType<typeof resolveGatewayAuth>> {
  const authConfig = record(record(config.gateway)?.auth) ?? null;
  let resolved: ReturnType<typeof resolveGatewayAuth>;
  try {
    resolved = resolveGatewayAuth({ authConfig });
  } catch {
    return { mode: "unresolved" };
  }
  if (resolved.mode !== "token" && resolved.mode !== "password") {
    return resolved;
  }
  if (resolved[resolved.mode]) return resolved;

  const secret = await resolveConfiguredSecretInputString({
    config: config as Record<string, unknown>,
    env: process.env,
    value: authConfig?.[resolved.mode],
    path: `gateway.auth.${resolved.mode}`,
    unresolvedReasonStyle: "generic",
  }).catch((): { readonly value?: string } => ({}));
  if (!secret.value) return resolved;
  return { ...resolved, [resolved.mode]: secret.value };
}

function resolveStatePaths(stateDir: string) {
  const directory = join(stateDir, "agent-connect");
  return {
    directory,
    workspace: join(directory, "workspace"),
    owner: join(directory, OWNER_STATE_FILE),
    grants: join(directory, GRANT_STATE_FILE),
  };
}

async function waitForNativeResponses(
  baseUrl: string,
  auth: OpenClawUpstreamAuth,
  stopped: AbortSignal,
): Promise<void> {
  const deadline = Date.now() + READY_TIMEOUT_MS;
  while (!stopped.aborted && Date.now() < deadline) {
    try {
      const response = await fetch(`${baseUrl}/v1/responses`, {
        method: "GET",
        headers: openClawHttpAuthHeaders(auth),
        signal: AbortSignal.any([stopped, AbortSignal.timeout(1_000)]),
      });
      const contentType = response.headers.get("content-type") ?? "";
      await response.body?.cancel();
      if (response.status === 405 && contentType.startsWith("text/plain"))
        return;
    } catch {
      // The gateway listener and native Responses route start after services.
    }
    await delay(250, stopped);
  }
  if (stopped.aborted) return;
  throw new Error("native Responses route did not become ready in time");
}

async function delay(milliseconds: number, signal: AbortSignal): Promise<void> {
  await new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, milliseconds);
    signal.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        resolve();
      },
      { once: true },
    );
  });
}

function sendUnavailable(response: ServerResponse, code: string): void {
  const body = Buffer.from(
    JSON.stringify({
      error: {
        type: "server_error",
        code,
        message:
          "Agent Connect is unavailable; the owner must run setup/doctor.",
      },
    }),
  );
  response.writeHead(503, {
    "cache-control": "no-store",
    "content-type": "application/json; charset=utf-8",
    "content-length": String(body.length),
  });
  response.end(body);
}

function assertAppliedSourceConfig(
  snapshot: {
    readonly valid?: unknown;
    readonly sourceConfig?: unknown;
    readonly configRevisionHash?: unknown;
    readonly appliedConfigHash?: unknown;
  },
  pluginConfig: StockPluginConfig,
  options: {
    readonly stateDir: string;
    readonly resolveGatewayAuth: () => ReturnType<typeof resolveGatewayAuth>;
  },
): void {
  if (
    snapshot.valid !== true ||
    typeof snapshot.configRevisionHash !== "string" ||
    snapshot.configRevisionHash.length === 0 ||
    snapshot.configRevisionHash !== snapshot.appliedConfigHash
  ) {
    throw new Error(
      "OpenClaw saved configuration is not the valid applied runtime revision",
    );
  }
  const source = record(snapshot.sourceConfig);
  const inspection = inspectSetup(source, pluginConfig, options);
  if (!inspection.supported || inspection.changes.length > 0) {
    throw new Error(
      "applied source configuration is outside the supported matrix",
    );
  }
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}
