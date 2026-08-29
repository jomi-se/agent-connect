import type { AddressInfo } from "node:net";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ConnectorAuth, type EnrollmentBundle } from "../src/connector-auth.js";
import { configFromEnv } from "../src/config.js";
import { createGateway } from "../src/gateway.js";
import type { AgentRuntime } from "../src/runtime.js";
import { hashToolSnapshot } from "../src/tool-snapshot.js";

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

describe("gateway", () => {
  it("rejects trusted-proxy profiles on a non-loopback listener", () => {
    expect(() =>
      configFromEnv({
        AGENT_CONNECT_HOST: "0.0.0.0",
        AGENT_CONNECT_TRANSPORT_PROFILE: "tailscale-serve",
      }),
    ).toThrow(
      "tailscale-serve and dynamic enrollment require a loopback gateway host",
    );
  });

  it("does not accept an enrollment passphrase from the process environment", () => {
    const config = configFromEnv({
      AGENT_CONNECT_STATE_PATH: "/tmp/agent-connect-test-state.json",
      AGENT_CONNECT_PUBLIC_ENDPOINT: "https://gateway.example",
      AGENT_CONNECT_ENROLLMENT_PASSPHRASE: "must not enter runtime config",
    });

    expect(config).not.toHaveProperty("enrollmentPassphrase");
  });

  it("answers an allowed CORS preflight without requiring identity", async () => {
    const { baseUrl } = await start();
    const response = await fetch(`${baseUrl}/v1/responses`, {
      method: "OPTIONS",
      headers: { Origin: "https://preview.example" },
    });

    expect(response.status).toBe(204);
    expect(response.headers.get("access-control-allow-origin")).toBe(
      "https://preview.example",
    );
    expect(response.headers.get("vary")).toBe("Origin");
  });

  it("rejects an unlisted origin before proxying", async () => {
    const upstream = vi.fn<typeof fetch>();
    const { baseUrl } = await start({ fetch: upstream });
    const response = await fetch(`${baseUrl}/v1/responses`, {
      headers: {
        Origin: "https://evil.example",
        "Tailscale-User-Login": "owner@example.com",
      },
    });

    expect(response.status).toBe(403);
    expect(upstream).not.toHaveBeenCalled();
  });

  it.each([
    ["missing", undefined],
    ["unexpected", "intruder@example.com"],
    ["ambiguous", "owner@example.com, intruder@example.com"],
  ])(
    "rejects a %s Tailscale identity before proxying",
    async (_case, tailscaleUser) => {
      const upstream = vi.fn<typeof fetch>();
      const { baseUrl } = await start({ fetch: upstream });
      const response = await fetch(`${baseUrl}/v1/responses`, {
        headers: {
          Origin: "https://preview.example",
          ...(tailscaleUser ? { "Tailscale-User-Login": tailscaleUser } : {}),
        },
      });

      expect(response.status).toBe(403);
      expect(await response.json()).toEqual({
        error: "tailscale_user_not_allowed",
      });
      expect(upstream).not.toHaveBeenCalled();
    },
  );

  it("accepts the exact configured Tailscale identity", async () => {
    const { baseUrl } = await start();
    const response = await fetch(`${baseUrl}/v1/grants`, {
      headers: { "Tailscale-User-Login": "owner@example.com" },
    });

    expect(response.status).toBe(200);
  });

  it("never exposes raw provider sessions", async () => {
    const upstream = vi.fn<typeof fetch>();
    const { baseUrl } = await start({ fetch: upstream });
    const response = await fetch(`${baseUrl}/v1/sessions/conv_secret/stream`, {
      headers: allowedHeaders(),
    });

    expect(response.status).toBe(404);
    expect(upstream).not.toHaveBeenCalled();
  });
});

