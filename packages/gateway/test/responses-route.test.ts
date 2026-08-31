import { mkdtempSync, rmSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { createGateway } from "../src/gateway.js";
import type { BackendEvent } from "../src/responses/backend.js";
import type { AgentRuntime } from "../src/runtime.js";
import { FakeBackend, type FakeTurn } from "./support/fake-backend.js";
import {
  streamingEventSchemaName,
  validateAgainstSchema,
} from "./support/openapi-schema.js";

const servers: ReturnType<typeof createGateway>[] = [];
const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    servers
      .splice(0)
      .map(
        (server) =>
          new Promise<void>((resolve, reject) =>
            server.close((error) => (error ? reject(error) : resolve())),
          ),
      ),
  );
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

const APP_ORIGIN = "https://preview.example";
const MODEL = "agent-connect/default";

function tool() {
  return {
    name: "set_page_message",
    description: "Set one visible page message",
    inputSchema: {
      type: "object",
      properties: { message: { type: "string" } },
      required: ["message"],
      additionalProperties: false,
    },
  };
}

const wireTools = [
  {
    type: "function",
    name: tool().name,
    description: tool().description,
    parameters: tool().inputSchema,
  },
];

class FakeRuntime implements AgentRuntime {
  createdSessions = 0;
  healthy = true;

  async createSession(): Promise<string> {
    this.createdSessions += 1;
    return `provider-${this.createdSessions}`;
  }

  async isHealthy(): Promise<boolean> {
    return this.healthy;
  }
}

interface Harness {
  readonly baseUrl: string;
  readonly backend: FakeBackend;
  readonly capability: string;
  readonly grant: string;
  readonly sessionId: string;
  readonly directory: string;
  readonly runtime: FakeRuntime;
}

