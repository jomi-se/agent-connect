import { mkdtempSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Server } from "node:http";

import { isStepCount, streamText } from "ai";
import { describe, expect, it } from "vitest";

import {
  startOpenClawTestRuntime,
  type OpenClawTestRuntime,
} from "../../../scripts/openclaw-test-runtime.mjs";
import {
  createAiSdkApplicationTools,
  createAiSdkOpenResponsesGenerationOptions,
  createAiSdkOpenResponsesModel,
  selectAiSdkOpenResponsesCheckpoint,
} from "../../web-sdk/src/ai-sdk.js";
import {
  beginOpenClawAuthorization,
  completeOpenClawAuthorization,
  discoverOpenClawProvider,
  refreshOpenClawConnection,
  revokeOpenClawConnection,
} from "../../web-sdk/src/openclaw-connection.js";
import type { ApplicationTool } from "../../web-sdk/src/types.js";
import { ConnectorAuth } from "../src/connector-auth.js";
import { verifyPublishedOpenClaw } from "../src/scoped-proxy/config.js";
import {
  DelegatedGrantService,
  type DelegatedGrantStore,
} from "../src/delegated-grants.js";
import { createScopedResponsesProxy } from "../src/scoped-proxy/server.js";
import {
  createOpenClawRuntimePolicyVerifier,
  readStockOpenClawConfig,
  readStockOpenClawRpc,
} from "../src/scoped-proxy/runtime-config.js";
import { loadStaticOpenClawPolicy } from "../src/scoped-proxy/policy.js";

const integration =
  process.env.RUN_OPENCLAW_INTEGRATION === "1" ? describe : describe.skip;
const ISSUER = "https://scoped-proxy.example";
const APP = "https://bookhand.example";
const RESOURCE = `${ISSUER}/v1/responses`;
const PASSPHRASE = "fixture owner enrollment phrase";

class MemoryStore implements DelegatedGrantStore {
  value: unknown;
  load() {
    return structuredClone(this.value);
  }
  save(value: unknown) {
    this.value = structuredClone(value);
  }
}

