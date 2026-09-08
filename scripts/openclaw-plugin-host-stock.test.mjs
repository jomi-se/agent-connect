import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import test from "node:test";

import {
  beginOpenClawAuthorization,
  completeOpenClawAuthorization,
  createOpenClawConversationClient,
  discoverOpenClawProvider,
  refreshOpenClawConnection,
  revokeOpenClawConnection,
} from "../packages/web-sdk/dist/index.js";
import { startOpenClawTestRuntime } from "./openclaw-test-runtime.mjs";

const pluginPackage = JSON.parse(
  await readFile(
    new URL("../packages/openclaw-plugin/package.json", import.meta.url),
    "utf8",
  ),
);
const defaultArtifactName = `${pluginPackage.name
  .replace(/^@/, "")
  .replace("/", "-")}-${pluginPackage.version}.tgz`;
const artifact = process.env.AGENT_CONNECT_PLUGIN_TARBALL
  ? resolve(process.env.AGENT_CONNECT_PLUGIN_TARBALL)
  : new URL(`../dist/${defaultArtifactName}`, import.meta.url).pathname;
const publicOrigin = "https://gateway.example";
const issuer = `${publicOrigin}/agent-connect`;
const resource = `${issuer}/v1/responses`;
const appOrigin = "https://books.example";
const redirectUri = `${appOrigin}/oauth/callback`;
const tools = [
  wireTool("lookup_book", "Look up a book"),
  wireTool("quote_book", "Quote a book"),
];

