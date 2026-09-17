import { createServer, type Server } from "node:http";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { OwnerAuth } from "../src/owner-auth.js";
import {
  DelegatedGrantService,
  type DelegatedGrantStore,
} from "../src/delegated-grants.js";
import { AGENT_CONNECT_OPENCLAW_PLUGIN_ENDPOINT_LAYOUT } from "../src/authorization/contracts.js";
import { createAgentConnectHandler } from "../src/runtime/handler.js";

const ISSUER = "https://openclaw.example/agent-connect";
const ORIGIN = "https://openclaw.example";
const RESOURCE = `${ORIGIN}/agent-connect/v1/responses`;
const CLIENT_ID = "https://reader.example";
const PASSPHRASE = "owner console test passphrase";

class MemoryStore implements DelegatedGrantStore {
  value: unknown;

  load(): unknown | undefined {
    return structuredClone(this.value);
  }

  save(value: unknown): void {
    this.value = structuredClone(value);
  }
}

describe("owner authorization surface", () => {
  const cleanups: Array<() => Promise<void> | void> = [];

  afterEach(async () => {
    while (cleanups.length) await cleanups.pop()?.();
  });

  it("expires owner browser sessions after 30 days by default", async () => {
    const directory = mkdtempSync(join(tmpdir(), "agent-connect-owner-ttl-"));
    cleanups.push(() => rmSync(directory, { recursive: true, force: true }));
    let now = Date.UTC(2026, 8, 16);
    const ownerAuth = new OwnerAuth({
      statePath: join(directory, "owner.json"),
      enrollmentPassphrase: PASSPHRASE,
      now: () => now,
    });
    const token = await ownerAuth.enrollOwnerSession(PASSPHRASE, "local-owner");

    now += 30 * 24 * 60 * 60 * 1000 - 1;
    expect(ownerAuth.isOwnerSession(token, "local-owner")).toBe(true);
    now += 1;
    expect(ownerAuth.isOwnerSession(token, "local-owner")).toBe(false);
  });

  it("revokes only the matching owner session and persists the result", async () => {
    const directory = mkdtempSync(
      join(tmpdir(), "agent-connect-owner-revoke-"),
    );
    cleanups.push(() => rmSync(directory, { recursive: true, force: true }));
    const statePath = join(directory, "owner.json");
    const ownerAuth = new OwnerAuth({
      statePath,
      enrollmentPassphrase: PASSPHRASE,
    });
    const token = await ownerAuth.enrollOwnerSession(PASSPHRASE, "local-owner");

    expect(
      ownerAuth.revokeOwnerSession("not-an-owner-session", "local-owner"),
    ).toBe(false);
    expect(ownerAuth.revokeOwnerSession(token, "different-owner")).toBe(false);
    expect(ownerAuth.revokeOwnerSession(token, "local-owner")).toBe(true);
    expect(ownerAuth.revokeOwnerSession(token, "local-owner")).toBe(false);

    const reloaded = new OwnerAuth({ statePath });
    expect(reloaded.isOwnerSession(token, "local-owner")).toBe(false);
  });

  it("bounds concurrent enrollment-passphrase verification", async () => {
    const directory = mkdtempSync(
      join(tmpdir(), "agent-connect-owner-concurrency-"),
    );
    cleanups.push(() => rmSync(directory, { recursive: true, force: true }));
    const ownerAuth = new OwnerAuth({
      statePath: join(directory, "owner.json"),
      enrollmentPassphrase: PASSPHRASE,
    });

    const attempts = await Promise.allSettled([
      ownerAuth.enrollOwnerSession(PASSPHRASE, "owner-one"),
      ownerAuth.enrollOwnerSession(PASSPHRASE, "owner-two"),
      ownerAuth.enrollOwnerSession(PASSPHRASE, "owner-three"),
    ]);

    expect(
      attempts.filter(({ status }) => status === "fulfilled"),
    ).toHaveLength(2);
    expect(attempts.filter(({ status }) => status === "rejected")).toEqual([
      expect.objectContaining({
        reason: expect.objectContaining({ code: "enrollment_busy" }),
      }),
    ]);
  });

  it("migrates the current combined state into owner-only state", async () => {
    const directory = mkdtempSync(join(tmpdir(), "agent-connect-owner-state-"));
    cleanups.push(() => rmSync(directory, { recursive: true, force: true }));
    const statePath = join(directory, "owner.json");
    const original = new OwnerAuth({
      statePath,
      enrollmentPassphrase: PASSPHRASE,
    });
    const ownerToken = await original.enrollOwnerSession(
      PASSPHRASE,
      "local-owner",
    );
    const current = JSON.parse(readFileSync(statePath, "utf8")) as {
      enrollmentSalt: string;
      enrollmentVerifier: string;
      ownerSessions: Array<{
        id: string;
        tokenHash: string;
        ownerSubject: string;
        createdAt: number;
        expiresAt: number;
      }>;
    };
    writeFileSync(
      statePath,
      JSON.stringify({
        version: 2,
        runtimeId: "retired-runtime-id",
        connectorPrivateKey: { kty: "OKP" },
        connectorPublicKey: { kty: "OKP" },
        enrollmentSalt: current.enrollmentSalt,
        enrollmentVerifier: current.enrollmentVerifier,
        capabilitySigningSecret: "retired-signing-secret",
        grants: [{ id: "retired-grant" }],
        ownerSessions: current.ownerSessions,
      }),
    );

    const migrated = new OwnerAuth({
      statePath,
    });
    expect(migrated.isOwnerSession(ownerToken, "local-owner")).toBe(true);
    await migrated.enrollOwnerSession(PASSPHRASE, "second-owner-session");
    const persisted = JSON.parse(readFileSync(statePath, "utf8")) as {
      kind: string;
      version: number;
      ownerSessions: Array<{ id: string; tokenHash: string }>;
      runtimeId?: unknown;
      grants?: unknown;
    };
    expect(persisted).toMatchObject({
      kind: "agent-connect-owner-auth",
      version: 1,
    });
    expect(persisted.runtimeId).toBeUndefined();
    expect(persisted.grants).toBeUndefined();
    expect(persisted.ownerSessions).toHaveLength(2);
    expect(
      persisted.ownerSessions.every(({ id }) => id.startsWith("owner_")),
    ).toBe(true);
  });

  it("keeps enrollment, consent and console in one authenticated surface", async () => {
    const fixture = await startFixture();
    const pending = fixture.grants.createRequest({
      clientId: CLIENT_ID,
      redirectUri: `${CLIENT_ID}/connect/callback`,
      resource: RESOURCE,
      state: "opaque-state-1234",
      codeChallenge: "a".repeat(43),
      codeChallengeMethod: "S256",
      applicationTools: [
        {
          name: "add_note",
          description: "Add a note",
          inputSchema: { type: "object", properties: {} },
        },
      ],
    });
    const authorizePath = `${AGENT_CONNECT_OPENCLAW_PLUGIN_ENDPOINT_LAYOUT.authorizationPath}?${new URLSearchParams({ client_id: CLIENT_ID, request_uri: pending.requestUri })}`;

    const signIn = await fetch(`${fixture.baseUrl}${authorizePath}`);
    const signInHtml = await signIn.text();
    expect(signIn.status).toBe(401);
    expect(signIn.headers.get("cache-control")).toBe("no-store");
    expect(signIn.headers.get("content-security-policy")).toContain(
      "style-src 'unsafe-inline'",
    );
    expect(signInHtml).toContain("reader.example");
    expect(signInHtml).toContain("Agent Connect");

    const wrong = await postLogin(
      fixture.baseUrl,
      hiddenValue(signInHtml, "challenge"),
      "wrong passphrase",
    );
    const wrongHtml = await wrong.text();
    expect(wrong.status).toBe(403);
    expect(wrongHtml).toContain("was not accepted");
    expect(wrongHtml).toContain("reader.example");

    const authenticated = await postLogin(
      fixture.baseUrl,
      hiddenValue(wrongHtml, "challenge"),
      PASSPHRASE,
    );
    expect(authenticated.status).toBe(303);
    expect(authenticated.headers.get("location")).toBe(authorizePath);
    const cookie = authenticated.headers.get("set-cookie")?.split(";", 1)[0];
    expect(cookie).toMatch(/^agent_connect_owner=aco_/);
    expect(authenticated.headers.get("set-cookie")).toContain(
      "Max-Age=2592000",
    );

    const consent = await fetch(`${fixture.baseUrl}${authorizePath}`, {
      headers: { cookie: cookie as string },
    });
    const consentHtml = await consent.text();
    expect(consent.status).toBe(200);
    expect(consentHtml).toContain("Review access");
    expect(consentHtml).toContain("Application tools");
    expect(consentHtml).toContain("Native OpenClaw capabilities");
    expect(consentHtml).toContain("Allow access");
    expect(consentHtml).toContain("Cancel");
    expect(consentHtml).toContain('class="brand"');

    const consolePage = await fetch(
      `${fixture.baseUrl}${AGENT_CONNECT_OPENCLAW_PLUGIN_ENDPOINT_LAYOUT.ownerConsolePath}`,
      { headers: { cookie: cookie as string } },
    );
    const consoleHtml = await consolePage.text();
    expect(consolePage.status).toBe(200);
    expect(consolePage.headers.get("cache-control")).toBe("no-store");
    expect(consoleHtml).toContain("Application access");
    expect(consoleHtml).toContain("No active application access");
    expect(consoleHtml).toContain("Application tools only");
    expect(consoleHtml).not.toContain("last use");
  });

  it("does not turn an unvalidated client identifier into a cancel link", async () => {
    const fixture = await startFixture();
    const authorizePath = `${AGENT_CONNECT_OPENCLAW_PLUGIN_ENDPOINT_LAYOUT.authorizationPath}?${new URLSearchParams(
      {
        client_id: "javascript:alert(1)",
        request_uri: `${ORIGIN}/agent-connect/requests/unvalidated`,
      },
    )}`;

    const signIn = await fetch(`${fixture.baseUrl}${authorizePath}`);
    const html = await signIn.text();
    expect(signIn.status).toBe(401);
    expect(html).not.toContain("javascript:alert(1)");
    expect(html).not.toContain('class="text-link">Cancel</a>');
  });

  it("revokes through owner authentication, same origin and one-use CSRF", async () => {
    const fixture = await startFixture();
    const request = fixture.grants.createRequest({
      clientId: CLIENT_ID,
      redirectUri: `${CLIENT_ID}/connect/callback`,
      resource: RESOURCE,
      state: "opaque-state-1234",
      codeChallenge: "a".repeat(43),
      codeChallengeMethod: "S256",
      applicationTools: [],
    });
    const approved = fixture.grants.approve(request.requestUri, {
      ownerSubject: "openclaw-profile:local-owner",
      policyRef: "application-tools-only",
    });
    const cookie = await ownerCookie(fixture.baseUrl);
    const consolePage = await fetch(
      `${fixture.baseUrl}${AGENT_CONNECT_OPENCLAW_PLUGIN_ENDPOINT_LAYOUT.ownerConsolePath}`,
      { headers: { cookie } },
    );
    const html = await consolePage.text();
    const csrf = hiddenValue(html, "csrf_token");
    expect(hiddenValue(html, "grant_id")).toBe(approved.grant.grantId);
    expect(html).not.toContain("accessTokenHash");
    expect(html).not.toContain("refreshTokenHash");

    const crossOrigin = await postRevoke(
      fixture.baseUrl,
      cookie,
      approved.grant.grantId,
      csrf,
      CLIENT_ID,
    );
    expect(crossOrigin.status).toBe(403);

    const revoked = await postRevoke(
      fixture.baseUrl,
      cookie,
      approved.grant.grantId,
      csrf,
      ORIGIN,
    );
    expect(revoked.status).toBe(303);
    expect(revoked.headers.get("location")).toBe(
      AGENT_CONNECT_OPENCLAW_PLUGIN_ENDPOINT_LAYOUT.ownerConsolePath,
    );
    expect(fixture.grants.listGrants()[0]?.revokedAt).toBeDefined();

    const replay = await postRevoke(
      fixture.baseUrl,
      cookie,
      approved.grant.grantId,
      csrf,
      ORIGIN,
    );
    expect(replay.status).toBe(403);
  });

  it("revokes every active application grant without forgetting the browser", async () => {
    const fixture = await startFixture();
    for (const suffix of ["one", "two"]) {
      const request = fixture.grants.createRequest({
        clientId: `https://${suffix}.example`,
        redirectUri: `https://${suffix}.example/connect/callback`,
        resource: RESOURCE,
        state: `opaque-state-${suffix}`,
        codeChallenge: suffix.repeat(22).slice(0, 43),
        codeChallengeMethod: "S256",
        applicationTools: [],
      });
      fixture.grants.approve(request.requestUri, {
        ownerSubject: "openclaw-profile:local-owner",
        policyRef: "application-tools-only",
      });
    }
    const cookie = await ownerCookie(fixture.baseUrl);
    const consoleResponse = await fetch(
      `${fixture.baseUrl}${AGENT_CONNECT_OPENCLAW_PLUGIN_ENDPOINT_LAYOUT.ownerConsolePath}`,
      { headers: { cookie } },
    );
    const html = await consoleResponse.text();
    const csrf = hiddenValueForAction(
      html,
      AGENT_CONNECT_OPENCLAW_PLUGIN_ENDPOINT_LAYOUT.ownerRevokeAllPath,
      "csrf_token",
    );

    const revoked = await postOwnerAction(
      fixture.baseUrl,
      AGENT_CONNECT_OPENCLAW_PLUGIN_ENDPOINT_LAYOUT.ownerRevokeAllPath,
      cookie,
      csrf,
    );
    expect(revoked.status).toBe(303);
    expect(fixture.grants.listGrants().every((grant) => grant.revokedAt)).toBe(
      true,
    );
    const stillSignedIn = await fetch(
      `${fixture.baseUrl}${AGENT_CONNECT_OPENCLAW_PLUGIN_ENDPOINT_LAYOUT.ownerConsolePath}`,
      { headers: { cookie } },
    );
    expect(stillSignedIn.status).toBe(200);

    const replay = await postOwnerAction(
      fixture.baseUrl,
      AGENT_CONNECT_OPENCLAW_PLUGIN_ENDPOINT_LAYOUT.ownerRevokeAllPath,
      cookie,
      csrf,
    );
    expect(replay.status).toBe(403);
  });

  it("forgets the owner browser without revoking application grants", async () => {
    const fixture = await startFixture();
    const request = fixture.grants.createRequest({
      clientId: CLIENT_ID,
      redirectUri: `${CLIENT_ID}/connect/callback`,
      resource: RESOURCE,
      state: "opaque-state-forget",
      codeChallenge: "f".repeat(43),
      codeChallengeMethod: "S256",
      applicationTools: [],
    });
    fixture.grants.approve(request.requestUri, {
      ownerSubject: "openclaw-profile:local-owner",
      policyRef: "application-tools-only",
    });
    const cookie = await ownerCookie(fixture.baseUrl);
    const consoleResponse = await fetch(
      `${fixture.baseUrl}${AGENT_CONNECT_OPENCLAW_PLUGIN_ENDPOINT_LAYOUT.ownerConsolePath}`,
      { headers: { cookie } },
    );
    const csrf = hiddenValueForAction(
      await consoleResponse.text(),
      AGENT_CONNECT_OPENCLAW_PLUGIN_ENDPOINT_LAYOUT.ownerForgetPath,
      "csrf_token",
    );

    const forgotten = await postOwnerAction(
      fixture.baseUrl,
      AGENT_CONNECT_OPENCLAW_PLUGIN_ENDPOINT_LAYOUT.ownerForgetPath,
      cookie,
      csrf,
    );
    expect(forgotten.status).toBe(200);
    expect(forgotten.headers.get("set-cookie")).toContain("Max-Age=0");
    expect(await forgotten.text()).toContain("This browser has been forgotten");
    expect(fixture.grants.listGrants()[0]?.revokedAt).toBeUndefined();

    const oldSession = await fetch(
      `${fixture.baseUrl}${AGENT_CONNECT_OPENCLAW_PLUGIN_ENDPOINT_LAYOUT.ownerConsolePath}`,
      { headers: { cookie } },
    );
    expect(oldSession.status).toBe(401);
  });

  async function startFixture(): Promise<{
    baseUrl: string;
    grants: DelegatedGrantService;
  }> {
    const directory = mkdtempSync(join(tmpdir(), "agent-connect-owner-ui-"));
    const ownerAuth = new OwnerAuth({
      statePath: join(directory, "owner.json"),
      enrollmentPassphrase: PASSPHRASE,
    });
    const grants = new DelegatedGrantService({
      resource: RESOURCE,
      store: new MemoryStore(),
      offeredPolicies: [
        {
          ref: "application-tools-only",
          label: "Application tools only",
          description: "Use only tools supplied by the application",
          agentId: "restricted-agent",
          fingerprint: "sha256:policy",
          nativeCapabilities: [],
        },
      ],
    });
    const handler = createAgentConnectHandler({
      issuer: ISSUER,
      resource: RESOURCE,
      upstreamBaseUrl: "http://127.0.0.1:1",
      upstreamAuth: { mode: "none" },
      grantService: grants,
      ownerAuth,
      policySnapshot: {
        assertUnchanged() {},
        async assertRuntimeCurrent() {},
      },
      endpoints: AGENT_CONNECT_OPENCLAW_PLUGIN_ENDPOINT_LAYOUT,
    });
    const server: Server = createServer((request, response) => {
      void handler.handle(request, response);
    });
    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", resolve),
    );
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("no address");
    cleanups.push(async () => {
      await handler.close();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      rmSync(directory, { recursive: true, force: true });
    });
    return {
      baseUrl: `http://127.0.0.1:${address.port}`,
      grants,
    };
  }

  async function ownerCookie(baseUrl: string): Promise<string> {
    const page = await fetch(
      `${baseUrl}${AGENT_CONNECT_OPENCLAW_PLUGIN_ENDPOINT_LAYOUT.ownerConsolePath}`,
    );
    const response = await postLogin(
      baseUrl,
      hiddenValue(await page.text(), "challenge"),
      PASSPHRASE,
    );
    return response.headers.get("set-cookie")?.split(";", 1)[0] as string;
  }
});

