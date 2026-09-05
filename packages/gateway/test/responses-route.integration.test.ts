import { mkdtempSync, rmSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import OpenAI from "openai";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  startOpenClawTestRuntime,
  type OpenClawTestRuntime,
} from "../../../scripts/openclaw-test-runtime.mjs";
import { createGateway } from "../src/gateway.js";
import {
  APP_ORIGIN,
  authorize,
  createSession,
  headers,
  post,
} from "./support/gateway-client.js";

const integration =
  process.env.RUN_OPENCLAW_INTEGRATION === "1" ? describe : describe.skip;
integration("public Responses routes against real OpenClaw", () => {
  let runtime: OpenClawTestRuntime;
  let server: ReturnType<typeof createGateway>;
  let directory: string;
  let baseUrl: string;
  let grant: string;
  beforeAll(async () => {
    runtime = await startOpenClawTestRuntime({
      onModelRequest(_body, inference) {
        inference.text("public route success");
      },
    });
    directory = mkdtempSync(join(tmpdir(), "ac-openclaw-routes-"));
    server = createGateway({
      allowedOrigins: new Set([APP_ORIGIN]),
      allowedTailscaleUsers: new Set(["owner@example.com"]),
      openclawBaseUrl: runtime.baseUrl,
      openclawToken: runtime.token,
      openclawAgentId: runtime.agentId,
      authStatePath: join(directory, "gateway.json"),
      publicEndpoint: "https://runtime.example",
      enrollmentPassphrase: "test enrollment phrase",
    });
    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", resolve),
    );
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    grant = await authorize(baseUrl);
  }, 120_000);
  afterAll(async () => {
    if (server)
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    await runtime?.close();
    if (directory) rmSync(directory, { recursive: true, force: true });
  }, 30_000);
  it("supports an unmodified OpenAI nonstream client and completed-turn followup", async () => {
    const session = await createSession(baseUrl, grant);
    const client = new OpenAI({
      baseURL: `${baseUrl}/v1`,
      apiKey: session.accessToken,
      defaultHeaders: headers(session.accessToken),
      maxRetries: 0,
    });
    const first = await client.responses.create({
      model: "agent-connect/default",
      input: "hello",
    });
    expect(first.status).toBe("completed");
    expect(first.model).toBe("agent-connect/default");
    expect(first.output_text).toBe("public route success");
    const followup = await client.responses.create({
      model: "agent-connect/default",
      input: "continue",
      previous_response_id: first.id,
    });
    expect(followup.status).toBe("completed");
    const other = await createSession(baseUrl, grant);
    const stolen = await fetch(
      `${baseUrl}/v1/agent-connect/responses/${first.id}`,
      { headers: headers(other.accessToken) },
    );
    expect(stolen.status).toBe(404);
  }, 60_000);
  it.each([
    { model: "caller-model" },
    { instructions: "route elsewhere" },
    { metadata: { session: "foreign" } },
    { tools: [{ type: "function", name: "exec", parameters: {} }] },
  ])(
    "rejects caller policy substitution %j without inference",
    async (fields) => {
      const session = await createSession(baseUrl, grant);
      const count = runtime.modelRequests.length;
      const rejected = await post(baseUrl, session.accessToken, {
        input: "blocked",
        ...fields,
      });
      expect(rejected.status).toBeGreaterThanOrEqual(400);
      expect(runtime.modelRequests).toHaveLength(count);
    },
  );
  it("never forwards caller routing headers to the selected runtime", async () => {
    const session = await createSession(baseUrl, grant);
    const response = await fetch(`${baseUrl}/v1/responses`, {
      method: "POST",
      headers: {
        ...headers(session.accessToken),
        "x-openclaw-agent-id": "foreign",
        "x-openclaw-session-key": "foreign",
        "x-openclaw-model": "foreign",
      },
      body: JSON.stringify({
        model: "agent-connect/default",
        input: "still pinned",
      }),
    });
    expect(response.status).toBe(200);
    expect(JSON.stringify(await response.json())).not.toContain(runtime.token);
  }, 30_000);
});