test(
  "packed stock plugin composes OAuth, bounded tools, lifecycle, and native Responses",
  { timeout: 180_000 },
  async () => {
    let setupOutput;
    let doctorBeforeSetup;
    let doctorAfterSetup;
    const runtime = await startOpenClawTestRuntime({
      configure(config, { directory }) {
        config.agents.entries = {
          personal: {
            name: "Personal agent",
            workspace: join(directory, "personal-workspace"),
          },
        };
        config.channels = {};
        config.memory = { search: { enabled: true } };
      },
      prepare({ binary, env, directory }) {
        execFileSync(
          binary,
          [
            "plugins",
            "install",
            `npm-pack:${artifact}`,
            "--force",
            "--accept-capabilities",
          ],
          { cwd: directory, env, encoding: "utf8", timeout: 120_000 },
        );
        const before = spawnSync(
          binary,
          ["agent-connect", "doctor", "--origin", publicOrigin],
          { cwd: directory, env, encoding: "utf8", timeout: 120_000 },
        );
        doctorBeforeSetup = {
          status: before.status,
          output: JSON.parse(before.stdout),
        };
        setupOutput = JSON.parse(
          execFileSync(
            binary,
            ["agent-connect", "setup", "--origin", publicOrigin, "--apply"],
            { cwd: directory, env, encoding: "utf8", timeout: 120_000 },
          ),
        );
        const after = spawnSync(binary, ["agent-connect", "doctor"], {
          cwd: directory,
          env,
          encoding: "utf8",
          timeout: 120_000,
        });
        doctorAfterSetup = {
          status: after.status,
          output: JSON.parse(after.stdout),
        };
      },
      onModelRequest(body, model) {
        const transcript = JSON.stringify(body.messages ?? []);
        const names = (body.tools ?? []).map((entry) => entry.function.name);
        if (transcript.includes("Native operator request")) {
          model.text("Native operator endpoint still works.");
          return;
        }

        assert.deepEqual(names.sort(), ["lookup_book", "quote_book"]);
        if (transcript.includes("Wait until disabled")) {
          model.hang("Waiting for lifecycle shutdown.");
        } else if (transcript.includes("What happened next")) {
          model.text("Follow-up stayed in the same conversation.");
        } else if (transcript.includes("A Square spoke.")) {
          model.text("Both application results were received.");
        } else if (transcript.includes("Flatland record")) {
          model.tool("quote_book", { title: "Flatland" }, "call_quote");
        } else {
          model.tool("lookup_book", { title: "Flatland" }, "call_lookup");
        }
      },
    });

    try {
      assert.equal(setupOutput.applied, true);
      assert.deepEqual(doctorBeforeSetup, {
        status: 2,
        output: {
          ok: false,
          status: "setup_required",
          publicOrigin,
          issuer,
          resource,
          agentId: "agent-connect-app",
          ownerIdentity: "missing",
          changes: [
            "add restricted agent agent-connect-app",
            "set plugins.entries.agent-connect.config",
          ],
          errors: [],
          warnings: [],
          trustedOperatorRace:
            "config is rechecked before dispatch but the following internal HTTP admission is not atomic",
        },
      });
      assert.equal(doctorAfterSetup.status, 0);
      assert.equal(doctorAfterSetup.output.ok, true);
      assert.equal(doctorAfterSetup.output.status, "ready");
      assert.match(setupOutput.enrollmentPassphrase, /^AC-ENROLL-/);
      const sourceConfig = JSON.parse(
        await readFile(join(runtime.directory, "openclaw.json"), "utf8"),
      );
      assert.equal(sourceConfig.agents.entries.personal.name, "Personal agent");
      assert.deepEqual(sourceConfig.memory, { search: { enabled: true } });
      assert.deepEqual(sourceConfig.channels, {});
      assert.equal(
        sourceConfig.agents.entries["agent-connect-app"].tools.deny[0],
        "*",
      );

      await waitForStatus(runtime.baseUrl, "/agent-connect/healthz", 200);
      const metadata = await getJson(
        runtime.baseUrl,
        "/.well-known/oauth-authorization-server/agent-connect",
      );
      assert.equal(metadata.issuer, issuer);
      assert.equal(
        metadata.token_endpoint,
        `${publicOrigin}/agent-connect/oauth/token`,
      );
      const protectedMetadata = await getJson(
        runtime.baseUrl,
        "/.well-known/oauth-protected-resource/agent-connect/v1/responses",
      );
      assert.equal(protectedMetadata.resource, resource);
      assert.deepEqual(protectedMetadata.authorization_servers, [issuer]);

      const credential = await authorize(
        runtime,
        setupOutput.enrollmentPassphrase,
      );
      assert.equal(credential.endpoint, resource);
      const direct = await fetch(`${runtime.baseUrl}/v1/responses`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${credential.accessToken}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({ model: "openclaw", input: "blocked" }),
      });
      assert.equal(direct.status, 401);

      const escaped = await appPost(runtime, credential.accessToken, {
        model: "openclaw/default",
        input: "escape",
        tools: [...tools, wireTool("unapproved", "Unapproved")],
        stream: true,
      });
      assert.equal(escaped.status, 400);
      assert.equal(runtime.modelRequests.length, 0);
      const routed = await appPost(
        runtime,
        credential.accessToken,
        { model: "openclaw/default", input: "escape", tools, stream: true },
        { "x-openclaw-agent-id": "personal" },
      );
      assert.equal(routed.status, 400);
      assert.equal(runtime.modelRequests.length, 0);

      const first = terminal(
        await appEvents(runtime, credential.accessToken, {
          model: "openclaw/default",
          input: "Look up Flatland",
          tools,
          stream: true,
        }),
      );
      const lookup = functionCall(first, "lookup_book");
      const second = terminal(
        await appEvents(runtime, credential.accessToken, {
          model: "openclaw/default",
          previous_response_id: first.id,
          input: [
            {
              type: "function_call_output",
              call_id: lookup.call_id,
              output: "Flatland record",
            },
          ],
          tools,
          stream: true,
        }),
      );
      const quote = functionCall(second, "quote_book");
      const third = terminal(
        await appEvents(runtime, credential.accessToken, {
          model: "openclaw/default",
          previous_response_id: second.id,
          input: [
            {
              type: "function_call_output",
              call_id: quote.call_id,
              output: "A Square spoke.",
            },
          ],
          tools,
          stream: true,
        }),
      );
      const refreshed = await refreshOpenClawConnection({
        connection: credential,
        fetch: sdkFetch(runtime),
      });
      assert.notEqual(refreshed.accessToken, credential.accessToken);
      assert.equal(
        (
          await appPost(runtime, credential.accessToken, {
            model: "openclaw/default",
            input: "old token",
            tools,
            stream: true,
          })
        ).status,
        401,
      );
      const followUp = terminal(
        await appEvents(runtime, refreshed.accessToken, {
          model: "openclaw/default",
          previous_response_id: third.id,
          input: "What happened next?",
          tools,
          stream: true,
        }),
      );
      const conversations = createOpenClawConversationClient({
        connection: refreshed,
        getAccessToken: async () => refreshed.accessToken,
        fetch: appSdkFetch(runtime),
      });
      const listed = await conversations.list();
      assert.equal(listed.length, 1);
      const history = await conversations.history(listed[0].conversationId);
      assert.match(JSON.stringify(history), /Follow-up/);

      const hangingResponse = await appPost(runtime, refreshed.accessToken, {
        model: "openclaw/default",
        input: "Wait until disabled",
        tools,
        stream: true,
      });
      assert.equal(hangingResponse.status, 200);
      const hangingBody = hangingResponse.text().catch(() => undefined);
      await waitFor(() => runtime.modelRequests.length === 5);
      execFileSync(runtime.binary, ["plugins", "disable", "agent-connect"], {
        cwd: runtime.directory,
        env: runtime.env,
        encoding: "utf8",
        timeout: 30_000,
      });
      await waitFor(() => runtime.modelRequests[4]?.closed === true);
      await hangingBody;
      execFileSync(
        runtime.binary,
        ["plugins", "enable", "agent-connect", "--accept-capabilities"],
        {
          cwd: runtime.directory,
          env: runtime.env,
          encoding: "utf8",
          timeout: 30_000,
        },
      );
      await waitForStatus(runtime.baseUrl, "/agent-connect/healthz", 200);
      const stale = await appPost(runtime, refreshed.accessToken, {
        model: "openclaw/default",
        previous_response_id: followUp.id,
        input: "Do not replay",
        tools,
        stream: true,
      });
      assert.ok([400, 404].includes(stale.status));
      assert.equal(runtime.modelRequests.length, 5);

      execFileSync(
        runtime.binary,
        [
          "config",
          "set",
          "agents.entries.agent-connect-app.skills",
          '["unsafe-skill"]',
          "--strict-json",
        ],
        {
          cwd: runtime.directory,
          env: runtime.env,
          encoding: "utf8",
          timeout: 30_000,
        },
      );
      await waitForStatus(runtime.baseUrl, "/agent-connect/healthz", 503);
      assert.equal(runtime.modelRequests.length, 5);

      execFileSync(
        runtime.binary,
        [
          "config",
          "set",
          "agents.entries.agent-connect-app.skills",
          "[]",
          "--strict-json",
        ],
        {
          cwd: runtime.directory,
          env: runtime.env,
          encoding: "utf8",
          timeout: 30_000,
        },
      );
      await waitForStatus(runtime.baseUrl, "/agent-connect/healthz", 200);

      const native = await runtime.request(
        {
          input: "Native operator request",
          stream: true,
        },
        {
          agentId: "personal",
          sessionKey: "agent:personal:openresponses:native-coexistence",
        },
      );
      assert.equal(native.status, 200);
      assert.match(await native.text(), /Native operator endpoint still works/);

      await revokeOpenClawConnection({
        connection: refreshed,
        fetch: sdkFetch(runtime),
      });
      const revoked = await appPost(runtime, refreshed.accessToken, {
        model: "openclaw/default",
        input: "revoked",
        tools,
        stream: true,
      });
      assert.notEqual(revoked.status, 200);
    } finally {
      await runtime.close();
    }
  },
);

