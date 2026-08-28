import { mkdtempSync, rmSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import OpenAI from "openai";
import { afterEach, describe, expect, it } from "vitest";

import { createGateway } from "../src/gateway.js";
import type { BackendEvent } from "../src/responses/backend.js";
import type { AgentRuntime } from "../src/runtime.js";
import { FakeBackend, type FakeTurn } from "./support/fake-backend.js";

// VAL-RESP-003: an unmodified Responses client, configured only with a base URL
// and an API key, completes the version 0 profile. The client is the real
// `openai` package; nothing about the request is Agent Connect specific.
//
// The one extra header is `Tailscale-User-Login`, which stands in for the
// transport principal that Tailscale Serve injects in a real deployment. It is
// a property of the network path, not of the protocol.

const servers: ReturnType<typeof createGateway>[] = [];
const directories: string[] = [];

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
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

const APP_ORIGIN = "https://preview.example";
const MODEL = "agent-connect/default";

const toolDefinition = {
  name: "set_page_message",
  description: "Set one visible page message",
  inputSchema: {
    type: "object",
    properties: { message: { type: "string" } },
    required: ["message"],
    additionalProperties: false,
  },
};

class FakeRuntime implements AgentRuntime {
  private count = 0;
  async createSession(): Promise<string> {
    this.count += 1;
    return `provider-${this.count}`;
  }
  async isHealthy(): Promise<boolean> {
    return true;
  }
}

async function startGateway(
  turns: readonly FakeTurn[],
): Promise<{ client: OpenAI; backend: FakeBackend }> {
  const directory = mkdtempSync(join(tmpdir(), "agent-connect-conformance-"));
  directories.push(directory);
  const backend = new FakeBackend({ turns });
  const server = createGateway({
    allowedOrigins: new Set([APP_ORIGIN]),
    allowedTailscaleUsers: new Set(["owner@example.com"]),
    omnigentBaseUrl: "http://127.0.0.1:6767",
    authStatePath: join(directory, "gateway.json"),
    publicEndpoint: "https://runtime.example",
    enrollmentPassphrase: "test enrollment phrase",
    runtime: new FakeRuntime(),
    responseBackend: backend,
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const capability = await provisionCapability(baseUrl);
  return {
    backend,
    client: new OpenAI({
      baseURL: `${baseUrl}/v1`,
      apiKey: capability,
      defaultHeaders: { "Tailscale-User-Login": "owner@example.com" },
      maxRetries: 0,
    }),
  };
}

/**
 * The browser-side ceremony, run once so the standard client has a capability.
 * The user approves non-browser clients here, which is what admits a caller
 * that sends no browser Origin (ADR 0009).
 */
async function provisionCapability(baseUrl: string): Promise<string> {
  const headers = {
    Origin: APP_ORIGIN,
    "Tailscale-User-Login": "owner@example.com",
  };
  const codeVerifier = "v".repeat(43);
  const challenge = Buffer.from(
    await crypto.subtle.digest(
      "SHA-256",
      new TextEncoder().encode(codeVerifier),
    ),
  ).toString("base64url");
  const pushed = await fetch(`${baseUrl}/v1/authorization-requests`, {
    method: "POST",
    headers: { ...headers, "Content-Type": "application/json" },
    body: JSON.stringify({
      appId: "conformance",
      redirectUri: `${APP_ORIGIN}/oauth/callback`,
      state: "state_state_state_state",
      codeChallenge: challenge,
      scopes: ["agent:prompt", "agent:result", "tools:invoke"],
      tools: [toolDefinition],
    }),
  });
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
      non_browser_clients: "yes",
    }),
  });
  const code =
    new URL(approval.headers.get("location") ?? "").searchParams.get("code") ??
    "";
  const token = await fetch(`${baseUrl}/oauth/token`, {
    method: "POST",
    headers: { ...headers, "Content-Type": "application/json" },
    body: JSON.stringify({
      code,
      codeVerifier,
      appId: "conformance",
      redirectUri: `${APP_ORIGIN}/oauth/callback`,
    }),
  });
  const grant = (await token.json()) as { accessToken: string };
  const session = await fetch(`${baseUrl}/v1/app-sessions`, {
    method: "POST",
    headers: {
      ...headers,
      Authorization: `Bearer ${grant.accessToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ appId: "conformance", tools: [toolDefinition] }),
  });
  return ((await session.json()) as { accessToken: string }).accessToken;
}

const wireTools = [
  {
    type: "function" as const,
    name: toolDefinition.name,
    description: toolDefinition.description,
    parameters: toolDefinition.inputSchema,
    strict: true,
  },
];

const call = (token: string): BackendEvent => ({
  type: "tool.call",
  providerToken: token,
  name: toolDefinition.name,
  arguments: '{"message":"hello"}',
});

function callIdOf(response: { output: readonly unknown[] }): string {
  const item = response.output.at(-1) as
    { type: string; call_id?: string } | undefined;
  expect(item?.type).toBe("function_call");
  return item?.call_id ?? "";
}

describe("an unmodified OpenAI Responses client", () => {
  it("completes two sequential function calls and final text", async () => {
    const { client, backend } = await startGateway([
      [{ type: "text.delta", delta: "on it" }, call("provider_a")],
      [call("provider_b")],
      [{ type: "text.delta", delta: "done" }, { type: "completed" }],
    ]);

    const first = await client.responses.create({
      model: MODEL,
      input: "update the page",
      tools: wireTools,
    });
    expect(first.status).toBe("completed");
    expect(first.model).toBe(MODEL);

    const second = await client.responses.create({
      model: MODEL,
      previous_response_id: first.id,
      input: [
        {
          type: "function_call_output",
          call_id: callIdOf(first),
          output: '{"ok":true}',
        },
      ],
    });
    const third = await client.responses.create({
      model: MODEL,
      previous_response_id: second.id,
      input: [
        {
          type: "function_call_output",
          call_id: callIdOf(second),
          output: '{"ok":true}',
        },
      ],
    });

    expect(third.status).toBe("completed");
    expect(third.output_text).toBe("done");
    // The client's own convenience accessors work, which is the real test of
    // whether the resource is shaped the way an ordinary client expects.
    expect(first.output_text).toBe("on it");
    expect(backend.runs).toHaveLength(1);
  });

  it("streams a response through the client's own SSE parser", async () => {
    const { client } = await startGateway([
      [
        { type: "text.delta", delta: "he" },
        { type: "text.delta", delta: "llo" },
        { type: "completed" },
      ],
    ]);
    const stream = await client.responses.create({
      model: MODEL,
      input: "hi",
      stream: true,
    });
    const types: string[] = [];
    let text = "";
    for await (const event of stream) {
      types.push(event.type);
      if (event.type === "response.output_text.delta") text += event.delta;
    }
    expect(text).toBe("hello");
    expect(types.at(0)).toBe("response.created");
    expect(types.at(-1)).toBe("response.completed");
  });

  it("surfaces an out-of-profile field as a typed client error", async () => {
    const { client } = await startGateway([[{ type: "completed" }]]);
    await expect(
      client.responses.create({
        model: MODEL,
        input: "hi",
        temperature: 0.2,
      }),
    ).rejects.toMatchObject({
      status: 400,
      error: { code: "unsupported_feature", param: "temperature" },
    });
  });
});
