import type { AddressInfo } from "node:net";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { EnrollmentBundle } from "../src/connector-auth.js";
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
  it("answers an allowed CORS preflight without requiring identity", async () => {
    const { baseUrl } = await start();
    const response = await fetch(`${baseUrl}/v1/sessions/session-1/events`, {
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
    const response = await fetch(`${baseUrl}/v1/sessions/session-1/stream`, {
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
      const response = await fetch(`${baseUrl}/v1/sessions/session-1/stream`, {
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
    const upstream = vi.fn<typeof fetch>().mockResolvedValue(
      new Response("data: [DONE]\n\n", {
        headers: { "Content-Type": "text/event-stream" },
      }),
    );
    const { baseUrl } = await start({
      fetch: upstream,
      accessToken: "legacy-token",
    });
    const response = await fetch(`${baseUrl}/v1/sessions/session-1/stream`, {
      headers: allowedHeaders({ Authorization: "Bearer legacy-token" }),
    });

    expect(response.status).toBe(200);
    expect(upstream).toHaveBeenCalledTimes(1);
  });

  it("requires the configured bearer token", async () => {
    const { baseUrl } = await start({ accessToken: "correct horse" });
    const response = await fetch(`${baseUrl}/v1/sessions/session-1/stream`, {
      headers: allowedHeaders({ Authorization: "Bearer wrong" }),
    });

    expect(response.status).toBe(401);
  });

  it("does not expose raw provider sessions unless legacy mode is enabled", async () => {
    const upstream = vi.fn<typeof fetch>();
    const { baseUrl } = await start({ fetch: upstream });
    const response = await fetch(`${baseUrl}/v1/sessions/conv_secret/stream`, {
      headers: allowedHeaders(),
    });

    expect(response.status).toBe(404);
    expect(upstream).not.toHaveBeenCalled();
  });

  it("proxies only a valid session event route", async () => {
    const upstream = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(JSON.stringify({ accepted: true }), {
        status: 202,
        headers: { "Content-Type": "application/json" },
      }),
    );
    const { baseUrl } = await start({
      fetch: upstream,
      accessToken: "legacy-token",
    });
    const response = await fetch(`${baseUrl}/v1/sessions/session-1/events`, {
      method: "POST",
      headers: allowedHeaders({
        Authorization: "Bearer legacy-token",
        "Content-Type": "application/json",
      }),
      body: JSON.stringify({ type: "interrupt", data: {} }),
    });

    expect(response.status).toBe(202);
    expect(await response.json()).toEqual({ accepted: true });
    expect(upstream).toHaveBeenCalledWith(
      "http://127.0.0.1:6767/v1/sessions/session-1/events",
      expect.objectContaining({ method: "POST" }),
    );
  });
});

describe("managed application sessions", () => {
  it("exchanges a single-use code and hides the provider session id", async () => {
    const runtime = new FakeRuntime();
    const codes: string[] = [];
    const { baseUrl } = await start({
      runtime,
      pairingCode: "PAIR-ONCE",
      capabilitySigningSecret: "test-signing-secret",
      onPairingCodeGenerated: (code) => codes.push(code),
    });

    const response = await createAppSession(baseUrl, "Pairing PAIR-ONCE");
    expect(response.status).toBe(201);
    const created = await response.json();
    expect(created).toMatchObject({
      sessionId: expect.stringMatching(/^acs_/),
      accessToken: expect.any(String),
      toolHash: expect.any(String),
    });
    expect(JSON.stringify(created)).not.toContain("provider-1");
    expect(runtime.created).toHaveLength(1);
    expect(codes).toHaveLength(2);

    const replay = await createAppSession(baseUrl, "Pairing PAIR-ONCE");
    expect(replay.status).toBe(401);
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
      pairingCode: "PAIR-BOUND",
      capabilitySigningSecret: "test-signing-secret",
      allowedOrigins: new Set([
        "https://preview.example",
        "https://other.example",
      ]),
    });
    const paired = await createAppSession(baseUrl, "Pairing PAIR-BOUND");
    const created = await paired.json();
    const sessionUrl = `${baseUrl}/v1/sessions/${created.sessionId as string}`;

    const stream = await fetch(`${sessionUrl}/stream`, {
      headers: allowedHeaders({
        Authorization: `Bearer ${created.accessToken as string}`,
      }),
    });
    expect(stream.status).toBe(200);
    expect(upstream).toHaveBeenCalledWith(
      "http://127.0.0.1:6767/v1/sessions/provider-1/stream",
      expect.anything(),
    );

    const wrongOrigin = await fetch(`${sessionUrl}/stream`, {
      headers: {
        ...allowedHeaders({
          Authorization: `Bearer ${created.accessToken as string}`,
        }),
        Origin: "https://other.example",
      },
    });
    expect(wrongOrigin.status).toBe(401);

    const tampered = await fetch(`${sessionUrl}/stream`, {
      headers: allowedHeaders({
        Authorization: `Bearer ${created.accessToken as string}x`,
      }),
    });
    expect(tampered.status).toBe(401);

    upstream.mockClear();
    const mismatch = await fetch(`${sessionUrl}/events`, {
      method: "POST",
      headers: allowedHeaders({
        Authorization: `Bearer ${created.accessToken as string}`,
        "Content-Type": "application/json",
      }),
      body: JSON.stringify(messageEvent([{ ...tool(), name: "other_tool" }])),
    });
    expect(mismatch.status).toBe(403);
    expect(upstream).not.toHaveBeenCalled();

    const unknown = await fetch(`${sessionUrl}/events`, {
      method: "POST",
      headers: allowedHeaders({
        Authorization: `Bearer ${created.accessToken as string}`,
        "Content-Type": "application/json",
      }),
      body: JSON.stringify({ type: "approval", data: { approved: true } }),
    });
    expect(unknown.status).toBe(403);
    expect(upstream).not.toHaveBeenCalled();
  });

  it("reuses a healthy match and heals it when the provider goes offline", async () => {
    const runtime = new FakeRuntime();
    const upstream = vi.fn<typeof fetch>().mockResolvedValue(
      new Response("data: [DONE]\n\n", {
        headers: { "Content-Type": "text/event-stream" },
      }),
    );
    const { baseUrl } = await start({
      runtime,
      fetch: upstream,
      pairingCode: "PAIR-HEAL",
      capabilitySigningSecret: "test-signing-secret",
    });
    const first = await createAppSession(baseUrl, "Pairing PAIR-HEAL");
    const created = await first.json();

    const reused = await createAppSession(
      baseUrl,
      `Bearer ${created.accessToken as string}`,
    );
    expect(reused.status).toBe(201);
    expect((await reused.json()).sessionId).toBe(created.sessionId);
    expect(runtime.created).toHaveLength(1);

    runtime.healthy = false;
    const [stream, concurrentStream] = await Promise.all([
      fetch(`${baseUrl}/v1/sessions/${created.sessionId as string}/stream`, {
        headers: allowedHeaders({
          Authorization: `Bearer ${created.accessToken as string}`,
        }),
      }),
      fetch(`${baseUrl}/v1/sessions/${created.sessionId as string}/stream`, {
        headers: allowedHeaders({
          Authorization: `Bearer ${created.accessToken as string}`,
        }),
      }),
    ]);
    expect(stream.status).toBe(200);
    expect(concurrentStream.status).toBe(200);
    expect(runtime.created).toHaveLength(2);
    expect(upstream).toHaveBeenCalledWith(
      "http://127.0.0.1:6767/v1/sessions/provider-2/stream",
      expect.anything(),
    );
  });

  it("rejects expired capabilities and changed snapshots", async () => {
    let clock = Date.parse("2026-07-13T20:00:00Z");
    const runtime = new FakeRuntime();
    const { baseUrl } = await start({
      runtime,
      pairingCode: "PAIR-TIME",
      capabilitySigningSecret: "test-signing-secret",
      capabilityTtlSeconds: 10,
      now: () => clock,
    });
    const paired = await createAppSession(baseUrl, "Pairing PAIR-TIME");
    const created = await paired.json();

    const changed = await createAppSession(
      baseUrl,
      `Bearer ${created.accessToken as string}`,
      [{ ...tool(), description: "A changed capability" }],
    );
    expect(changed.status).toBe(401);

    clock += 11_000;
    const expired = await fetch(
      `${baseUrl}/v1/sessions/${created.sessionId as string}/stream`,
      {
        headers: allowedHeaders({
          Authorization: `Bearer ${created.accessToken as string}`,
        }),
      },
    );
    expect(expired.status).toBe(401);
  });
});

describe("connector enrollment and app authorization", () => {
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

    // Enabling durable connector authorization removes the legacy terminal
    // pairing path; otherwise it would bypass connector-owned consent.
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
    const revoked = await fetch(
      `${baseUrl}/v1/sessions/${applicationSession.sessionId as string}/stream`,
      {
        headers: allowedHeaders({
          Authorization: `Bearer ${applicationSession.accessToken as string}`,
        }),
      },
    );
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

  it("cannot be enabled for the anonymous public-demo profile", () => {
    expect(() =>
      createGateway({
        allowedOrigins: new Set(),
        dynamicAppEnrollment: true,
        allowedTailscaleUsers: new Set(),
        omnigentBaseUrl: "http://127.0.0.1:6767",
        authStatePath: "/tmp/unused-agent-connect-state.json",
        publicEndpoint: "https://runtime.example",
        transportProfile: "public-demo",
        publicDemoAuthorities: [demoAuthority()],
      }),
    ).toThrow(
      "dynamic app enrollment requires the tailscale-serve transport profile",
    );
  });
});

describe("public-demo transport profile", () => {
  it("uses connector enrollment without requiring or trusting a Tailscale identity", async () => {
    const directory = mkdtempSync(join(tmpdir(), "agent-connect-public-demo-"));
    temporaryDirectories.push(directory);
    const runtime = new FakeRuntime();
    const { baseUrl } = await start({
      runtime,
      allowedTailscaleUsers: new Set(),
      authStatePath: join(directory, "connector.json"),
      publicEndpoint: "https://runtime.example",
      transportProfile: "public-demo",
      publicDemoAuthorities: [demoAuthority()],
      enrollmentPassphrase: "public demo enrollment phrase",
    });

    const challenge = await fetch(`${baseUrl}/v1/runtime-challenges`, {
      method: "POST",
      headers: {
        Origin: "https://preview.example",
        "Tailscale-User-Login": "attacker@example.com",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ nonce: "0123456789abcdef" }),
    });
    expect(challenge.status).toBe(200);

    const pushed = await pushPublicDemoAuthorization(baseUrl);
    expect(pushed.status).toBe(201);
    const authorization = await pushed.json();
    const consent = await fetch(
      `${baseUrl}/authorize?request=${encodeURIComponent(authorization.requestId as string)}`,
    );
    expect(consent.status).toBe(200);

    const approval = await fetch(`${baseUrl}/authorize`, {
      method: "POST",
      redirect: "manual",
      headers: {
        Origin: "https://runtime.example",
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({
        request: authorization.requestId as string,
        decision: "approve",
        passphrase: "public demo enrollment phrase",
      }),
    });
    expect(approval.status).toBe(303);
    const deviceCookie = approval.headers.get("set-cookie")?.split(";")[0];
    expect(deviceCookie).toMatch(/^agent_connect_device=/);

    const anonymousGrants = await fetch(`${baseUrl}/v1/grants`, {
      headers: { "Tailscale-User-Login": "owner@example.com" },
    });
    expect(anonymousGrants.status).toBe(401);
    expect(await anonymousGrants.json()).toEqual({
      error: "device_not_enrolled",
    });

    const enrolledGrants = await fetch(`${baseUrl}/v1/grants`, {
      headers: { Cookie: deviceCookie ?? "" },
    });
    expect(enrolledGrants.status).toBe(200);

    const code = new URL(
      approval.headers.get("location") ?? "",
    ).searchParams.get("code");
    const token = await fetch(`${baseUrl}/oauth/token`, {
      method: "POST",
      headers: {
        Origin: "https://preview.example",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        code,
        codeVerifier: "v".repeat(43),
        appId: "agent-connect-demo",
        redirectUri: "https://preview.example/",
      }),
    });
    expect(token.status).toBe(200);
    const granted = await token.json();

    const session = await fetch(`${baseUrl}/v1/app-sessions`, {
      method: "POST",
      headers: {
        Origin: "https://preview.example",
        Authorization: `Bearer ${granted.accessToken as string}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ appId: "agent-connect-demo", tools: [tool()] }),
    });
    expect(session.status).toBe(201);
    expect(runtime.created).toHaveLength(1);
  });

  it.each([
    ["app id", { appId: "another-app" }],
    ["redirect URI", { redirectUri: "https://preview.example/other" }],
    [
      "tool snapshot",
      { tools: [{ ...tool(), description: "Changed authority" }] },
    ],
  ])("rejects a mismatched fixed %s before consent", async (_case, change) => {
    const directory = mkdtempSync(join(tmpdir(), "agent-connect-public-demo-"));
    temporaryDirectories.push(directory);
    const { baseUrl } = await start({
      allowedTailscaleUsers: new Set(),
      authStatePath: join(directory, "connector.json"),
      publicEndpoint: "https://runtime.example",
      transportProfile: "public-demo",
      publicDemoAuthorities: [demoAuthority()],
      enrollmentPassphrase: "public demo enrollment phrase",
    });

    const response = await pushPublicDemoAuthorization(baseUrl, change);
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({
      error: "public_demo_authority_mismatch",
    });
  });

  it("requires explicit fixed authority configuration", () => {
    expect(() =>
      createGateway({
        allowedOrigins: new Set(["https://preview.example"]),
        allowedTailscaleUsers: new Set(),
        omnigentBaseUrl: "http://127.0.0.1:6767",
        transportProfile: "public-demo",
      }),
    ).toThrow("public-demo requires an exact configured application authority");
  });

  it("accepts a second explicitly configured preview callback", async () => {
    const directory = mkdtempSync(join(tmpdir(), "agent-connect-public-demo-"));
    temporaryDirectories.push(directory);
    const { baseUrl } = await start({
      allowedOrigins: new Set([
        "https://preview.example",
        "https://second-preview.example",
      ]),
      allowedTailscaleUsers: new Set(),
      authStatePath: join(directory, "connector.json"),
      publicEndpoint: "https://runtime.example",
      transportProfile: "public-demo",
      publicDemoAuthorities: [
        demoAuthority(),
        {
          ...demoAuthority(),
          redirectUri: "https://second-preview.example/",
        },
      ],
      enrollmentPassphrase: "public demo enrollment phrase",
    });

    const response = await pushPublicDemoAuthorization(
      baseUrl,
      { redirectUri: "https://second-preview.example/" },
      "https://second-preview.example",
    );
    expect(response.status).toBe(201);
  });
});

async function start(
  overrides: Partial<Parameters<typeof createGateway>[0]> = {},
) {
  const server = createGateway({
    allowedOrigins: new Set(["https://preview.example"]),
    allowedTailscaleUsers: new Set(["owner@example.com"]),
    omnigentBaseUrl: "http://127.0.0.1:6767",
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

function demoAuthority() {
  return {
    appId: "agent-connect-demo",
    redirectUri: "https://preview.example/",
    toolHash: hashToolSnapshot([tool()]),
  };
}

function messageEvent(tools: readonly ReturnType<typeof tool>[]) {
  return {
    type: "message",
    data: {
      role: "user",
      content: [{ type: "input_text", text: "Update the page" }],
    },
    tools: tools.map((item) => ({
      type: "function",
      function: {
        name: item.name,
        description: item.description,
        parameters: item.inputSchema,
      },
    })),
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

async function pushPublicDemoAuthorization(
  baseUrl: string,
  overrides: Record<string, unknown> = {},
  origin = "https://preview.example",
) {
  return fetch(`${baseUrl}/v1/authorization-requests`, {
    method: "POST",
    headers: {
      Origin: origin,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      appId: "agent-connect-demo",
      redirectUri: "https://preview.example/",
      state: "state_state_state_state",
      codeChallenge: await sha256Base64Url("v".repeat(43)),
      scopes: ["agent:prompt", "agent:result", "tools:invoke"],
      tools: [tool()],
      ...overrides,
    }),
  });
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