for (const authCase of [
  { mode: "none", config: { mode: "none" }, warns: true },
  {
    mode: "password",
    config: {
      mode: "password",
      password: {
        source: "env",
        provider: "default",
        id: "OPENCLAW_GATEWAY_PASSWORD",
      },
    },
    env: { OPENCLAW_GATEWAY_PASSWORD: "fixture-password" },
    warns: false,
  },
]) {
  test(
    `packed stock plugin uses ${authCase.mode} upstream while retaining app grants`,
    { timeout: 180_000 },
    async () => {
      let setupOutput;
      const runtime = await startOpenClawTestRuntime({
        configure(config) {
          config.gateway.auth = authCase.config;
        },
        prepare({ binary, env, directory }) {
          Object.assign(env, authCase.env ?? {});
          execFileSync(
            binary,
            [
              "plugins",
              "install",
              `npm-pack:${artifact}`,
              "--force",
              "--accept-capabilities",
            ],
            { cwd: directory, env, encoding: "utf8", timeout: 120_000 },
          );
          setupOutput = JSON.parse(
            execFileSync(
              binary,
              ["agent-connect", "setup", "--origin", publicOrigin, "--apply"],
              { cwd: directory, env, encoding: "utf8", timeout: 120_000 },
            ),
          );
        },
        onModelRequest(_body, model) {
          model.text(`Explicit ${authCase.mode} upstream completed.`);
        },
      });

      try {
        assert.equal(setupOutput.applied, true);
        if (authCase.warns) {
          assert.match(
            setupOutput.warnings.join(" "),
            /native endpoints outside \/agent-connect are not protected/,
          );
        } else {
          assert.deepEqual(setupOutput.warnings, []);
        }
        await waitForStatus(runtime.baseUrl, "/agent-connect/healthz", 200);

        const unauthenticatedApp = await fetch(
          `${runtime.baseUrl}/agent-connect/v1/responses`,
          {
            method: "POST",
            headers: {
              origin: appOrigin,
              "content-type": "application/json",
            },
            body: JSON.stringify({
              model: "openclaw/default",
              input: "App auth remains mandatory",
              tools,
              stream: true,
            }),
          },
        );
        assert.equal(unauthenticatedApp.status, 401);
        assert.equal(runtime.modelRequests.length, 0);

        const credential = await authorize(
          runtime,
          setupOutput.enrollmentPassphrase,
        );
        const completed = terminal(
          await appEvents(runtime, credential.accessToken, {
            model: "openclaw/default",
            input: `Use the explicit ${authCase.mode} internal path`,
            tools,
            stream: true,
          }),
        );
        assert.equal(completed.status, "completed");

        const conversations = createOpenClawConversationClient({
          connection: credential,
          getAccessToken: async () => credential.accessToken,
          fetch: appSdkFetch(runtime),
        });
        const listed = await conversations.list();
        const history = await conversations.history(listed[0].conversationId);
        assert.match(
          JSON.stringify(history),
          new RegExp(`Explicit ${authCase.mode} upstream completed`),
        );
      } finally {
        await runtime.close();
      }
    },
  );
}