async function start(
  turns: readonly FakeTurn[],
  options: {
    readonly nonBrowserClients?: boolean;
    readonly runs?: readonly (readonly FakeTurn[])[];
  } = {},
): Promise<Harness> {
  const directory = mkdtempSync(join(tmpdir(), "agent-connect-responses-"));
  temporaryDirectories.push(directory);
  const backend = new FakeBackend({
    turns,
    ...(options.runs ? { runs: options.runs } : {}),
  });
  const runtime = new FakeRuntime();
  const server = createGateway({
    allowedOrigins: new Set([APP_ORIGIN]),
    allowedTailscaleUsers: new Set(["owner@example.com"]),
    omnigentBaseUrl: "http://127.0.0.1:6767",
    authStatePath: join(directory, "gateway.json"),
    publicEndpoint: "https://runtime.example",
    enrollmentPassphrase: "test enrollment phrase",
    runtime,
    responseBackend: backend,
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const grant = await authorize(baseUrl, options.nonBrowserClients === true);
  const session = await fetch(`${baseUrl}/v1/app-sessions`, {
    method: "POST",
    headers: browserHeaders({
      Authorization: `Bearer ${grant}`,
      "Content-Type": "application/json",
    }),
    body: JSON.stringify({ appId: "test-app", tools: [tool()] }),
  });
  expect(session.status).toBe(201);
  const body = (await session.json()) as {
    accessToken: string;
    sessionId: string;
  };
  return {
    baseUrl,
    backend,
    capability: body.accessToken,
    grant,
    sessionId: body.sessionId,
    directory,
    runtime,
  };
}

/**
 * Restarts a gateway over the same state directories. The new server shares no
 * process memory with the old one, so anything it can still answer came from
 * durable state.
 */
async function restart(harness: Harness): Promise<string> {
  await new Promise<void>((resolve, reject) =>
    servers
      .splice(servers.length - 1, 1)[0]
      ?.close((error) => (error ? reject(error) : resolve())),
  );
  const server = createGateway({
    allowedOrigins: new Set([APP_ORIGIN]),
    allowedTailscaleUsers: new Set(["owner@example.com"]),
    omnigentBaseUrl: "http://127.0.0.1:6767",
    authStatePath: join(harness.directory, "gateway.json"),
    publicEndpoint: "https://runtime.example",
    enrollmentPassphrase: "test enrollment phrase",
    runtime: new FakeRuntime(),
    responseBackend: new FakeBackend({ turns: [] }),
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

function browserHeaders(
  extra: Readonly<Record<string, string>> = {},
): Record<string, string> {
  return {
    Origin: APP_ORIGIN,
    "Tailscale-User-Login": "owner@example.com",
    ...extra,
  };
}

async function authorize(
  baseUrl: string,
  nonBrowserClients: boolean,
): Promise<string> {
  const codeVerifier = "v".repeat(43);
  const challenge = Buffer.from(
    await crypto.subtle.digest(
      "SHA-256",
      new TextEncoder().encode(codeVerifier),
    ),
  ).toString("base64url");
  const pushed = await fetch(`${baseUrl}/v1/authorization-requests`, {
    method: "POST",
    headers: browserHeaders({ "Content-Type": "application/json" }),
    body: JSON.stringify({
      appId: "test-app",
      redirectUri: `${APP_ORIGIN}/oauth/callback`,
      state: "state_state_state_state",
      codeChallenge: challenge,
      scopes: ["agent:prompt", "agent:result", "tools:invoke"],
      tools: [tool()],
    }),
  });
  expect(pushed.status).toBe(201);
  const { requestId } = (await pushed.json()) as { requestId: string };
  const approval = await fetch(`${baseUrl}/authorize`, {
    method: "POST",
    redirect: "manual",
    headers: {
      "Tailscale-User-Login": "owner@example.com",
      Origin: "https://runtime.example",
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({
      request: requestId,
      decision: "approve",
      passphrase: "test enrollment phrase",
      ...(nonBrowserClients ? { non_browser_clients: "yes" } : {}),
    }),
  });
  expect(approval.status).toBe(303);
  const code =
    new URL(approval.headers.get("location") ?? "").searchParams.get("code") ??
    "";
  const token = await fetch(`${baseUrl}/oauth/token`, {
    method: "POST",
    headers: browserHeaders({ "Content-Type": "application/json" }),
    body: JSON.stringify({
      code,
      codeVerifier,
      appId: "test-app",
      redirectUri: `${APP_ORIGIN}/oauth/callback`,
    }),
  });
  expect(token.status).toBe(200);
  return ((await token.json()) as { accessToken: string }).accessToken;
}

function post(
  harness: Harness,
  body: Record<string, unknown>,
  headers: Readonly<Record<string, string>> = {},
): Promise<Response> {
  return fetch(`${harness.baseUrl}/v1/responses`, {
    method: "POST",
    headers: browserHeaders({
      Authorization: `Bearer ${harness.capability}`,
      "Content-Type": "application/json",
      ...headers,
    }),
    body: JSON.stringify(body),
  });
}

const call = (token: string, args = '{"message":"hi"}'): BackendEvent => ({
  type: "tool.call",
  providerToken: token,
  name: "set_page_message",
  arguments: args,
});

interface ResponseBody {
  readonly id: string;
  readonly status: string;
  readonly output: readonly {
    readonly type: string;
    readonly call_id?: string;
    readonly content?: readonly { readonly text: string }[];
  }[];
}

function callIdOf(body: ResponseBody): string {
  const item = body.output.at(-1);
  expect(item?.type).toBe("function_call");
  return item?.call_id ?? "";
}

describe("POST /v1/responses", () => {
  it("provisions a fresh application and provider session under the existing grant", async () => {
    const harness = await start([[{ type: "completed" }]]);
    const created = await fetch(`${harness.baseUrl}/v1/app-sessions`, {
      method: "POST",
      headers: browserHeaders({
        Authorization: `Bearer ${harness.grant}`,
        "Content-Type": "application/json",
      }),
      body: JSON.stringify({ appId: "test-app", tools: [tool()], fresh: true }),
    });
    expect(created.status).toBe(201);
    const body = (await created.json()) as {
      sessionId: string;
      accessToken: string;
    };
    expect(body.sessionId).not.toBe(harness.sessionId);
    expect(harness.runtime.createdSessions).toBe(2);
    expect(
      await post(harness, { model: MODEL, input: "use the replaced session" }),
    ).toMatchObject({ status: 401 });
    const freshTask = await post(
      harness,
      { model: MODEL, input: "use the fresh session" },
      { Authorization: `Bearer ${body.accessToken}` },
    );
    expect(freshTask.status).toBe(200);
  });

  it("keeps a replaced opaque session retired after gateway restart", async () => {
    const harness = await start([], {
      runs: [[[{ type: "completed" }]], [[{ type: "completed" }]]],
    });
    const oldResponse = (await (
      await post(harness, { model: MODEL, input: "old conversation" })
    ).json()) as ResponseBody;
    const created = await fetch(`${harness.baseUrl}/v1/app-sessions`, {
      method: "POST",
      headers: browserHeaders({
        Authorization: `Bearer ${harness.grant}`,
        "Content-Type": "application/json",
      }),
      body: JSON.stringify({ appId: "test-app", tools: [tool()], fresh: true }),
    });
    const fresh = (await created.json()) as { accessToken: string };
    const freshResponse = (await (
      await post(
        harness,
        { model: MODEL, input: "fresh conversation" },
        { Authorization: `Bearer ${fresh.accessToken}` },
      )
    ).json()) as ResponseBody;

    const baseUrl = await restart(harness);
    const oldStatus = await fetch(
      `${baseUrl}/v1/agent-connect/responses/${oldResponse.id}`,
      {
        headers: browserHeaders({
          Authorization: `Bearer ${harness.capability}`,
        }),
      },
    );
    expect(oldStatus.status).toBe(401);

    const freshStatus = await fetch(
      `${baseUrl}/v1/agent-connect/responses/${freshResponse.id}`,
      {
        headers: browserHeaders({
          Authorization: `Bearer ${fresh.accessToken}`,
        }),
      },
    );
    expect(freshStatus.status).toBe(200);
  });

  it("retires a reconstructed session when fresh is requested after restart", async () => {
    const harness = await start([[{ type: "completed" }]]);
    const oldResponse = (await (
      await post(harness, { model: MODEL, input: "before restart" })
    ).json()) as ResponseBody;
    const baseUrl = await restart(harness);

    const created = await fetch(`${baseUrl}/v1/app-sessions`, {
      method: "POST",
      headers: browserHeaders({
        Authorization: `Bearer ${harness.grant}`,
        "Content-Type": "application/json",
      }),
      body: JSON.stringify({ appId: "test-app", tools: [tool()], fresh: true }),
    });
    expect(created.status).toBe(201);
    const fresh = (await created.json()) as { accessToken: string };

    const oldStatus = await fetch(
      `${baseUrl}/v1/agent-connect/responses/${oldResponse.id}`,
      {
        headers: browserHeaders({
          Authorization: `Bearer ${harness.capability}`,
        }),
      },
    );
    expect(oldStatus.status).toBe(401);

    const refreshed = await fetch(`${baseUrl}/v1/app-sessions`, {
      method: "POST",
      headers: browserHeaders({
        Authorization: `Bearer ${fresh.accessToken}`,
        "Content-Type": "application/json",
      }),
      body: JSON.stringify({ appId: "test-app", tools: [tool()] }),
    });
    expect(refreshed.status).toBe(201);
  });

  it("bounds fresh-session provisioning under one grant and application", async () => {
    const harness = await start([[{ type: "completed" }]]);
    for (let index = 0; index < 7; index += 1) {
      const created = await fetch(`${harness.baseUrl}/v1/app-sessions`, {
        method: "POST",
        headers: browserHeaders({
          Authorization: `Bearer ${harness.grant}`,
          "Content-Type": "application/json",
        }),
        body: JSON.stringify({
          appId: "test-app",
          tools: [tool()],
          fresh: true,
        }),
      });
      expect(created.status).toBe(201);
    }
    const refused = await fetch(`${harness.baseUrl}/v1/app-sessions`, {
      method: "POST",
      headers: browserHeaders({
        Authorization: `Bearer ${harness.grant}`,
        "Content-Type": "application/json",
      }),
      body: JSON.stringify({ appId: "test-app", tools: [tool()], fresh: true }),
    });
    expect(refused.status).toBe(400);
    expect(harness.runtime.createdSessions).toBe(8);
  });

  it("does not replace a session while its task is live", async () => {
    const harness = await start([[call("provider_a")]]);
    expect(
      await post(harness, { model: MODEL, input: "start work" }),
    ).toMatchObject({ status: 200 });
    const refused = await fetch(`${harness.baseUrl}/v1/app-sessions`, {
      method: "POST",
      headers: browserHeaders({
        Authorization: `Bearer ${harness.grant}`,
        "Content-Type": "application/json",
      }),
      body: JSON.stringify({ appId: "test-app", tools: [tool()], fresh: true }),
    });
    expect(refused.status).toBe(400);
    expect(harness.runtime.createdSessions).toBe(1);
  });

  it("accepts a text follow-up in both JSON and streaming response modes", async () => {
    const harness = await start([], {
      runs: [
        [[{ type: "text.delta", delta: "draft" }, { type: "completed" }]],
        [[{ type: "text.delta", delta: "revised" }, { type: "completed" }]],
      ],
    });
    const first = await post(harness, {
      model: MODEL,
      input: "write a draft",
    });
    expect(first.status).toBe(200);
    const firstBody = (await first.json()) as ResponseBody;

    const second = await post(harness, {
      model: MODEL,
      previous_response_id: firstBody.id,
      input: "make it shorter",
      stream: true,
    });
    expect(second.status).toBe(200);
    const raw = await second.text();
    expect(raw).toContain('"previous_response_id":"' + firstBody.id + '"');
    expect(raw).toContain("revised");
    expect(raw.endsWith("data: [DONE]\n\n")).toBe(true);
    expect(harness.backend.runs).toHaveLength(2);
  });

  it("returns the declared errors for unlinked, unknown, and stale turns", async () => {
    const harness = await start([], {
      runs: [[[{ type: "completed" }]], [[{ type: "completed" }]]],
    });
    const first = (await (
      await post(harness, { model: MODEL, input: "first" })
    ).json()) as ResponseBody;

    const unlinked = await post(harness, { model: MODEL, input: "second" });
    expect(unlinked.status).toBe(400);
    expect(await unlinked.json()).toMatchObject({
      error: { code: "invalid_request", param: "previous_response_id" },
    });

    const unknown = await post(harness, {
      model: MODEL,
      previous_response_id: "resp_unknown",
      input: "continue",
    });
    expect(unknown.status).toBe(404);
    expect(await unknown.json()).toMatchObject({
      error: {
        code: "previous_response_not_found",
        param: "previous_response_id",
      },
    });

    const second = await post(harness, {
      model: MODEL,
      previous_response_id: first.id,
      input: "continue",
    });
    expect(second.status).toBe(200);
    const stale = await post(harness, {
      model: MODEL,
      previous_response_id: first.id,
      input: "branch",
    });
    expect(stale.status).toBe(409);
    expect(await stale.json()).toMatchObject({
      error: {
        code: "previous_response_not_continuable",
        param: "previous_response_id",
      },
    });
  });

  it("fails continuation explicitly after an idle provider session is repaired", async () => {
    const harness = await start([[{ type: "completed" }]]);
    const first = (await (
      await post(harness, { model: MODEL, input: "first" })
    ).json()) as ResponseBody;
    harness.runtime.healthy = false;
    const refreshed = await fetch(`${harness.baseUrl}/v1/app-sessions`, {
      method: "POST",
      headers: browserHeaders({
        Authorization: `Bearer ${harness.capability}`,
        "Content-Type": "application/json",
      }),
      body: JSON.stringify({ appId: "test-app", tools: [tool()] }),
    });
    expect(refreshed.status).toBe(201);
    const renewed = (await refreshed.json()) as { accessToken: string };
    expect(harness.runtime.createdSessions).toBe(2);

    const continued = await post(
      harness,
      {
        model: MODEL,
        previous_response_id: first.id,
        input: "continue",
      },
      { Authorization: `Bearer ${renewed.accessToken}` },
    );
    expect(continued.status).toBe(409);
    expect(await continued.json()).toMatchObject({
      error: {
        code: "previous_response_not_continuable",
        param: "previous_response_id",
      },
    });
  });

  it("completes a two-call chain for an ordinary JSON client", async () => {
    const harness = await start([
      [{ type: "text.delta", delta: "on it" }, call("provider_a")],
      [call("provider_b")],
      [{ type: "text.delta", delta: "done" }, { type: "completed" }],
    ]);

    const first = await post(harness, {
      model: MODEL,
      input: "update the page",
      tools: wireTools,
    });
    expect(first.status).toBe(200);
    const firstBody = (await first.json()) as ResponseBody;
    expect(validateAgainstSchema("ResponseResource", firstBody)).toEqual([]);
    expect(firstBody.status).toBe("completed");

    const second = await post(harness, {
      model: MODEL,
      previous_response_id: firstBody.id,
      input: [
        {
          type: "function_call_output",
          call_id: callIdOf(firstBody),
          output: '{"ok":true}',
        },
      ],
    });
    const secondBody = (await second.json()) as ResponseBody;

    const third = await post(harness, {
      model: MODEL,
      previous_response_id: secondBody.id,
      input: [
        {
          type: "function_call_output",
          call_id: callIdOf(secondBody),
          output: '{"ok":true}',
        },
      ],
    });
    const thirdBody = (await third.json()) as ResponseBody;
    expect(thirdBody.status).toBe("completed");
    expect(thirdBody.output.at(-1)?.content?.[0]?.text).toBe("done");
    // One retained harness run served all three public segments.
    expect(harness.backend.runs).toHaveLength(1);
  });

  it("streams standard SSE frames terminated by [DONE]", async () => {
    const harness = await start([
      [{ type: "text.delta", delta: "hello" }, { type: "completed" }],
    ]);
    const streamed = await post(harness, {
      model: MODEL,
      input: "hi",
      stream: true,
    });
    expect(streamed.status).toBe(200);
    expect(streamed.headers.get("content-type")).toBe("text/event-stream");
    const raw = await streamed.text();
    expect(raw.endsWith("data: [DONE]\n\n")).toBe(true);

    const frames = raw
      .split("\n\n")
      .filter((frame) => frame.trim() && !frame.includes("[DONE]"));
    const types: string[] = [];
    for (const frame of frames) {
      const [eventLine, dataLine] = frame.split("\n");
      const parsed = JSON.parse(dataLine?.slice("data: ".length) ?? "{}");
      // VAL-RESP-002: `event:` equals the JSON `type`.
      expect(eventLine).toBe(`event: ${parsed.type}`);
      expect(
        validateAgainstSchema(streamingEventSchemaName(parsed.type), parsed),
      ).toEqual([]);
      types.push(parsed.type);
    }
    expect(types.at(0)).toBe("response.created");
    expect(types.at(-1)).toBe("response.completed");
  });

  it("returns a produced failed response resource as HTTP 200", async () => {
    const harness = await start([
      [{ type: "failed", message: "provider rejected the run" }],
    ]);
    const response = await post(harness, {
      model: MODEL,
      input: "hi",
      stream: false,
    });
    const body = (await response.json()) as {
      status: string;
      error: { code: string } | null;
    };

    // Open Responses distinguishes a produced failed resource from an API
    // request that failed before a response resource could be created.
    expect(response.status).toBe(200);
    expect(body.status).toBe("failed");
    expect(body.error?.code).toBe("backend_protocol_error");
  });

  it("rejects an unsupported field with the standard error envelope", async () => {
    const harness = await start([[{ type: "completed" }]]);
    const failed = await post(harness, {
      model: MODEL,
      input: "hi",
      temperature: 0.2,
    });
    expect(failed.status).toBe(400);
    expect(await failed.json()).toEqual({
      error: {
        type: "invalid_request_error",
        code: "unsupported_feature",
        message: expect.any(String),
        param: "temperature",
      },
    });
  });

  it("rejects tools that differ from the approved snapshot", async () => {
    const harness = await start([[{ type: "completed" }]]);
    const failed = await post(harness, {
      model: MODEL,
      input: "hi",
      tools: [{ ...wireTools[0], description: "Something else" }],
    });
    expect(failed.status).toBe(403);
    expect(
      ((await failed.json()) as { error: { code: string } }).error.code,
    ).toBe("tool_snapshot_mismatch");
  });

  it("refuses a request with no session capability", async () => {
    const harness = await start([[{ type: "completed" }]]);
    const failed = await fetch(`${harness.baseUrl}/v1/responses`, {
      method: "POST",
      headers: browserHeaders({ "Content-Type": "application/json" }),
      body: JSON.stringify({ model: MODEL, input: "hi" }),
    });
    expect(failed.status).toBe(401);
  });

  it("refuses a browser request from a disallowed origin", async () => {
    const harness = await start([[{ type: "completed" }]]);
    const failed = await fetch(`${harness.baseUrl}/v1/responses`, {
      method: "POST",
      headers: {
        Origin: "https://evil.example",
        "Tailscale-User-Login": "owner@example.com",
        Authorization: `Bearer ${harness.capability}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ model: MODEL, input: "hi" }),
    });
    expect(failed.status).toBe(403);
  });

  it("refuses GET on the create route", async () => {
    const harness = await start([[{ type: "completed" }]]);
    const failed = await fetch(`${harness.baseUrl}/v1/responses`, {
      headers: browserHeaders({
        Authorization: `Bearer ${harness.capability}`,
      }),
    });
    expect(failed.status).toBe(405);
    expect(failed.headers.get("allow")).toBe("POST");
  });
});

describe("standard-client ingress profile", () => {
  it("refuses an originless caller when the grant withholds non-browser consent", async () => {
    const harness = await start([[{ type: "completed" }]]);
    const refused = await fetch(`${harness.baseUrl}/v1/responses`, {
      method: "POST",
      headers: {
        "Tailscale-User-Login": "owner@example.com",
        Authorization: `Bearer ${harness.capability}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ model: MODEL, input: "hi" }),
    });
    expect(refused.status).toBe(401);
  });

  it("admits an originless caller when the user consented to non-browser clients", async () => {
    const harness = await start(
      [[{ type: "text.delta", delta: "hi" }, { type: "completed" }]],
      { nonBrowserClients: true },
    );
    const accepted = await fetch(`${harness.baseUrl}/v1/responses`, {
      method: "POST",
      headers: {
        "Tailscale-User-Login": "owner@example.com",
        Authorization: `Bearer ${harness.capability}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ model: MODEL, input: "hi" }),
    });
    expect(accepted.status).toBe(200);
    expect(((await accepted.json()) as ResponseBody).status).toBe("completed");
  });

  it("still refuses an originless caller with no transport principal", async () => {
    const harness = await start([[{ type: "completed" }]], {
      nonBrowserClients: true,
    });
    const refused = await fetch(`${harness.baseUrl}/v1/responses`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${harness.capability}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ model: MODEL, input: "hi" }),
    });
    // The transport boundary refuses before any application authorization is
    // considered: no Tailscale principal, no route.
    expect(refused.status).toBe(403);
  });
});

describe("Agent Connect control extensions", () => {
  it("retrieves a chain, redelivers its pending call, and cancels it", async () => {
    const harness = await start([
      [call("provider_a")],
      [{ type: "completed" }],
    ]);
    const created = (await (
      await post(harness, { model: MODEL, input: "hi" })
    ).json()) as ResponseBody;
    const callId = callIdOf(created);
    const headers = browserHeaders({
      Authorization: `Bearer ${harness.capability}`,
    });

    const chain = await fetch(
      `${harness.baseUrl}/v1/agent-connect/responses/${created.id}`,
      { headers },
    );
    expect(chain.status).toBe(200);
    expect(await chain.json()).toMatchObject({
      response_id: created.id,
      chain_status: "waiting_for_output",
      recovery: "reattached_live",
    });

    const pending = await fetch(
      `${harness.baseUrl}/v1/agent-connect/responses/${created.id}/pending-function-calls`,
      { headers },
    );
    expect(await pending.json()).toEqual({
      pending_function_calls: [
        {
          call_id: callId,
          name: "set_page_message",
          arguments: '{"message":"hi"}',
          response_id: created.id,
        },
      ],
    });

    const cancelled = await fetch(
      `${harness.baseUrl}/v1/agent-connect/responses/${created.id}/cancel`,
      { method: "POST", headers },
    );
    expect(await cancelled.json()).toMatchObject({ chain_status: "terminal" });

    const afterCancel = await post(harness, {
      model: MODEL,
      previous_response_id: created.id,
      input: [{ type: "function_call_output", call_id: callId, output: "{}" }],
    });
    expect(afterCancel.status).toBe(409);
    expect(
      ((await afterCancel.json()) as { error: { code: string } }).error.code,
    ).toBe("response_cancelled");
  });

  it("retrieves a response that completed while the gateway was down", async () => {
    const harness = await start([
      [{ type: "text.delta", delta: "done" }, { type: "completed" }],
    ]);
    const created = (await (
      await post(harness, { model: MODEL, input: "hi" })
    ).json()) as ResponseBody;
    const baseUrl = await restart(harness);

    const chain = await fetch(
      `${baseUrl}/v1/agent-connect/responses/${created.id}`,
      {
        headers: browserHeaders({
          Authorization: `Bearer ${harness.capability}`,
        }),
      },
    );
    expect(chain.status).toBe(200);
    expect(await chain.json()).toMatchObject({
      response_id: created.id,
      recovery: "terminal_reconstructed",
      response: { status: "completed" },
    });
  });

  it("reports a chain parked across a restart as interrupted", async () => {
    const harness = await start([[call("provider_a")]]);
    const created = (await (
      await post(harness, { model: MODEL, input: "hi" })
    ).json()) as ResponseBody;
    const baseUrl = await restart(harness);
    const headers = browserHeaders({
      Authorization: `Bearer ${harness.capability}`,
    });

    // The ledger retains the call for diagnosis, but the gateway must not ask
    // the browser to execute a side effect for a run that cannot accept it.
    const pending = await fetch(
      `${baseUrl}/v1/agent-connect/responses/${created.id}/pending-function-calls`,
      { headers },
    );
    expect(await pending.json()).toEqual({ pending_function_calls: [] });

    const chain = await fetch(
      `${baseUrl}/v1/agent-connect/responses/${created.id}`,
      { headers },
    );
    // The pending-call lookup retired the dead run to interrupted. A later
    // status lookup reconstructs that now-terminal resource from the ledger.
    expect(await chain.json()).toMatchObject({
      recovery: "terminal_reconstructed",
      chain_status: "terminal",
    });
  });

  it("refreshes a capability without replacing the provider session under a live chain", async () => {
    const harness = await start([
      [call("provider_a")],
      [{ type: "completed" }],
    ]);
    const created = (await (
      await post(harness, { model: MODEL, input: "hi" })
    ).json()) as ResponseBody;
    const callId = callIdOf(created);

    // A capability refresh mid-chain: the runtime reports the provider session
    // as unhealthy, which on the old task route would mint a replacement.
    harness.runtime.healthy = false;
    const refreshed = await fetch(`${harness.baseUrl}/v1/app-sessions`, {
      method: "POST",
      headers: browserHeaders({
        Authorization: `Bearer ${harness.capability}`,
        "Content-Type": "application/json",
      }),
      body: JSON.stringify({ appId: "test-app", tools: [tool()] }),
    });
    expect(refreshed.status).toBe(201);
    const renewed = (await refreshed.json()) as { accessToken: string };
    expect(harness.runtime.createdSessions).toBe(1);

    // The chain continues under the refreshed capability, on the same run.
    const continued = await fetch(`${harness.baseUrl}/v1/responses`, {
      method: "POST",
      headers: browserHeaders({
        Authorization: `Bearer ${renewed.accessToken}`,
        "Content-Type": "application/json",
      }),
      body: JSON.stringify({
        model: MODEL,
        previous_response_id: created.id,
        input: [
          { type: "function_call_output", call_id: callId, output: "{}" },
        ],
      }),
    });
    expect(continued.status).toBe(200);
    expect(((await continued.json()) as ResponseBody).status).toBe("completed");
    expect(harness.backend.runs).toHaveLength(1);
  });

  it("reuses a grant session without repairing its provider under a live chain", async () => {
    const harness = await start([[call("provider_a")]]);
    expect(
      await post(harness, { model: MODEL, input: "start work" }),
    ).toMatchObject({ status: 200 });

    harness.runtime.healthy = false;
    const reused = await fetch(`${harness.baseUrl}/v1/app-sessions`, {
      method: "POST",
      headers: browserHeaders({
        Authorization: `Bearer ${harness.grant}`,
        "Content-Type": "application/json",
      }),
      body: JSON.stringify({ appId: "test-app", tools: [tool()] }),
    });

    expect(reused.status).toBe(201);
    expect(harness.runtime.createdSessions).toBe(1);
  });

  it("refuses a chain that belongs to a different capability", async () => {
    const harness = await start([[call("provider_a")]]);
    const created = (await (
      await post(harness, { model: MODEL, input: "hi" })
    ).json()) as ResponseBody;
    const other = await start([[{ type: "completed" }]]);
    const refused = await fetch(
      `${other.baseUrl}/v1/agent-connect/responses/${created.id}`,
      {
        headers: browserHeaders({
          Authorization: `Bearer ${other.capability}`,
        }),
      },
    );
    expect(refused.status).toBe(404);
  });
});