async function postLogin(
  baseUrl: string,
  challenge: string,
  passphrase: string,
): Promise<Response> {
  return fetch(
    `${baseUrl}${AGENT_CONNECT_OPENCLAW_PLUGIN_ENDPOINT_LAYOUT.ownerLoginPath}`,
    {
      method: "POST",
      redirect: "manual",
      headers: {
        origin: ORIGIN,
        "content-type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({ challenge, passphrase }),
    },
  );
}

async function postRevoke(
  baseUrl: string,
  cookie: string,
  grantId: string,
  csrfToken: string,
  origin: string,
): Promise<Response> {
  return fetch(
    `${baseUrl}${AGENT_CONNECT_OPENCLAW_PLUGIN_ENDPOINT_LAYOUT.ownerRevokePath}`,
    {
      method: "POST",
      redirect: "manual",
      headers: {
        cookie,
        origin,
        "content-type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({ grant_id: grantId, csrf_token: csrfToken }),
    },
  );
}

async function postOwnerAction(
  baseUrl: string,
  path: string,
  cookie: string,
  csrfToken: string,
): Promise<Response> {
  return fetch(`${baseUrl}${path}`, {
    method: "POST",
    redirect: "manual",
    headers: {
      cookie,
      origin: ORIGIN,
      "content-type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({ csrf_token: csrfToken }),
  });
}

function hiddenValue(html: string, name: string): string {
  const value = html.match(
    new RegExp(`name=["']${name}["'][^>]*value=["']([^"']+)["']`),
  )?.[1];
  if (!value) throw new Error(`missing ${name}`);
  return value;
}

function hiddenValueForAction(
  html: string,
  action: string,
  name: string,
): string {
  const escapedAction = action.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const form = html.match(
    new RegExp(
      `<form[^>]*action=["']${escapedAction}["'][^>]*>([\\s\\S]*?)<\\/form>`,
    ),
  )?.[1];
  if (!form) throw new Error(`missing form action ${action}`);
  return hiddenValue(form, name);
}
