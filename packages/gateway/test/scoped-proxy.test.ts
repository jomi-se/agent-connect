import { createHash } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Server } from "node:http";

import { afterEach, describe, expect, it, vi } from "vitest";

import { ConnectorAuth } from "../src/connector-auth.js";
import {
  DelegatedGrantService,
  type DelegatedGrantStore,
} from "../src/delegated-grants.js";
import { createScopedResponsesProxy } from "../src/scoped-proxy/server.js";

const ISSUER = "https://gateway.example";
const RESOURCE = `${ISSUER}/v1/responses`;
const APP = "https://bookhand.example";
const UPSTREAM_TOKEN = "private-upstream-token";
const TOOL = {
  name: "lookup_book",
  description: "Look up a book",
  inputSchema: {
    type: "object",
    properties: { title: { type: "string" } },
    required: ["title"],
    additionalProperties: false,
  },
};

const servers: Server[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map(close));
});

class MemoryStore implements DelegatedGrantStore {
  value: unknown;
  load() {
    return structuredClone(this.value);
  }
  save(value: unknown) {
    this.value = structuredClone(value);
  }
}

describe("stock OpenClaw scoped Responses proxy", () => {
  it("requires explicit owner login and ignores a claimed Tailscale identity", async () => {
    const grants = service();
    const fetch = vi.fn<typeof globalThis.fetch>();
    const { baseUrl } = await startProxy(grants, fetch);
    const authorizationUrl = `${baseUrl}/agent-connect/oauth/authorize?client_id=${encodeURIComponent(APP)}&request_uri=urn%3Afixture`;
    const login = await globalThis.fetch(authorizationUrl, {
      headers: { "tailscale-user-login": "local-owner" },
    });
    expect(login.status).toBe(401);
    const challenge = hiddenValue(await login.text(), "challenge");
    const tampered = await globalThis.fetch(
      `${baseUrl}/agent-connect/owner/login`,
      {
        method: "POST",
        redirect: "manual",
        headers: {
          origin: ISSUER,
          "content-type": "application/x-www-form-urlencoded",
        },
        body: new URLSearchParams({
          challenge: `${challenge}x`,
          passphrase: "correct enrollment phrase",
        }),
      },
    );
    expect(tampered.status).toBe(400);

    const authenticated = await globalThis.fetch(
      `${baseUrl}/agent-connect/owner/login`,
      {
        method: "POST",
        redirect: "manual",
        headers: {
          origin: ISSUER,
          "content-type": "application/x-www-form-urlencoded",
        },
        body: new URLSearchParams({
          challenge,
          passphrase: "correct enrollment phrase",
        }),
      },
    );
    expect(authenticated.status).toBe(303);
    expect(authenticated.headers.get("set-cookie")).toMatch(
      /^agent_connect_owner=aco_[^;]+; Path=\/agent-connect\/; HttpOnly; Secure; SameSite=Strict;/,
    );
    expect(fetch).not.toHaveBeenCalled();
  });

  it("binds continuation to a grant while refresh preserves and revoke removes authority", async () => {
    const grants = service();
    const first = issue(grants, APP);
    const sibling = issue(grants, "https://sibling.example");
    const upstream: Array<{ headers: Headers; body: Record<string, unknown> }> =
      [];
    let sequence = 0;
    const fetch = vi.fn<typeof globalThis.fetch>(async (_input, init) => {
      const headers = new Headers(init?.headers);
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      upstream.push({ headers, body });
      sequence += 1;
      return Response.json({
        id: `resp_${sequence}`,
        object: "response",
        status: "completed",
        output:
          sequence === 1
            ? [
                {
                  type: "function_call",
                  call_id: "call_1",
                  name: TOOL.name,
                  arguments: '{"title":"Flatland"}',
                },
              ]
            : [
                {
                  type: "message",
                  role: "assistant",
                  content: [{ type: "output_text", text: "done" }],
                },
              ],
      });
    });
    const { baseUrl } = await startProxy(grants, fetch);

    const initial = await post(baseUrl, first.accessToken, APP, {
      model: "openclaw/default",
      input: "Look up Flatland",
      tools: [wireTool()],
      stream: false,
    });
    expect(initial.status).toBe(200);
    expect(upstream).toHaveLength(1);
    expect(upstream[0]?.headers.get("authorization")).toBe(
      `Bearer ${UPSTREAM_TOKEN}`,
    );
    expect(upstream[0]?.headers.get("x-openclaw-agent-id")).toBe("restricted");
    expect(upstream[0]?.headers.get("x-openclaw-session-key")).toMatch(
      /^agent:restricted:openresponses:agent-connect-/,
    );
    expect(upstream[0]?.body).toMatchObject({
      model: "openclaw",
      stream: false,
    });
    expect(upstream[0]?.body).not.toHaveProperty("user");

    const siblingAttempt = await post(
      baseUrl,
      sibling.accessToken,
      "https://sibling.example",
      {
        model: "openclaw/default",
        previous_response_id: "resp_1",
        input: [
          { type: "function_call_output", call_id: "call_1", output: "stolen" },
        ],
      },
    );
    expect(siblingAttempt.status).toBe(400);
    expect(upstream).toHaveLength(1);

    const refreshed = grants.refresh({
      refreshToken: first.refreshToken,
      clientId: APP,
      resource: RESOURCE,
    });
    const continued = await post(baseUrl, refreshed.accessToken, APP, {
      model: "openclaw/default",
      previous_response_id: "resp_1",
      input: [
        {
          type: "function_call_output",
          call_id: "call_1",
          output: "book-id-42",
        },
      ],
      tools: [wireTool()],
    });
    expect(continued.status).toBe(200);
    expect(upstream).toHaveLength(2);
    expect(upstream[1]?.headers.get("x-openclaw-session-key")).toBe(
      upstream[0]?.headers.get("x-openclaw-session-key"),
    );
    expect(upstream[1]?.body.tools).toEqual([wireTool()]);

    grants.revokeByToken(refreshed.accessToken, APP);
    const revoked = await post(baseUrl, refreshed.accessToken, APP, {
      model: "openclaw/default",
      previous_response_id: "resp_2",
      input: "Follow up",
    });
    expect(revoked.status).toBe(401);
    expect(upstream).toHaveLength(2);
  });

  it("rejects routing, field, header, tool and pending-call escalation before upstream", async () => {
    const grants = service();
    const token = issue(grants, APP).accessToken;
    const fetch = vi.fn<typeof globalThis.fetch>();
    const { baseUrl } = await startProxy(grants, fetch);
    const attacks: Array<{
      body: Record<string, unknown>;
      headers?: Record<string, string>;
    }> = [
      {
        body: { model: "openclaw/admin", input: "escape", tools: [wireTool()] },
      },
      {
        body: {
          model: "openclaw/default",
          input: "escape",
          tools: [wireTool()],
          user: "shared-owner-session",
        },
      },
      {
        body: { model: "openclaw/default", input: "escape", tools: [] },
      },
      {
        body: { model: "openclaw/default", input: "escape" },
      },
      {
        body: {
          model: "openclaw/default",
          input: "escape",
          tools: [wireTool()],
        },
        headers: { "x-openclaw-agent-id": "main" },
      },
      {
        body: {
          model: "openclaw/default",
          input: "escape",
          tools: [wireTool()],
        },
        headers: { "x-openclaw-scopes": "operator.admin" },
      },
    ];
    for (const attack of attacks) {
      const response = await post(
        baseUrl,
        token,
        APP,
        attack.body,
        attack.headers,
      );
      expect(response.status).toBe(400);
    }
    const malformed = await globalThis.fetch(`${baseUrl}/v1/responses`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
        origin: APP,
      },
      body: "{",
    });
    expect(malformed.status).toBe(400);
    const oversized = await post(baseUrl, token, APP, {
      model: "openclaw/default",
      input: "x".repeat(300_000),
      tools: [wireTool()],
    });
    expect(oversized.status).toBe(413);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("stops an unapproved streamed function call before publishing that event", async () => {
    const grants = service();
    const token = issue(grants, APP).accessToken;
    const stream = [
      sse({ type: "response.created", response: { id: "resp_bad" } }),
      sse({
        type: "response.output_item.done",
        item: { type: "function_call", call_id: "call_bad", name: "exec" },
      }),
    ].join("");
    const fetch = vi.fn<typeof globalThis.fetch>(
      async () =>
        new Response(stream, {
          headers: { "content-type": "text/event-stream" },
        }),
    );
    const { baseUrl } = await startProxy(grants, fetch);
    const response = await post(baseUrl, token, APP, {
      model: "openclaw/default",
      input: "stream",
      tools: [wireTool()],
      stream: true,
    });
    const body = await response.text();
    expect(response.status).toBe(200);
    expect(body).toContain("response.created");
    expect(body).toContain("response.failed");
    expect(body).not.toContain("call_bad");
    expect(body).not.toContain('"name":"exec"');
  });

  it("stops an unapproved function call in the first output-item event", async () => {
    const grants = service();
    const token = issue(grants, APP).accessToken;
    const stream = [
      sse({ type: "response.created", response: { id: "resp_bad_added" } }),
      sse({
        type: "response.output_item.added",
        item: { type: "function_call", call_id: "call_bad", name: "exec" },
      }),
    ].join("");
    const fetch = vi.fn<typeof globalThis.fetch>(
      async () =>
        new Response(stream, {
          headers: { "content-type": "text/event-stream" },
        }),
    );
    const { baseUrl } = await startProxy(grants, fetch);
    const response = await post(baseUrl, token, APP, {
      model: "openclaw/default",
      input: "stream",
      tools: [wireTool()],
      stream: true,
    });
    const body = await response.text();
    expect(response.status).toBe(200);
    expect(body).toContain("response.created");
    expect(body).toContain("response.failed");
    expect(body).not.toContain("response.output_item.added");
    expect(body).not.toContain('"name":"exec"');
  });

  it("replaces an upstream streamed failure with a redacted terminal event", async () => {
    const grants = service();
    const token = issue(grants, APP).accessToken;
    const stream = [
      sse({ type: "response.created", response: { id: "resp_failed" } }),
      sse({
        type: "response.failed",
        response: {
          id: "resp_failed",
          status: "failed",
          error: { message: `provider exposed ${UPSTREAM_TOKEN}` },
        },
      }),
    ].join("");
    const fetch = vi.fn<typeof globalThis.fetch>(
      async () =>
        new Response(stream, {
          headers: { "content-type": "text/event-stream" },
        }),
    );
    const { baseUrl } = await startProxy(grants, fetch);
    const response = await post(baseUrl, token, APP, {
      model: "openclaw/default",
      input: "stream",
      tools: [wireTool()],
      stream: true,
    });
    const body = await response.text();
    expect(body).toContain('"id":"resp_failed"');
    expect(body).toContain("proxy_interrupted");
    expect(body).not.toContain(UPSTREAM_TOKEN);
    const retry = await post(baseUrl, token, APP, {
      model: "openclaw/default",
      previous_response_id: "resp_failed",
      input: "retry",
      tools: [wireTool()],
    });
    expect(retry.status).toBe(400);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("fails closed when the supervised config changes and never exposes upstream errors", async () => {
    const grants = service();
    const token = issue(grants, APP).accessToken;
    let current = true;
    const fetch = vi.fn<typeof globalThis.fetch>(
      async () =>
        new Response("private token appeared in an upstream diagnostic", {
          status: 401,
        }),
    );
    const { baseUrl } = await startProxy(grants, fetch, () => {
      if (!current) throw new Error("changed");
    });
    const rejected = await post(baseUrl, token, APP, {
      model: "openclaw/default",
      input: "one",
      tools: [wireTool()],
    });
    expect(rejected.status).toBe(502);
    expect(await rejected.text()).not.toContain("private token");
    expect(fetch.mock.calls[0]?.[1]?.redirect).toBe("error");
    current = false;
    const changed = await post(baseUrl, token, APP, {
      model: "openclaw/default",
      input: "two",
      tools: [wireTool()],
    });
    expect(changed.status).toBe(503);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("checks the running config revision immediately before upstream admission", async () => {
    const grants = service();
    const token = issue(grants, APP).accessToken;
    const fetch = vi.fn<typeof globalThis.fetch>(async () =>
      Response.json({ id: "must_not_run", status: "completed", output: [] }),
    );
    const { baseUrl } = await startProxy(
      grants,
      fetch,
      () => {},
      async () => {
        throw new Error("runtime drift");
      },
    );
    const response = await post(baseUrl, token, APP, {
      model: "openclaw/default",
      input: "must not run",
      tools: [wireTool()],
    });
    expect(response.status).toBe(503);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("drops a partially observed response mapping when the browser disconnects", async () => {
    const grants = service();
    const token = issue(grants, APP).accessToken;
    let cancelled = false;
    const fetch = vi.fn<typeof globalThis.fetch>(async (_input, init) => {
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(
            new TextEncoder().encode(
              sse({
                type: "response.created",
                response: { id: "resp_partial" },
              }),
            ),
          );
          init?.signal?.addEventListener(
            "abort",
            () => {
              cancelled = true;
              controller.error(new DOMException("aborted", "AbortError"));
            },
            { once: true },
          );
        },
      });
      return new Response(stream, {
        headers: { "content-type": "text/event-stream" },
      });
    });
    const { baseUrl } = await startProxy(grants, fetch);
    const controller = new AbortController();
    const response = await globalThis.fetch(`${baseUrl}/v1/responses`, {
      method: "POST",
      signal: controller.signal,
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
        origin: APP,
      },
      body: JSON.stringify({
        model: "openclaw/default",
        input: "hang",
        tools: [wireTool()],
        stream: true,
      }),
    });
    const reader = response.body?.getReader();
    expect((await reader?.read())?.value?.length).toBeGreaterThan(0);
    controller.abort();
    await reader?.cancel().catch(() => undefined);
    for (let attempt = 0; attempt < 20 && !cancelled; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    expect(cancelled).toBe(true);
    const retry = await post(baseUrl, token, APP, {
      model: "openclaw/default",
      previous_response_id: "resp_partial",
      input: "do not replay",
      tools: [wireTool()],
    });
    expect(retry.status).toBe(400);
    expect(fetch).toHaveBeenCalledTimes(1);
  });
});

function service(): DelegatedGrantService {
  return new DelegatedGrantService({
    resource: RESOURCE,
    store: new MemoryStore(),
    offeredPolicies: [
      {
        ref: "application-tools-only",
        label: "Application tools only",
        agentId: "restricted",
        fingerprint: "sha256:fixed-policy",
        nativeCapabilities: [],
      },
    ],
  });
}

function issue(grants: DelegatedGrantService, clientId: string) {
  const verifier = "v".repeat(43);
  const request = grants.createRequest({
    clientId,
    redirectUri: `${clientId}/oauth/callback`,
    resource: RESOURCE,
    state: "state",
    codeChallenge: createHash("sha256").update(verifier).digest("base64url"),
    codeChallengeMethod: "S256",
    applicationTools: [TOOL],
  });
  const approved = grants.approve(request.requestUri, {
    ownerSubject: "local-owner",
    policyRef: "application-tools-only",
  });
  return grants.exchange({
    code: approved.code,
    codeVerifier: verifier,
    clientId,
    redirectUri: `${clientId}/oauth/callback`,
    resource: RESOURCE,
  });
}

async function startProxy(
  grants: DelegatedGrantService,
  fetch: typeof globalThis.fetch,
  assertUnchanged: () => void = () => {},
  assertRuntimeCurrent: () => Promise<void> = async () => {},
): Promise<{ baseUrl: string }> {
  const directory = mkdtempSync(join(tmpdir(), "ac-scoped-proxy-test-"));
  const ownerAuth = new ConnectorAuth({
    statePath: join(directory, "owner.json"),
    publicEndpoint: ISSUER,
    enrollmentPassphrase: "correct enrollment phrase",
  });
  const server = createScopedResponsesProxy({
    issuer: ISSUER,
    resource: RESOURCE,
    upstreamBaseUrl: "http://127.0.0.1:18789",
    upstreamToken: UPSTREAM_TOKEN,
    grantService: grants,
    ownerAuth,
    policySnapshot: { assertUnchanged, assertRuntimeCurrent },
    fetch,
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string")
    throw new Error("missing address");
  return { baseUrl: `http://127.0.0.1:${address.port}` };
}

async function post(
  baseUrl: string,
  token: string,
  origin: string,
  body: Record<string, unknown>,
  headers: Record<string, string> = {},
): Promise<Response> {
  return fetch(`${baseUrl}/v1/responses`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
      origin,
      ...headers,
    },
    body: JSON.stringify(body),
  });
}

function wireTool() {
  return {
    type: "function",
    name: TOOL.name,
    description: TOOL.description,
    parameters: TOOL.inputSchema,
  };
}

function sse(value: unknown): string {
  return `data: ${JSON.stringify(value)}\n\n`;
}

function hiddenValue(html: string, name: string): string {
  const value = html.match(new RegExp(`name="${name}" value="([^"]+)"`))?.[1];
  if (!value) throw new Error(`Missing ${name}`);
  return value;
}

async function close(server: Server): Promise<void> {
  server.closeAllConnections();
  if (server.listening)
    await new Promise<void>((resolve) => server.close(() => resolve()));
}