integration("scoped proxy with the published OpenClaw process", () => {
  it(
    "composes owner login, OAuth, two application calls, refresh, follow-up and revoke",
    { timeout: 150_000 },
    async () => {
      const executed: string[] = [];
      let runtime: OpenClawTestRuntime | undefined;
      let proxy: Server | undefined;
      let inferenceStep = 0;
      const first = applicationTool("first_action", async () => {
        executed.push("first_action");
        return "first-result-42";
      });
      const second = applicationTool("second_action", async () => {
        executed.push("second_action");
        return "second-result-84";
      });
      try {
        verifyPublishedOpenClaw(process.env.OPENCLAW_TEST_BIN as string);
        runtime = await startOpenClawTestRuntime({
          async configure(config, { directory }) {
            delete config.agents.defaults.workspace;
            delete config.agents.defaults.model;
            config.agents.defaults.skipBootstrap = true;
            config.agents.defaults.heartbeat = { every: "0m" };
            config.agents.defaults.models = {
              "fixture/fixture": { agentRuntime: { id: "openclaw" } },
            };
            config.gateway.reload = { mode: "off" };
            config.tools = {
              toolSearch: false,
              elevated: { enabled: false },
            };
            config.plugins = {
              slots: { memory: "none" },
              entries: { "memory-core": { enabled: false } },
            };
            config.agents.entries = {
              restricted: {
                workspace: join(directory, "restricted-workspace"),
                contextInjection: "never",
                model: { primary: "fixture/fixture", fallbacks: [] },
                skills: [],
                memory: { search: { enabled: false } },
                tools: { deny: ["*"] },
              },
            };
          },
          onModelRequest(body, inference) {
            expect(body.tools?.map((tool) => tool.function.name)).toEqual([
              "first_action",
              "second_action",
            ]);
            inferenceStep += 1;
            const wire = JSON.stringify(body.messages);
            if (wire.includes("FOLLOWUP")) {
              expect(wire).toContain("first-result-42");
              expect(wire).toContain("second-result-84");
              inference.text(
                "Both prior application results remain in context.",
              );
            } else if (wire.includes("second-result-84")) {
              inference.text("Both application actions completed.");
            } else if (wire.includes("first-result-42")) {
              inference.tool("second_action", {});
            } else {
              inference.tool("first_action", {});
            }
          },
        });
        expect(runtime.stockPackage).toMatchObject({
          version: "2026.9.1",
          patchedApplicationPrincipal: false,
        });
        const state = mkdtempSync(
          join(tmpdir(), "ac-scoped-stock-integration-"),
        );
        const ownerAuth = new ConnectorAuth({
          statePath: join(state, "owner.json"),
          publicEndpoint: ISSUER,
          enrollmentPassphrase: PASSPHRASE,
        });
        const policyPath = join(state, "scoped-policies.json");
        await writeFile(
          policyPath,
          JSON.stringify({
            version: 1,
            policies: [
              {
                ref: "application-tools-only",
                label: "Application tools only",
                agentId: "restricted",
                nativeCapabilities: [],
              },
            ],
          }),
          { mode: 0o600 },
        );
        const staticPolicy = loadStaticOpenClawPolicy({
          configPath: join(runtime.directory, "openclaw.json"),
          policyPath,
          upstreamToken: runtime.token,
          upstreamBaseUrl: runtime.baseUrl,
        });
        const stockConfig = await readStockOpenClawConfig({
          upstreamBaseUrl: runtime.baseUrl,
          upstreamToken: runtime.token,
        });
        expect(stockConfig).toMatchObject({
          valid: true,
          sourceConfig: {
            gateway: { auth: { token: "__OPENCLAW_REDACTED__" } },
          },
        });
        expect(stockConfig.hash).toEqual(expect.any(String));
        expect(stockConfig.configRevisionHash).toEqual(expect.any(String));
        expect(stockConfig.appliedConfigHash).toBe(
          stockConfig.configRevisionHash,
        );
        expect(stockConfig.hash).not.toBe(stockConfig.configRevisionHash);
        const runtimeVerifier = await createOpenClawRuntimePolicyVerifier({
          readConfig: () =>
            readStockOpenClawConfig({
              upstreamBaseUrl: runtime?.baseUrl as string,
              upstreamToken: runtime?.token as string,
            }),
          validateSourceConfig: (value) =>
            staticPolicy.assertRuntimeConfig(value),
        });
        const boundPolicy = staticPolicy.withRuntimeVerifier(runtimeVerifier);
        const grants = new DelegatedGrantService({
          resource: RESOURCE,
          store: new MemoryStore(),
          offeredPolicies: boundPolicy.offeredPolicies,
        });
        proxy = createScopedResponsesProxy({
          issuer: ISSUER,
          resource: RESOURCE,
          upstreamBaseUrl: runtime.baseUrl,
          upstreamToken: runtime.token,
          grantService: grants,
          ownerAuth,
          policySnapshot: boundPolicy,
          readHistory: (sessionKey) =>
            readStockOpenClawRpc(
              {
                upstreamBaseUrl: runtime?.baseUrl as string,
                upstreamToken: runtime?.token as string,
              },
              "chat.history",
              { sessionKey, limit: 200 },
            ),
        });
        const loopback = await listen(proxy);
        const applicationFetch = mappedFetch(loopback, APP);
        const transportFetch = mappedFetch(loopback);

        const provider = await discoverOpenClawProvider({
          providerUrl: ISSUER,
          experience: "https",
          fetch: applicationFetch,
        });
        const started = await beginOpenClawAuthorization({
          provider,
          redirectUri: `${APP}/oauth/callback`,
          tools: [first, second],
          fetch: applicationFetch,
        });
        const login = await transportFetch(started.authorizationUrl, {
          redirect: "manual",
        });
        expect(login.status).toBe(401);
        const challenge = hiddenValue(await login.text(), "challenge");
        const authenticated = await transportFetch(
          `${ISSUER}/agent-connect/owner/login`,
          {
            method: "POST",
            redirect: "manual",
            headers: {
              origin: ISSUER,
              "content-type": "application/x-www-form-urlencoded",
            },
            body: new URLSearchParams({ challenge, passphrase: PASSPHRASE }),
          },
        );
        expect(authenticated.status).toBe(303);
        const ownerCookie = authenticated.headers
          .get("set-cookie")
          ?.split(";", 1)[0];
        expect(ownerCookie).toMatch(/^agent_connect_owner=/);
        const consent = await transportFetch(started.authorizationUrl, {
          headers: { cookie: ownerCookie as string },
        });
        expect(consent.status).toBe(200);
        const consentHtml = await consent.text();
        const approved = await transportFetch(
          `${ISSUER}/agent-connect/oauth/authorize`,
          {
            method: "POST",
            redirect: "manual",
            headers: {
              cookie: ownerCookie as string,
              origin: ISSUER,
              "content-type": "application/x-www-form-urlencoded",
            },
            body: new URLSearchParams({
              request_uri: hiddenValue(consentHtml, "request_uri"),
              csrf_token: hiddenValue(consentHtml, "csrf_token"),
              decision: "allow",
              policy_choice: "0",
            }),
          },
        );
        expect(approved.status).toBe(303);
        let connection = await completeOpenClawAuthorization({
          provider,
          redirectUri: `${APP}/oauth/callback`,
          transaction: started.transaction,
          callbackUrl: approved.headers.get("location") as string,
          fetch: applicationFetch,
        });

        const model = () =>
          createAiSdkOpenResponsesModel({
            endpoint: connection.endpoint,
            model: connection.model,
            getAccessToken: () => connection.accessToken,
            fetch: applicationFetch,
          });
        const tools = createAiSdkApplicationTools([first, second], {
          connectionId: "stock-scoped-integration",
        });
        const initial = streamText({
          model: model(),
          instructions:
            "Use the supplied application actions to answer the user.",
          prompt: "Run both application actions in order.",
          tools,
          ...createAiSdkOpenResponsesGenerationOptions(),
          stopWhen: isStepCount(5),
        });
        await initial.consumeStream();
        const final = await initial.finalStep;
        expect(final.text).toBe("Both application actions completed.");
        expect(executed).toEqual(["first_action", "second_action"]);
        const checkpoint = selectAiSdkOpenResponsesCheckpoint(undefined, final);
        expect(checkpoint).toBeTruthy();

        connection = await refreshOpenClawConnection({
          connection,
          fetch: applicationFetch,
        });
        const recent = await applicationFetch(
          `${ISSUER}/v1/agent-connect/conversations`,
          { headers: { authorization: `Bearer ${connection.accessToken}` } },
        );
        expect(recent.status).toBe(200);
        const { conversations } = await recent.json();
        expect(conversations).toHaveLength(1);
        expect(conversations[0].canContinue).toBe(true);
        const historyResponse = await applicationFetch(
          `${ISSUER}/v1/agent-connect/conversations/${conversations[0].conversationId}/history`,
          { headers: { authorization: `Bearer ${connection.accessToken}` } },
        );
        expect(historyResponse.status).toBe(200);
        const history = await historyResponse.json();
        expect(history.projection).toBe("execution-history");
        expect(history.entries).toContainEqual({
          kind: "assistant",
          text: "Both application actions completed.",
        });
        expect(
          history.entries.some(
            (entry: { kind: string; text: string }) =>
              entry.kind === "input" && entry.text.includes("first-result-42"),
          ),
        ).toBe(true);
        expect(JSON.stringify(history)).not.toContain("sessionKey");
        expect(JSON.stringify(history)).not.toContain(
          "Use the supplied application actions",
        );
        expect(history.previousResponseId).toBe(checkpoint);
        const followup = streamText({
          model: model(),
          prompt: "FOLLOWUP: confirm both earlier results.",
          tools,
          ...createAiSdkOpenResponsesGenerationOptions(
            history.previousResponseId,
          ),
        });
        await followup.consumeStream();
        expect(await followup.text).toBe(
          "Both prior application results remain in context.",
        );
        expect(inferenceStep).toBe(4);

        await revokeOpenClawConnection({ connection, fetch: applicationFetch });
        const afterRevoke = await applicationFetch(RESOURCE, {
          method: "POST",
          headers: {
            authorization: `Bearer ${connection.accessToken}`,
            "content-type": "application/json",
          },
          body: JSON.stringify({
            model: "openclaw/default",
            input: "must not run",
            tools: [wireTool(first), wireTool(second)],
          }),
        });
        expect(afterRevoke.status).toBe(401);
        expect(inferenceStep).toBe(4);

        const configPath = join(runtime.directory, "openclaw.json");
        const changedConfig = JSON.parse(await readFile(configPath, "utf8"));
        changedConfig.agents.defaults.timeoutSeconds = 21;
        await writeFile(configPath, JSON.stringify(changedConfig, null, 2), {
          mode: 0o600,
        });
        await expect
          .poll(
            async () =>
              (
                await readStockOpenClawConfig({
                  upstreamBaseUrl: runtime?.baseUrl as string,
                  upstreamToken: runtime?.token as string,
                })
              ).configRevisionHash,
            { timeout: 5_000, interval: 100 },
          )
          .not.toBe(stockConfig.configRevisionHash);
        await expect(runtimeVerifier.assertCurrent()).rejects.toThrow(
          /not the revision applied|changed/,
        );
      } finally {
        if (proxy) await close(proxy);
        await runtime?.close();
      }
    },
  );
});

