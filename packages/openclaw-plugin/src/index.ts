import { existsSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import { join } from "node:path";
import { stdin, stdout } from "node:process";
import { createInterface } from "node:readline/promises";
import { resolveConfiguredSecretInputString } from "openclaw/plugin-sdk/config-runtime";
import { resolveGatewayAuth } from "openclaw/plugin-sdk/gateway-runtime";

import { ConnectorAuth } from "../../gateway/src/connector-auth.js";
import { DelegatedGrantService } from "../../gateway/src/delegated-grants.js";
import { STOCK_PLUGIN_ENDPOINT_LAYOUT } from "../../gateway/src/openclaw-plugin/contracts.js";
import {
  createAgentConnectHandler,
  type AgentConnectHandler,
} from "./runtime/handler.js";
import { AgentConnectAdmissionController } from "./runtime/admission.js";
import {
  readStockOpenClawConfig,
  readStockOpenClawRpc,
} from "./runtime/runtime-config.js";
import {
  openClawHttpAuthHeaders,
  type OpenClawUpstreamAuth,
} from "./runtime/upstream-auth.js";
import {
  applySetupMutation,
  configuredEntryPoints,
  DEFAULT_AGENT_ID,
  DEFAULT_LISTEN_PORT,
  inspectSetup,
  parsePluginConfig,
  PLUGIN_ID,
  primaryEntryPoint,
  resolveSupportedRuntimes,
  setupReadiness,
  type StockPluginConfig,
} from "./config.js";
import type { StockPluginApi } from "./host-api.js";
import {
  startAgentConnectListener,
  type AgentConnectListener,
} from "./listener.js";
import { assertRuntimeCurrentUnlessAborted } from "./readiness.js";

const OWNER_STATE_FILE = "owner.json";
const GRANT_STATE_FILE = "delegated-grants.json";
const OWNER_SUBJECT = "local-owner";
const READY_TIMEOUT_MS = 15_000;

interface ActiveService {
  entries: readonly ActiveEntryPoint[];
  readiness: Promise<void>;
  stop: AbortController;
}

interface ActiveEntryPoint {
  readonly id: string;
  readonly handler: AgentConnectHandler;
  readonly listener: AgentConnectListener;
  ready: boolean;
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

    api.registerService({
      id: "agent-connect-gateway",
      async start(context) {
        startupCode = "initializing";
        const pendingEntries: ActiveEntryPoint[] = [];
        const pendingHandlers = new Set<AgentConnectHandler>();
        try {
          const pluginConfig = parsePluginConfig(api.pluginConfig);
          const statePaths = resolveStatePaths(context.stateDir);
          const runtimeConfig = api.runtime.config.current();
          const resolvedGatewayAuth =
            await resolveActiveGatewayAuth(runtimeConfig);
          if (resolvedGatewayAuth.mode === "none") {
            api.logger.warn(
              "Native OpenClaw authentication is disabled. Do not expose its native port: clients could bypass Agent Connect grants and call the authless native Responses endpoint.",
            );
          }
          if (!existsSync(statePaths.owner)) {
            throw new Error(
              'owner identity is missing; run "openclaw agent-connect setup --apply"',
            );
          }
          const gatewayAuthResolver = () => resolvedGatewayAuth;
          const initial = resolveSupportedRuntimes(
            runtimeConfig,
            pluginConfig,
            {
              stateDir: context.stateDir,
              resolveGatewayAuth: gatewayAuthResolver,
            },
          );
          const ownerAuth = new ConnectorAuth({
            statePath: statePaths.owner,
            publicEndpoint: initial[0]!.issuer,
            transportProfile: "explicit-owner-login",
          });
          const admission = new AgentConnectAdmissionController();
          const assertRuntimeCurrent = () => {
            const current = resolveSupportedRuntimes(
              api.runtime.config.current(),
              pluginConfig,
              {
                stateDir: context.stateDir,
                resolveGatewayAuth: gatewayAuthResolver,
              },
            );
            if (
              current.length !== initial.length ||
              current.some(
                (entry, index) =>
                  entry.entryPointId !== initial[index]?.entryPointId ||
                  entry.fingerprint !== initial[index]?.fingerprint,
              )
            ) {
              throw new Error(
                "relevant OpenClaw policy changed; restart and reconsent required",
              );
            }
          };
          const assertAppliedRuntimeCurrent = async () => {
            const snapshot = await readStockOpenClawConfig({
              upstreamBaseUrl: initial[0]!.upstreamBaseUrl,
              upstreamAuth: initial[0]!.upstreamAuth,
            });
            assertAppliedSourceConfig(snapshot, pluginConfig, {
              stateDir: context.stateDir,
              resolveGatewayAuth: gatewayAuthResolver,
            });
            assertRuntimeCurrent();
          };
          for (const runtime of initial) {
            const grantService = new DelegatedGrantService({
              resource: runtime.resource,
              offeredPolicies: [runtime.policy],
              statePath: grantStatePath(
                statePaths.directory,
                runtime.entryPointId,
              ),
            });
            const handler = createAgentConnectHandler({
              issuer: runtime.issuer,
              resource: runtime.resource,
              upstreamBaseUrl: runtime.upstreamBaseUrl,
              upstreamAuth: runtime.upstreamAuth,
              grantService,
              ownerAuth,
              ownerSubject: OWNER_SUBJECT,
              endpoints: STOCK_PLUGIN_ENDPOINT_LAYOUT,
              admission,
              policySnapshot: {
                assertUnchanged: assertRuntimeCurrent,
                async assertRuntimeCurrent() {
                  await assertAppliedRuntimeCurrent();
                },
              },
              readHistory: (sessionKey) =>
                readStockOpenClawRpc(
                  {
                    upstreamBaseUrl: runtime.upstreamBaseUrl,
                    upstreamAuth: runtime.upstreamAuth,
                  },
                  "chat.history",
                  { sessionKey, limit: 200 },
                ),
            });
            pendingHandlers.add(handler);
            let activeEntry: ActiveEntryPoint | undefined;
            const listener = await startAgentConnectListener({
              port: runtime.listenPort,
              endpoints: STOCK_PLUGIN_ENDPOINT_LAYOUT,
              admission,
              async dispatch(request, response) {
                if (!activeEntry?.ready) {
                  sendUnavailable(response, startupCode);
                  return;
                }
                await activeEntry.handler.handle(request, response);
              },
              onError(error) {
                startupCode = "listener_failed";
                if (activeEntry) activeEntry.ready = false;
                context.serviceHealth?.reportFailure(error);
                api.logger.error(error.message);
              },
            });
            activeEntry = {
              id: runtime.entryPointId,
              handler,
              listener,
              ready: false,
            };
            pendingEntries.push(activeEntry);
            pendingHandlers.delete(handler);
            api.logger.info(
              `Agent Connect entry point ${runtime.entryPointId} is available at http://${listener.host}:${listener.port} for ${runtime.publicOrigin}; do not forward the native OpenClaw port`,
            );
          }
          const stop = new AbortController();
          const active: ActiveService = {
            entries: [...pendingEntries],
            stop,
            readiness: Promise.resolve(),
          };
          service = active;
          active.readiness = waitForNativeResponses(
            initial[0]!.upstreamBaseUrl,
            initial[0]!.upstreamAuth,
            stop.signal,
          )
            .then(() =>
              assertRuntimeCurrentUnlessAborted(
                stop.signal,
                assertAppliedRuntimeCurrent,
              ),
            )
            .then(
              () => {
                if (service === active && !stop.signal.aborted) {
                  for (const entry of active.entries) entry.ready = true;
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
          await Promise.all([
            ...pendingEntries.flatMap((entry) => [
              entry.listener.close(),
              entry.handler.close(),
            ]),
            ...[...pendingHandlers].map((handler) => handler.close()),
          ]);
          startupCode = "unsupported_configuration";
          context.serviceHealth?.reportFailure(error);
          api.logger.error(
            error instanceof Error
              ? error.message
              : "Agent Connect listener startup failed",
          );
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
        await Promise.all(
          active.entries.flatMap((entry) => [
            entry.listener.close(),
            entry.handler.close(),
          ]),
        );
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
        .option("--agent-id <id>", "restricted agent id")
        .option("--listen-port <port>", "loopback application listener port")
        .option("--model <provider/model>", "restricted agent model")
        .action(async (options) => runDoctor(api, options));
      root
        .command("setup")
        .description("Guide setup on a terminal, or preview/apply explicitly")
        .option("--origin <url>", "public HTTPS gateway origin")
        .option("--agent-id <id>", "restricted agent id")
        .option("--listen-port <port>", "loopback application listener port")
        .option("--model <provider/model>", "restricted agent model")
        .option("--apply", "persist the reviewed setup")
        .option("--json", "print machine-readable output")
        .option("--non-interactive", "never prompt")
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
  const runtimeConfig = api.runtime.config.current();
  const config = requestedConfig(api, options, runtimeConfig);
  const resolvedGatewayAuth = await resolveActiveGatewayAuth(runtimeConfig);
  const inspection = inspectSetup(runtimeConfig, config, {
    stateDir,
    resolveGatewayAuth: () => resolvedGatewayAuth,
  });
  const ownerReady = existsSync(resolveStatePaths(stateDir).owner);
  const configuration = setupReadiness(inspection, ownerReady);
  const entryPoints = configuredEntryPoints(config);
  const live = configuration.ok
    ? await Promise.all(
        entryPoints.map((entryPoint) =>
          probeLocalListener(entryPoint.listenPort),
        ),
      )
    : entryPoints.map(() => ({
        listener: "not_checked" as const,
        nativeUpstream: "not_checked" as const,
      }));
  const ok =
    configuration.ok && live.every((entry) => entry.nativeUpstream === "ready");
  const status = configuration.ok
    ? live.some((entry) => entry.listener === "unavailable")
      ? "listener_unavailable"
      : live.every((entry) => entry.nativeUpstream === "ready")
        ? "ready"
        : "native_upstream_unavailable"
    : configuration.status;
  const primary = primaryEntryPoint(config);
  process.stdout.write(
    `${JSON.stringify(
      {
        ok,
        status,
        publicOrigin: primary.publicOrigin,
        issuer: `${primary.publicOrigin}/agent-connect`,
        resource: `${primary.publicOrigin}/agent-connect/v1/responses`,
        agentId: config.agentId,
        listenPort: primary.listenPort,
        localForwardTarget: `http://127.0.0.1:${primary.listenPort}`,
        listener: live[0]?.listener,
        nativeUpstream: live[0]?.nativeUpstream,
        ...("entryPoints" in config
          ? {
              entryPoints: entryPoints.map((entryPoint, index) => ({
                ...entryPoint,
                issuer: `${entryPoint.publicOrigin}/agent-connect`,
                resource: `${entryPoint.publicOrigin}/agent-connect/v1/responses`,
                localForwardTarget: `http://127.0.0.1:${entryPoint.listenPort}`,
                listener: live[index]?.listener,
                nativeUpstream: live[index]?.nativeUpstream,
              })),
            }
          : {}),
        publicIngress: "not_checked",
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
  if (!ok) process.exitCode = 2;
}

async function runSetup(
  api: StockPluginApi,
  options: Record<string, unknown>,
): Promise<void> {
  const stateDir = api.runtime.state.resolveStateDir();
  const runtimeConfig = api.runtime.config.current();
  const guided = shouldGuideSetup(options);
  let config: StockPluginConfig;
  try {
    config = guided
      ? await promptForRequestedConfig(api, options, runtimeConfig)
      : requestedConfig(api, options, runtimeConfig);
  } catch (error) {
    writeSetupInputError(error, guided);
    return;
  }
  const resolvedGatewayAuth = await resolveActiveGatewayAuth(runtimeConfig);
  const gatewayAuthResolver = () => resolvedGatewayAuth;
  const inspection = inspectSetup(runtimeConfig, config, {
    stateDir,
    resolveGatewayAuth: gatewayAuthResolver,
  });
  if (!inspection.supported) {
    writeSetupInspection(
      {
        applied: false,
        status: "unsupported_host",
        preview: inspection.changes,
        errors: inspection.errors,
        warnings: inspection.warnings,
      },
      guided,
    );
    process.exitCode = 2;
    return;
  }
  const ownerReady = existsSync(resolveStatePaths(stateDir).owner);
  if (guided && inspection.changes.length === 0 && ownerReady) {
    const origins = configuredEntryPoints(config)
      .map((entryPoint) => entryPoint.publicOrigin)
      .join(", ");
    stdout.write(
      `Agent Connect is already configured for ${origins}.\nRun "openclaw agent-connect doctor" to verify live readiness.\n`,
    );
    return;
  }
  let apply = options.apply === true;
  if (guided) {
    writeGuidedSummary(config, inspection, ownerReady);
    apply = await confirmSetup();
    if (!apply) {
      stdout.write(
        "Cancelled. No configuration or owner identity was changed.\n",
      );
      return;
    }
  }
  if (!apply) {
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
  if (inspection.changes.length > 0) {
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
  } else {
    const latestRuntimeConfig = api.runtime.config.current();
    const latestGatewayAuth =
      await resolveActiveGatewayAuth(latestRuntimeConfig);
    const latestInspection = inspectSetup(latestRuntimeConfig, config, {
      stateDir,
      resolveGatewayAuth: () => latestGatewayAuth,
    });
    if (!latestInspection.supported || latestInspection.changes.length > 0) {
      writeSetupInspection(
        {
          applied: false,
          status: "configuration_changed",
          preview: latestInspection.changes,
          errors: [
            ...latestInspection.errors,
            "OpenClaw configuration changed during setup; rerun setup from the new state",
          ],
          warnings: latestInspection.warnings,
        },
        guided,
      );
      process.exitCode = 2;
      return;
    }
  }
  const paths = resolveStatePaths(stateDir);
  await mkdir(paths.directory, { recursive: true, mode: 0o700 });
  await mkdir(paths.workspace, { recursive: true, mode: 0o700 });
  let enrollmentPassphrase: string | undefined;
  const primary = primaryEntryPoint(config);
  if (!existsSync(paths.owner)) {
    new ConnectorAuth({
      statePath: paths.owner,
      publicEndpoint: `${primary.publicOrigin}/agent-connect`,
      transportProfile: "explicit-owner-login",
      onEnrollmentBundle(bundle) {
        enrollmentPassphrase = bundle.enrollmentPassphrase;
      },
    });
  }
  const result = {
    applied: true,
    changed: inspection.changes,
    warnings: inspection.warnings,
    provider: `${primary.publicOrigin}/agent-connect`,
    localForwardTarget: `http://127.0.0.1:${primary.listenPort}`,
    ...("entryPoints" in config
      ? {
          entryPoints: configuredEntryPoints(config).map((entryPoint) => ({
            ...entryPoint,
            provider: `${entryPoint.publicOrigin}/agent-connect`,
            localForwardTarget: `http://127.0.0.1:${entryPoint.listenPort}`,
          })),
        }
      : {}),
    forwardingWarning:
      "Forward the Agent Connect application port, never the native OpenClaw port.",
    enrollmentPassphrase:
      enrollmentPassphrase ??
      "unchanged; use the passphrase shown by the first successful setup",
    next: lifecycleNextStep(),
  };
  if (!guided) {
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    return;
  }
  stdout.write("\nAgent Connect configuration applied.\n");
  if (enrollmentPassphrase) {
    stdout.write(
      `\nSave this one-time owner enrollment passphrase now:\n\n${enrollmentPassphrase}\n`,
    );
  }
  for (const entryPoint of configuredEntryPoints(config)) {
    stdout.write(
      `\nEntry point ${entryPoint.id}: ${entryPoint.publicOrigin}/agent-connect\n`,
    );
    stdout.write(
      `Local forwarding target: http://127.0.0.1:${entryPoint.listenPort}\n`,
    );
  }
  stdout.write("Do not forward the native OpenClaw port to applications.\n");
  stdout.write(`\nNext: ${lifecycleNextStep()}.\n`);
}

function lifecycleNextStep(): string {
  if (
    process.env.OPENCLAW_HOME ||
    process.env.OPENCLAW_STATE_DIR ||
    process.env.OPENCLAW_CONFIG_PATH
  ) {
    return 'restart the existing external supervisor, or run "openclaw gateway run" in the foreground, then run "openclaw agent-connect doctor"';
  }
  return 'restart the shared host with "openclaw gateway restart", then run "openclaw agent-connect doctor"';
}

function requestedConfig(
  api: StockPluginApi,
  options: Record<string, unknown>,
  runtimeConfig: Readonly<Record<string, unknown>>,
): StockPluginConfig {
  const existing = (() => {
    try {
      return parsePluginConfig(api.pluginConfig);
    } catch {
      return undefined;
    }
  })();
  if (existing && "entryPoints" in existing) {
    if (options.origin !== undefined || options.listenPort !== undefined) {
      throw new Error(
        "--origin and --listen-port cannot modify a multiple-entry-point configuration",
      );
    }
    return parsePluginConfig({
      entryPoints: existing.entryPoints,
      agentId: options.agentId ?? existing.agentId,
      model: options.model ?? existing.model,
    });
  }
  return parsePluginConfig({
    publicOrigin: options.origin ?? existing?.publicOrigin,
    agentId: options.agentId ?? existing?.agentId ?? DEFAULT_AGENT_ID,
    listenPort:
      requestedListenPort(options.listenPort) ??
      existing?.listenPort ??
      DEFAULT_LISTEN_PORT,
    model:
      options.model ??
      existing?.model ??
      (existing ? undefined : configuredDefaultModel(runtimeConfig)),
  });
}

function shouldGuideSetup(options: Record<string, unknown>): boolean {
  return (
    stdin.isTTY === true &&
    stdout.isTTY === true &&
    options.origin === undefined &&
    options.apply !== true &&
    options.json !== true &&
    options.nonInteractive !== true
  );
}

async function promptForRequestedConfig(
  api: StockPluginApi,
  options: Record<string, unknown>,
  runtimeConfig: Readonly<Record<string, unknown>>,
): Promise<StockPluginConfig> {
  const existing = (() => {
    try {
      return parsePluginConfig(api.pluginConfig);
    } catch {
      return undefined;
    }
  })();
  if (existing) {
    if ("entryPoints" in existing) {
      return parsePluginConfig({
        entryPoints: existing.entryPoints,
        agentId: options.agentId ?? existing.agentId,
        model: options.model ?? existing.model,
      });
    }
    return parsePluginConfig({
      publicOrigin: existing.publicOrigin,
      agentId: options.agentId ?? existing.agentId,
      listenPort:
        requestedListenPort(options.listenPort) ?? existing.listenPort,
      model: options.model ?? existing.model,
    });
  }
  const prompt = createInterface({ input: stdin, output: stdout });
  try {
    stdout.write(
      "Agent Connect adds a restricted, application-tools-only profile to this OpenClaw host.\n",
    );
    const publicOrigin = await questionWithDefault(
      prompt,
      "Public HTTPS origin",
      undefined,
    );
    const model = await questionWithDefault(
      prompt,
      "Model for delegated application requests (provider/model)",
      configuredDefaultModel(runtimeConfig),
    );
    const listenPort = requestedListenPort(
      await questionWithDefault(
        prompt,
        "Application access port (distinct from the native OpenClaw port)",
        String(DEFAULT_LISTEN_PORT),
      ),
    );
    return parsePluginConfig({
      publicOrigin,
      agentId: options.agentId ?? DEFAULT_AGENT_ID,
      listenPort,
      model,
    });
  } finally {
    prompt.close();
  }
}

async function questionWithDefault(
  prompt: ReturnType<typeof createInterface>,
  label: string,
  defaultValue?: string,
): Promise<string> {
  const answer = (
    await prompt.question(
      `${label}${defaultValue ? ` [${defaultValue}]` : ""}: `,
    )
  ).trim();
  return answer || defaultValue || "";
}

async function confirmSetup(): Promise<boolean> {
  const prompt = createInterface({ input: stdin, output: stdout });
  try {
    const answer = (await prompt.question("Apply these changes? [y/N]: "))
      .trim()
      .toLowerCase();
    return answer === "y" || answer === "yes";
  } finally {
    prompt.close();
  }
}

function configuredDefaultModel(
  config: Readonly<Record<string, unknown>>,
): string | undefined {
  const model = record(record(config.agents)?.defaults)?.model;
  if (typeof model === "string") return model;
  const primary = record(model)?.primary;
  return typeof primary === "string" ? primary : undefined;
}

function writeGuidedSummary(
  config: StockPluginConfig,
  inspection: ReturnType<typeof inspectSetup>,
  ownerReady: boolean,
): void {
  stdout.write("\nProposed Agent Connect setup:\n");
  for (const entryPoint of configuredEntryPoints(config)) {
    stdout.write(
      `  Entry point ${entryPoint.id}: ${entryPoint.publicOrigin}/agent-connect\n`,
    );
    stdout.write(
      `  Local application listener: http://127.0.0.1:${entryPoint.listenPort}\n`,
    );
  }
  stdout.write("  Do not forward the native OpenClaw port to applications.\n");
  stdout.write(`  Restricted agent: ${config.agentId}\n`);
  stdout.write(`  Model: ${config.model ?? "current OpenClaw default"}\n`);
  stdout.write("  Native tools, memory, skills and workspace access: denied\n");
  for (const change of inspection.changes)
    stdout.write(`  Change: ${change}\n`);
  if (!ownerReady)
    stdout.write("  Change: create the one-time owner identity\n");
  for (const warning of inspection.warnings)
    stdout.write(`  Warning: ${warning}\n`);
  stdout.write("  Each application still requires separate OAuth consent.\n\n");
}

function writeSetupInputError(error: unknown, guided: boolean): void {
  const message =
    error instanceof Error ? error.message : "invalid setup input";
  if (guided) {
    process.stderr.write(`Setup could not continue: ${message}\n`);
  } else {
    stdout.write(
      `${JSON.stringify({ applied: false, status: "input_required", errors: [message] }, null, 2)}\n`,
    );
  }
  process.exitCode = 2;
}

function writeSetupInspection(
  value: {
    readonly applied: false;
    readonly status: string;
    readonly preview: readonly string[];
    readonly errors: readonly string[];
    readonly warnings: readonly string[];
  },
  guided: boolean,
): void {
  if (!guided) {
    stdout.write(`${JSON.stringify(value, null, 2)}\n`);
    return;
  }
  process.stderr.write("Agent Connect cannot be configured on this host:\n");
  for (const error of value.errors) process.stderr.write(`  - ${error}\n`);
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

function grantStatePath(directory: string, entryPointId: string): string {
  return entryPointId === "default"
    ? join(directory, GRANT_STATE_FILE)
    : join(directory, `delegated-grants.${entryPointId}.json`);
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

function requestedListenPort(value: unknown): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || !/^\d+$/.test(value)) {
    throw new Error("listenPort must be an integer from 1 through 65535");
  }
  const port = Number(value);
  if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) {
    throw new Error("listenPort must be an integer from 1 through 65535");
  }
  return port;
}

async function probeLocalListener(listenPort: number): Promise<{
  readonly listener: "available" | "unavailable";
  readonly nativeUpstream: "ready" | "unavailable";
}> {
  try {
    const response = await fetch(
      `http://127.0.0.1:${listenPort}${STOCK_PLUGIN_ENDPOINT_LAYOUT.healthPath}`,
      { signal: AbortSignal.timeout(1_500) },
    );
    const body = await response.text();
    if (response.status === 200) {
      return { listener: "available", nativeUpstream: "ready" };
    }
    if (
      response.status === 503 &&
      body.includes("Agent Connect is unavailable")
    ) {
      return { listener: "available", nativeUpstream: "unavailable" };
    }
  } catch {
    // A refused/timeout probe means the configured listener is not live.
  }
  return { listener: "unavailable", nativeUpstream: "unavailable" };
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