describe("managed application sessions", () => {
  it("uses an application grant and hides the provider session id", async () => {
    const runtime = new FakeRuntime();
    const { baseUrl } = await start({ runtime });
    const grant = await authorizeApp(baseUrl);

    const response = await createAppSession(baseUrl, `Bearer ${grant}`);
    expect(response.status).toBe(201);
    const created = await response.json();
    expect(created).toMatchObject({
      sessionId: expect.stringMatching(/^acs_/),
      accessToken: expect.any(String),
      toolHash: expect.any(String),
    });
    expect(JSON.stringify(created)).not.toContain("provider-1");
    expect(runtime.created).toHaveLength(1);
  });

  it("binds a capability to origin, session, and exact tool envelope", async () => {
    const runtime = new FakeRuntime();
    const upstream = vi.fn<typeof fetch>().mockResolvedValue(
      new Response('data: {"type":"response.completed"}\n\n', {
        headers: { "Content-Type": "text/event-stream" },
      }),
    );
    const { baseUrl } = await start({
      runtime,
      fetch: upstream,
      allowedOrigins: new Set([
        "https://preview.example",
        "https://other.example",
      ]),
    });
    const grant = await authorizeApp(baseUrl);
    const paired = await createAppSession(baseUrl, `Bearer ${grant}`);
    const created = await paired.json();
    const responseBody = JSON.stringify({
      model: "agent-connect/default",
      stream: true,
      input: "Use the approved tool",
      tools: [
        {
          type: "function",
          name: tool().name,
          description: tool().description,
          parameters: tool().inputSchema,
        },
      ],
    });
    const wrongOrigin = await fetch(`${baseUrl}/v1/responses`, {
      method: "POST",
      headers: {
        ...allowedHeaders({
          Authorization: `Bearer ${created.accessToken as string}`,
          "Content-Type": "application/json",
        }),
        Origin: "https://other.example",
      },
      body: responseBody,
    });
    expect(wrongOrigin.status).toBe(401);

    const tampered = await fetch(`${baseUrl}/v1/responses`, {
      method: "POST",
      headers: allowedHeaders({
        Authorization: `Bearer ${created.accessToken as string}x`,
        "Content-Type": "application/json",
      }),
      body: responseBody,
    });
    expect(tampered.status).toBe(401);

    upstream.mockClear();
    const mismatch = await fetch(`${baseUrl}/v1/responses`, {
      method: "POST",
      headers: allowedHeaders({
        Authorization: `Bearer ${created.accessToken as string}`,
        "Content-Type": "application/json",
      }),
      body: JSON.stringify({
        model: "agent-connect/default",
        stream: true,
        input: "Use a different tool",
        tools: [
          {
            type: "function",
            name: "other_tool",
            description: tool().description,
            parameters: tool().inputSchema,
          },
        ],
      }),
    });
    expect(mismatch.status).toBe(403);
    expect(upstream).not.toHaveBeenCalled();
  });

  it("reuses a healthy match and heals it when the provider goes offline", async () => {
    const runtime = new FakeRuntime();
    const { baseUrl } = await start({ runtime });
    const grant = await authorizeApp(baseUrl);
    const first = await createAppSession(baseUrl, `Bearer ${grant}`);
    const created = await first.json();

    const reused = await createAppSession(
      baseUrl,
      `Bearer ${created.accessToken as string}`,
    );
    expect(reused.status).toBe(201);
    expect((await reused.json()).sessionId).toBe(created.sessionId);
    expect(runtime.created).toHaveLength(1);

    runtime.healthy = false;
    const [refreshed, concurrentRefresh] = await Promise.all([
      createAppSession(baseUrl, `Bearer ${created.accessToken as string}`),
      createAppSession(baseUrl, `Bearer ${created.accessToken as string}`),
    ]);
    expect(refreshed.status).toBe(201);
    expect(concurrentRefresh.status).toBe(201);
    expect(runtime.created).toHaveLength(2);
  });

  it("rejects expired capabilities and changed snapshots", async () => {
    let clock = Date.parse("2026-07-13T20:00:00Z");
    const runtime = new FakeRuntime();
    const { baseUrl } = await start({
      runtime,
      capabilityTtlSeconds: 10,
      now: () => clock,
    });
    const grant = await authorizeApp(baseUrl);
    const paired = await createAppSession(baseUrl, `Bearer ${grant}`);
    const created = await paired.json();

    const changed = await createAppSession(
      baseUrl,
      `Bearer ${created.accessToken as string}`,
      [{ ...tool(), description: "A changed capability" }],
    );
    expect(changed.status).toBe(401);

    clock += 11_000;
    const expired = await fetch(`${baseUrl}/v1/responses`, {
      method: "POST",
      headers: allowedHeaders({
        Authorization: `Bearer ${created.accessToken as string}`,
        "Content-Type": "application/json",
      }),
      body: JSON.stringify({
        model: "agent-connect/default",
        stream: true,
        input: "hello",
        tools: [],
      }),
    });
    expect(expired.status).toBe(401);
  });
});