test(
  "unsupported host setup neither mutates configuration nor mints owner identity",
  { timeout: 180_000 },
  async () => {
    let checked = false;
    await assert.rejects(
      startOpenClawTestRuntime({
        configure(config) {
          config.gateway.tls = { enabled: true };
        },
        async prepare({ binary, env, directory }) {
          execFileSync(
            binary,
            [
              "plugins",
              "install",
              `npm-pack:${artifact}`,
              "--force",
              "--accept-capabilities",
            ],
            { cwd: directory, env, encoding: "utf8", timeout: 120_000 },
          );
          const configPath = join(directory, "openclaw.json");
          const before = await readFile(configPath, "utf8");
          const setup = spawnSync(
            binary,
            ["agent-connect", "setup", "--origin", publicOrigin, "--apply"],
            { cwd: directory, env, encoding: "utf8", timeout: 120_000 },
          );
          assert.equal(setup.status, 2);
          assert.match(setup.stdout, /gateway\.tls\.enabled must not be true/);
          assert.equal(await readFile(configPath, "utf8"), before);
          assert.equal(
            existsSync(join(directory, "state", "agent-connect", "owner.json")),
            false,
          );
          checked = true;
          throw new Error("unsupported setup fixture complete");
        },
      }),
      /unsupported setup fixture complete/,
    );
    assert.equal(checked, true);
  },
);