function applicationTool(
  name: string,
  execute: ApplicationTool["execute"],
): ApplicationTool {
  return {
    name,
    description: `Execute ${name}`,
    inputSchema: { type: "object", additionalProperties: false },
    execute,
  };
}

function wireTool(tool: ApplicationTool) {
  return {
    type: "function",
    name: tool.name,
    description: tool.description,
    parameters: tool.inputSchema,
  };
}

function hiddenValue(html: string, name: string): string {
  const value = html.match(new RegExp(`name="${name}" value="([^"]+)"`))?.[1];
  if (!value) throw new Error(`Missing ${name}`);
  return value;
}

function mappedFetch(
  loopback: string,
  browserOrigin?: string,
): typeof globalThis.fetch {
  return (async (input: RequestInfo | URL, init: RequestInit = {}) => {
    if (input instanceof Request) throw new Error("Unexpected Request input");
    const logical = new URL(input.toString());
    if (logical.origin !== ISSUER) throw new Error("Unexpected logical origin");
    const headers = new Headers(init.headers);
    if (browserOrigin && !headers.has("origin"))
      headers.set("origin", browserOrigin);
    return fetch(new URL(`${logical.pathname}${logical.search}`, loopback), {
      ...init,
      headers,
    });
  }) as typeof globalThis.fetch;
}

function listen(server: Server): Promise<string> {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      const address = server.address();
      if (!address || typeof address === "string")
        return reject(new Error("No address"));
      resolve(`http://127.0.0.1:${address.port}`);
    });
  });
}

function close(server: Server): Promise<void> {
  server.closeAllConnections();
  return new Promise((resolve) => server.close(() => resolve()));
}