describe("connector enrollment and app authorization", () => {
  it("bounds concurrent passphrase verification without blocking the event loop", async () => {
    const directory = mkdtempSync(
      join(tmpdir(), "agent-connect-auth-verification-"),
    );
    temporaryDirectories.push(directory);
    const auth = new ConnectorAuth({
      statePath: join(directory, "connector.json"),
      publicEndpoint: "https://runtime.example",
      enrollmentPassphrase: "concurrency test phrase",
    });
    const input = {
      origin: "https://app.example",
      appId: "concurrency-test",
      redirectUri: "https://app.example/callback",
      state: "s".repeat(16),
      codeChallenge: "c".repeat(43),
      scopes: ["agent:prompt", "agent:result", "tools:invoke"],
      tools: [tool()],
    };
    const requests = [
      auth.createAuthorizationRequest(input),
      auth.createAuthorizationRequest(input),
      auth.createAuthorizationRequest(input),
    ];

    const attempts = await Promise.allSettled([
      auth.enrollDevice(
        "concurrency test phrase",
        "owner@example.com",
        requests[0]!.id,
      ),
      auth.enrollDevice(
        "concurrency test phrase",
        "owner@example.com",
        requests[1]!.id,
      ),
      auth.enrollDevice(
        "concurrency test phrase",
        "owner@example.com",
        requests[2]!.id,
      ),
    ]);

    expect(
      attempts.filter((attempt) => attempt.status === "fulfilled"),
    ).toHaveLength(2);
    expect(attempts.filter((attempt) => attempt.status === "rejected")).toEqual(
      [
        expect.objectContaining({
          reason: expect.objectContaining({ code: "enrollment_busy" }),
        }),
      ],
    );
  });

  it("serializes enrollment for one authorization request", async () => {
    const directory = mkdtempSync(
      join(tmpdir(), "agent-connect-auth-duplicate-enrollment-"),
    );
    temporaryDirectories.push(directory);
    const auth = new ConnectorAuth({
      statePath: join(directory, "connector.json"),
      publicEndpoint: "https://runtime.example",
      enrollmentPassphrase: "duplicate test phrase",
    });
    const request = auth.createAuthorizationRequest({
      origin: "https://app.example",
      appId: "duplicate-test",
      redirectUri: "https://app.example/callback",
      state: "s".repeat(16),
      codeChallenge: "c".repeat(43),
      scopes: ["agent:prompt", "agent:result", "tools:invoke"],
      tools: [tool()],
    });

    const attempts = await Promise.allSettled([
      auth.enrollDevice(
        "duplicate test phrase",
        "owner@example.com",
        request.id,
      ),
      auth.enrollDevice(
        "duplicate test phrase",
        "owner@example.com",
        request.id,
      ),
    ]);

    expect(
      attempts.filter((attempt) => attempt.status === "fulfilled"),
    ).toHaveLength(1);
    expect(attempts.filter((attempt) => attempt.status === "rejected")).toEqual(
      [
        expect.objectContaining({
          reason: expect.objectContaining({ code: "enrollment_busy" }),
        }),
      ],
    );
    expect(() => auth.approve(request.id)).not.toThrow();
    expect(() => auth.approve(request.id)).toThrow(
      "authorization_request_expired",
    );
  });

  it("bounds pending authorization state and prunes expired requests", () => {
    const directory = mkdtempSync(
      join(tmpdir(), "agent-connect-auth-capacity-"),
    );
    temporaryDirectories.push(directory);
    let now = 1_000;
    const auth = new ConnectorAuth({
      statePath: join(directory, "connector.json"),
      publicEndpoint: "https://runtime.example",
      enrollmentPassphrase: "capacity test phrase",
      now: () => now,
    });
    const input = {
      origin: "https://app.example",
      appId: "capacity-test",
      redirectUri: "https://app.example/callback",
      state: "s".repeat(16),
      codeChallenge: "c".repeat(43),
      scopes: ["agent:prompt", "agent:result", "tools:invoke"],
      tools: [tool()],
    };
    for (let request = 0; request < 256; request += 1) {
      expect(() => auth.createAuthorizationRequest(input)).not.toThrow();
    }
    expect(() => auth.createAuthorizationRequest(input)).toThrow(
      "authorization_capacity",
    );
    now += 10 * 60 * 1000 + 1;
    expect(() => auth.createAuthorizationRequest(input)).not.toThrow();
  });

  it("enrolls on the connector origin, grants with PKCE, and revokes durably", async () => {
    const directory = mkdtempSync(join(tmpdir(), "agent-connect-auth-"));
    temporaryDirectories.push(directory);
    const statePath = join(directory, "connector.json");
    const bundles: EnrollmentBundle[] = [];
    const runtime = new FakeRuntime();
    const upstream = vi.fn<typeof fetch>().mockResolvedValue(
      new Response("data: [DONE]\n\n", {
        headers: { "Content-Type": "text/event-stream" },
      }),
    );
    const { baseUrl } = await start({
      runtime,
      fetch: upstream,
      authStatePath: statePath,
      publicEndpoint: "https://runtime.example/",
      enrollmentPassphrase: "correct enrollment phrase",
      onEnrollmentBundle: (bundle) => bundles.push(bundle),
    });
    expect(bundles).toHaveLength(1);
    expect(bundles[0]?.runtimeCard.endpoint).toBe("https://runtime.example");

    const challenge = await fetch(`${baseUrl}/v1/runtime-challenges`, {
      method: "POST",
      headers: allowedHeaders({ "Content-Type": "application/json" }),
      body: JSON.stringify({ nonce: "0123456789abcdef" }),
    });
    expect(challenge.status).toBe(200);
    expect(await challenge.json()).toMatchObject({
      nonce: "0123456789abcdef",
      signature: expect.any(String),
      runtimeCard: { runtimeId: bundles[0]?.runtimeCard.runtimeId },
    });

    // Terminal pairing credentials are not an alternate consent path.
    const pairingBypass = await createAppSession(baseUrl, "Pairing PAIR-ONCE");
    expect(pairingBypass.status).toBe(401);

    const verifier = "v".repeat(43);
    const codeChallenge = await sha256Base64Url(verifier);
    const pushed = await fetch(`${baseUrl}/v1/authorization-requests`, {
      method: "POST",
      headers: allowedHeaders({ "Content-Type": "application/json" }),
      body: JSON.stringify({
        appId: "test-app",
        redirectUri: "https://preview.example/oauth/callback",
        state: "state_state_state_state",
        codeChallenge,
        scopes: ["agent:prompt", "agent:result", "tools:invoke"],
        tools: [tool()],
      }),
    });
    expect(pushed.status).toBe(201);
    const authorization = await pushed.json();

    const consent = await fetch(
      `${baseUrl}/authorize?request=${encodeURIComponent(authorization.requestId as string)}`,
      { headers: { "Tailscale-User-Login": "owner@example.com" } },
    );
    expect(consent.status).toBe(200);
    expect(consent.headers.get("referrer-policy")).toBe("same-origin");
    expect(consent.headers.get("content-security-policy")).toContain(
      "form-action 'self' https://preview.example",
    );
    const consentHtml = await consent.text();
    expect(consentHtml).toContain("https://preview.example");
    expect(consentHtml).toContain("Set one visible page message");
    expect(consentHtml).toContain("Input schema");
    expect(consentHtml).toContain(
      "Authorization does not make an application trustworthy",
    );
    expect(consentHtml).toContain("expose data available in its environment");
    expect(consentHtml).toContain('value="deny" formnovalidate');
    // The literal phrase is never rendered into the page; only a password field is.
    expect(consentHtml).not.toContain("correct enrollment phrase");

    const crossSiteApproval = await fetch(`${baseUrl}/authorize`, {
      method: "POST",
      redirect: "manual",
      headers: {
        "Tailscale-User-Login": "owner@example.com",
        Origin: "https://attacker.example",
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({
        request: authorization.requestId as string,
        decision: "deny",
      }),
    });
    expect(crossSiteApproval.status).toBe(403);

    const approval = await fetch(`${baseUrl}/authorize`, {
      method: "POST",
      redirect: "manual",
      headers: {
        "Tailscale-User-Login": "owner@example.com",
        Origin: "https://runtime.example",
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({
        request: authorization.requestId as string,
        decision: "approve",
        passphrase: "correct enrollment phrase",
      }),
    });
    expect(approval.status).toBe(303);
    expect(approval.headers.get("set-cookie")).toContain(
      "agent_connect_device=",
    );
    const redirect = new URL(approval.headers.get("location") ?? "");
    expect(redirect.origin).toBe("https://preview.example");
    expect(redirect.searchParams.get("state")).toBe("state_state_state_state");
    const code = redirect.searchParams.get("code");
    expect(code).toMatch(/^acc_/);

    const token = await fetch(`${baseUrl}/oauth/token`, {
      method: "POST",
      headers: allowedHeaders({ "Content-Type": "application/json" }),
      body: JSON.stringify({
        code,
        codeVerifier: verifier,
        appId: "test-app",
        redirectUri: "https://preview.example/oauth/callback",
      }),
    });
    expect(token.status).toBe(200);
    const granted = await token.json();
    expect(granted).toMatchObject({
      accessToken: expect.stringMatching(/^acg_/),
      grant: {
        origin: "https://preview.example",
        appId: "test-app",
        toolNames: ["set_page_message"],
      },
    });

    const created = await createAppSession(
      baseUrl,
      `Bearer ${granted.accessToken as string}`,
    );
    expect(created.status).toBe(201);
    const applicationSession = await created.json();
    expect(runtime.created).toHaveLength(1);

    const changedSnapshot = await createAppSession(
      baseUrl,
      `Bearer ${granted.accessToken as string}`,
      [{ ...tool(), description: "A changed authority" }],
    );
    expect(changedSnapshot.status).toBe(401);
    expect(runtime.created).toHaveLength(1);

    const selfRevoke = await fetch(`${baseUrl}/oauth/revoke`, {
      method: "POST",
      headers: allowedHeaders({
        Authorization: `Bearer ${granted.accessToken as string}`,
        "Content-Type": "application/json",
      }),
      body: JSON.stringify({ appId: "test-app" }),
    });
    expect(selfRevoke.status).toBe(204);

    const revokedGrant = await createAppSession(
      baseUrl,
      `Bearer ${granted.accessToken as string}`,
    );
    expect(revokedGrant.status).toBe(401);

    const repeatedSelfRevoke = await fetch(`${baseUrl}/oauth/revoke`, {
      method: "POST",
      headers: allowedHeaders({
        Authorization: "Bearer unknown-token",
        "Content-Type": "application/json",
      }),
      body: JSON.stringify({ appId: "test-app" }),
    });
    expect(repeatedSelfRevoke.status).toBe(204);

    const crossSiteRevoke = await fetch(`${baseUrl}/v1/grants`, {
      method: "POST",
      redirect: "manual",
      headers: {
        "Tailscale-User-Login": "owner@example.com",
        Origin: "https://attacker.example",
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({ grant: granted.grant.id as string }),
    });
    expect(crossSiteRevoke.status).toBe(403);

    const revoke = await fetch(`${baseUrl}/v1/grants`, {
      method: "POST",
      redirect: "manual",
      headers: {
        "Tailscale-User-Login": "owner@example.com",
        Origin: "https://runtime.example",
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({
        grant: granted.grant.id as string,
      }),
    });
    expect(revoke.status).toBe(303);

    upstream.mockClear();
    const revoked = await fetch(`${baseUrl}/v1/responses`, {
      method: "POST",
      headers: allowedHeaders({
        Authorization: `Bearer ${applicationSession.accessToken as string}`,
        "Content-Type": "application/json",
      }),
      body: JSON.stringify({
        model: "agent-connect/default",
        stream: true,
        input: "hello",
        tools: [],
      }),
    });
    expect(revoked.status).toBe(401);
    expect(upstream).not.toHaveBeenCalled();

    const reloaded = new (
      await import("../src/connector-auth.js")
    ).ConnectorAuth({
      statePath,
      publicEndpoint: "https://runtime.example",
    });
    expect(reloaded.runtimeCard.runtimeId).toBe(
      bundles[0]?.runtimeCard.runtimeId,
    );
    expect(reloaded.listGrants()[0]?.revokedAt).toBeTruthy();
  });

  it("fails closed on redirect mismatch, wrong passphrase, PKCE failure, and code replay", async () => {
    const directory = mkdtempSync(join(tmpdir(), "agent-connect-auth-"));
    temporaryDirectories.push(directory);
    const { baseUrl } = await start({
      runtime: new FakeRuntime(),
      authStatePath: join(directory, "connector.json"),
      publicEndpoint: "https://runtime.example",
      enrollmentPassphrase: "correct phrase",
    });
    const invalidRedirect = await pushAuthorization(baseUrl, {
      redirectUri: "https://evil.example/callback",
    });
    expect(invalidRedirect.status).toBe(400);

    const incompleteScopes = await pushAuthorization(baseUrl, {
      scopes: ["agent:prompt"],
    });
    expect(incompleteScopes.status).toBe(400);

    const pushed = await pushAuthorization(baseUrl);
    const authorization = await pushed.json();
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const wrongPassphrase = await fetch(`${baseUrl}/authorize`, {
        method: "POST",
        redirect: "manual",
        headers: {
          "Tailscale-User-Login": "owner@example.com",
          Origin: "https://runtime.example",
          "Content-Type": "application/x-www-form-urlencoded",
        },
        body: new URLSearchParams({
          request: authorization.requestId as string,
          decision: "approve",
          passphrase: "wrong phrase",
        }),
      });
      expect(wrongPassphrase.status).toBe(400);
    }

    const independentRequest = await (await pushAuthorization(baseUrl)).json();

    const approval = await fetch(`${baseUrl}/authorize`, {
      method: "POST",
      redirect: "manual",
      headers: {
        "Tailscale-User-Login": "owner@example.com",
        Origin: "https://runtime.example",
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({
        request: independentRequest.requestId as string,
        decision: "approve",
        passphrase: "correct phrase",
      }),
    });
    const code = new URL(
      approval.headers.get("location") ?? "",
    ).searchParams.get("code");
    const invalidPkce = await exchangeAuthorizationCode(
      baseUrl,
      code ?? "",
      "x".repeat(43),
    );
    expect(invalidPkce.status).toBe(400);
    const replay = await exchangeAuthorizationCode(
      baseUrl,
      code ?? "",
      "v".repeat(43),
    );
    expect(replay.status).toBe(400);
  });
});

describe("dynamic application enrollment", () => {
  it("authorizes a previously unknown HTTPS Origin and binds the grant to it", async () => {
    const directory = mkdtempSync(join(tmpdir(), "agent-connect-dynamic-app-"));
    temporaryDirectories.push(directory);
    const runtime = new FakeRuntime();
    const { baseUrl } = await start({
      runtime,
      allowedOrigins: new Set(),
      dynamicAppEnrollment: true,
      authStatePath: join(directory, "connector.json"),
      publicEndpoint: "https://runtime.example",
      transportProfile: "tailscale-serve",
      enrollmentPassphrase: "dynamic enrollment phrase",
    });
    const appOrigin = "https://new-app.example";
    const redirectUri = `${appOrigin}/agent-connect/callback`;
    const verifier = "v".repeat(43);

    const preflight = await fetch(`${baseUrl}/v1/authorization-requests`, {
      method: "OPTIONS",
      headers: { Origin: appOrigin },
    });
    expect(preflight.status).toBe(204);
    expect(preflight.headers.get("access-control-allow-origin")).toBe(
      appOrigin,
    );

    const pushed = await fetch(`${baseUrl}/v1/authorization-requests`, {
      method: "POST",
      headers: {
        Origin: appOrigin,
        "Tailscale-User-Login": "owner@example.com",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        appId: "third-party-app",
        redirectUri,
        state: "state_state_state_state",
        codeChallenge: await sha256Base64Url(verifier),
        scopes: ["agent:prompt", "agent:result", "tools:invoke"],
        tools: [tool()],
      }),
    });
    expect(pushed.status).toBe(201);
    const authorization = await pushed.json();

    const consent = await fetch(
      `${baseUrl}/authorize?request=${encodeURIComponent(authorization.requestId as string)}`,
      { headers: { "Tailscale-User-Login": "owner@example.com" } },
    );
    expect(consent.status).toBe(200);
    expect(await consent.text()).toContain(appOrigin);

    const approval = await fetch(`${baseUrl}/authorize`, {
      method: "POST",
      redirect: "manual",
      headers: {
        Origin: "https://runtime.example",
        "Tailscale-User-Login": "owner@example.com",
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({
        request: authorization.requestId as string,
        decision: "approve",
        passphrase: "dynamic enrollment phrase",
      }),
    });
    expect(approval.status).toBe(303);
    const code = new URL(
      approval.headers.get("location") ?? "",
    ).searchParams.get("code");
    expect(code).toMatch(/^acc_/);

    const token = await fetch(`${baseUrl}/oauth/token`, {
      method: "POST",
      headers: {
        Origin: appOrigin,
        "Tailscale-User-Login": "owner@example.com",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        code,
        codeVerifier: verifier,
        appId: "third-party-app",
        redirectUri,
      }),
    });
    expect(token.status).toBe(200);
    const grant = await token.json();

    const session = await fetch(`${baseUrl}/v1/app-sessions`, {
      method: "POST",
      headers: {
        Origin: appOrigin,
        "Tailscale-User-Login": "owner@example.com",
        Authorization: `Bearer ${grant.accessToken as string}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ appId: "third-party-app", tools: [tool()] }),
    });
    expect(session.status).toBe(201);
    expect(runtime.created).toEqual([
      expect.objectContaining({
        appId: "third-party-app",
        origin: appOrigin,
      }),
    ]);

    const substitutedOrigin = await fetch(`${baseUrl}/v1/app-sessions`, {
      method: "POST",
      headers: {
        Origin: "https://other-app.example",
        "Tailscale-User-Login": "owner@example.com",
        Authorization: `Bearer ${grant.accessToken as string}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ appId: "third-party-app", tools: [tool()] }),
    });
    expect(substitutedOrigin.status).toBe(401);

    const insecureOrigin = await fetch(`${baseUrl}/v1/runtime-challenges`, {
      method: "OPTIONS",
      headers: { Origin: "http://new-app.example" },
    });
    expect(insecureOrigin.status).toBe(403);
  });
});

async function start(
  overrides: Partial<Parameters<typeof createGateway>[0]> = {},
) {
  const directory = mkdtempSync(join(tmpdir(), "agent-connect-gateway-"));
  temporaryDirectories.push(directory);
  const server = createGateway({
    allowedOrigins: new Set(["https://preview.example"]),
    allowedTailscaleUsers: new Set(["owner@example.com"]),
    omnigentBaseUrl: "http://127.0.0.1:6767",
    authStatePath: join(directory, "gateway.json"),
    publicEndpoint: "https://runtime.example",
    enrollmentPassphrase: "test enrollment phrase",
    ...overrides,
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address() as AddressInfo;
  return { baseUrl: `http://127.0.0.1:${address.port}` };
}

function allowedHeaders(
  extra: Readonly<Record<string, string>> = {},
): Record<string, string> {
  return {
    Origin: "https://preview.example",
    "Tailscale-User-Login": "owner@example.com",
    ...extra,
  };
}

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

async function createAppSession(
  baseUrl: string,
  authorization: string,
  tools: readonly ReturnType<typeof tool>[] = [tool()],
) {
  return fetch(`${baseUrl}/v1/app-sessions`, {
    method: "POST",
    headers: allowedHeaders({
      Authorization: authorization,
      "Content-Type": "application/json",
    }),
    body: JSON.stringify({ appId: "test-app", tools }),
  });
}

class FakeRuntime implements AgentRuntime {
  readonly created: Array<{
    appId: string;
    origin: string;
    toolHash: string;
    approvedToolNames: readonly string[];
  }> = [];
  healthy = true;

  async createSession(request: {
    appId: string;
    origin: string;
    toolHash: string;
    approvedToolNames: readonly string[];
  }): Promise<string> {
    this.created.push(request);
    this.healthy = true;
    return `provider-${this.created.length}`;
  }

  async isHealthy(): Promise<boolean> {
    return this.healthy;
  }
}

async function sha256Base64Url(value: string): Promise<string> {
  return Buffer.from(
    await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)),
  ).toString("base64url");
}

async function pushAuthorization(
  baseUrl: string,
  overrides: Record<string, unknown> = {},
) {
  return fetch(`${baseUrl}/v1/authorization-requests`, {
    method: "POST",
    headers: allowedHeaders({ "Content-Type": "application/json" }),
    body: JSON.stringify({
      appId: "test-app",
      redirectUri: "https://preview.example/oauth/callback",
      state: "state_state_state_state",
      codeChallenge: await sha256Base64Url("v".repeat(43)),
      scopes: ["agent:prompt", "agent:result", "tools:invoke"],
      tools: [tool()],
      ...overrides,
    }),
  });
}

async function authorizeApp(baseUrl: string): Promise<string> {
  const pushed = await pushAuthorization(baseUrl);
  expect(pushed.status).toBe(201);
  const authorization = await pushed.json();
  const approval = await fetch(`${baseUrl}/authorize`, {
    method: "POST",
    redirect: "manual",
    headers: {
      "Tailscale-User-Login": "owner@example.com",
      Origin: "https://runtime.example",
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({
      request: authorization.requestId as string,
      decision: "approve",
      passphrase: "test enrollment phrase",
    }),
  });
  expect(approval.status).toBe(303);
  const code = new URL(approval.headers.get("location") ?? "").searchParams.get(
    "code",
  );
  expect(code).toMatch(/^acc_/);
  const token = await exchangeAuthorizationCode(
    baseUrl,
    code ?? "",
    "v".repeat(43),
  );
  expect(token.status).toBe(200);
  const grant = await token.json();
  return grant.accessToken as string;
}

function exchangeAuthorizationCode(
  baseUrl: string,
  code: string,
  codeVerifier: string,
) {
  return fetch(`${baseUrl}/oauth/token`, {
    method: "POST",
    headers: allowedHeaders({ "Content-Type": "application/json" }),
    body: JSON.stringify({
      code,
      codeVerifier,
      appId: "test-app",
      redirectUri: "https://preview.example/oauth/callback",
    }),
  });
}