async function authorize(runtime, enrollmentPassphrase) {
  const bridgeFetch = sdkFetch(runtime);
  const provider = await discoverOpenClawProvider({
    providerUrl: issuer,
    experience: "https",
    fetch: bridgeFetch,
  });
  const started = await beginOpenClawAuthorization({
    provider,
    redirectUri,
    tools: tools.map((tool) => ({
      name: tool.name,
      description: tool.description,
      inputSchema: tool.parameters,
      execute: async () => "unused fixture",
    })),
    fetch: bridgeFetch,
  });
  const requestUri = started.transaction.requestUri;
  const authorizePath = `${new URL(started.authorizationUrl).pathname}${new URL(started.authorizationUrl).search}`;
  const login = await fetch(`${runtime.baseUrl}${authorizePath}`);
  assert.equal(login.status, 401);
  const challengeToken = hidden(await login.text(), "challenge");
  const owner = await fetch(`${runtime.baseUrl}/agent-connect/owner/login`, {
    method: "POST",
    redirect: "manual",
    headers: {
      origin: publicOrigin,
      "content-type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({
      challenge: challengeToken,
      passphrase: enrollmentPassphrase,
    }),
  });
  assert.equal(owner.status, 303);
  const cookie = owner.headers.get("set-cookie").split(";", 1)[0];
  const consent = await fetch(`${runtime.baseUrl}${authorizePath}`, {
    headers: { cookie },
  });
  assert.equal(consent.status, 200);
  const consentHtml = await consent.text();
  const decided = await fetch(
    `${runtime.baseUrl}/agent-connect/oauth/authorize`,
    {
      method: "POST",
      redirect: "manual",
      headers: {
        cookie,
        origin: publicOrigin,
        "content-type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({
        request_uri: requestUri,
        csrf_token: hidden(consentHtml, "csrf_token"),
        decision: "allow",
        policy_choice: "0",
      }),
    },
  );
  assert.equal(decided.status, 303);
  return completeOpenClawAuthorization({
    provider,
    redirectUri,
    transaction: started.transaction,
    callbackUrl: decided.headers.get("location"),
    fetch: bridgeFetch,
  });
}

function sdkFetch(runtime) {
  return (input, init) => {
    const url = new URL(String(input));
    assert.equal(url.origin, publicOrigin);
    return fetch(`${runtime.baseUrl}${url.pathname}${url.search}`, init);
  };
}

function appSdkFetch(runtime) {
  const bridgeFetch = sdkFetch(runtime);
  return (input, init) => {
    const headers = new Headers(init?.headers);
    headers.set("origin", appOrigin);
    return bridgeFetch(input, { ...init, headers });
  };
}

async function appPost(runtime, token, body, extraHeaders = {}) {
  return fetch(`${runtime.baseUrl}/agent-connect/v1/responses`, {
    method: "POST",
    headers: {
      origin: appOrigin,
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
      ...extraHeaders,
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(45_000),
  });
}

async function appEvents(runtime, token, body) {
  const response = await appPost(runtime, token, body);
  const text = await response.text();
  assert.equal(response.status, 200, text);
  return text
    .split("\n")
    .filter((line) => line.startsWith("data: ") && !line.includes("[DONE]"))
    .map((line) => JSON.parse(line.slice(6)));
}

function terminal(events) {
  const event = events.find(
    (candidate) => candidate.type === "response.completed",
  );
  assert.ok(event, "response.completed event missing");
  return event.response;
}

function functionCall(response, name) {
  const call = response.output.find(
    (candidate) =>
      candidate.type === "function_call" && candidate.name === name,
  );
  assert.ok(call, `${name} call missing`);
  return call;
}

function wireTool(name, description) {
  return {
    type: "function",
    name,
    description,
    parameters: {
      type: "object",
      properties: { title: { type: "string" } },
      required: ["title"],
      additionalProperties: false,
    },
  };
}

function hidden(html, name) {
  const match = html.match(new RegExp(`name="${name}" value="([^"]+)"`));
  assert.ok(match, `${name} hidden input missing`);
  return match[1];
}

async function getJson(baseUrl, path) {
  const response = await fetch(`${baseUrl}${path}`);
  await assertStatus(response, 200);
  return response.json();
}

async function assertStatus(response, expected) {
  assert.equal(response.status, expected, await response.clone().text());
}

async function waitForStatus(baseUrl, path, expected) {
  await waitFor(async () => {
    try {
      return (await fetch(`${baseUrl}${path}`)).status === expected;
    } catch {
      return false;
    }
  });
}

async function waitFor(predicate, timeoutMs = 20_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  assert.fail("condition did not become true before timeout");
}
