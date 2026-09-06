import { createHash } from "node:crypto";
import { createServer, type Server } from "node:http";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  DelegatedGrantService,
  type DelegatedGrantStore,
} from "../src/delegated-grants.js";
import { createOpenResponsesApplicationAuthProvider } from "../src/openclaw-plugin/application-auth.js";
import { FIXED_TOOLS_AUTHORIZATION_DETAIL } from "../src/openclaw-plugin/contracts.js";
import { OpenClawOAuthHandler } from "../src/openclaw-plugin/oauth-handler.js";

const ISSUER = "https://openclaw.example";
const RESOURCE = `${ISSUER}/v1/responses`;
const CLIENT_ID = "https://bookhand.example";
const REDIRECT_URI = `${CLIENT_ID}/connect/callback`;
const VERIFIER = "correct-horse-battery-staple-correct-horse-battery";
const TOOL = {
  name: "add_note",
  description: "Add a note to the open book",
  inputSchema: {
    type: "object",
    properties: { text: { type: "string" } },
    required: ["text"],
    additionalProperties: false,
  },
};

class MemoryStore implements DelegatedGrantStore {
  value: unknown;
  load(): unknown | undefined {
    return structuredClone(this.value);
  }
  save(value: unknown): void {
    this.value = structuredClone(value);
  }
}

describe("OpenClaw provider OAuth plugin", () => {
  let server: Server;
  let baseUrl: string;
  let grants: DelegatedGrantService;

  beforeEach(async () => {
    grants = new DelegatedGrantService({
      resource: RESOURCE,
      store: new MemoryStore(),
      offeredPolicies: [
        {
          ref: "internal-app-tools",
          label: "Application tools only",
          agentId: "bookhand-agent",
          fingerprint: "sha256:app-tools",
          nativeCapabilities: [],
        },
        {
          ref: "internal-research",
          label: "Research helper",
          description: "Also allow public web search",
          agentId: "bookhand-agent",
          fingerprint: "sha256:research",
          nativeCapabilities: ["public_web_search"],
        },
      ],
    });
    const handler = new OpenClawOAuthHandler({
      issuer: ISSUER,
      resource: RESOURCE,
      grantService: grants,
      allowedOwnerProfileIds: ["owner-profile", "second-owner"],
      ownerVerifier: ({ headers }) => {
        const profileId = headers["x-test-owner"];
        const scopes = headers["x-test-scopes"];
        return typeof profileId === "string" && typeof scopes === "string"
          ? { profileId, scopes: scopes.split(" ") }
          : undefined;
      },
    });
    server = createServer((request, response) => {
      void handler.handle(request, response);
    });
    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", resolve),
    );
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("no address");
    baseUrl = `http://127.0.0.1:${address.port}`;
  });

  afterEach(async () => {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  });

  it("advertises only the implemented public-client S256 PAR surface", async () => {
    const authorization = await jsonGet(
      `${baseUrl}/.well-known/oauth-authorization-server`,
    );
    expect(authorization).toMatchObject({
      issuer: ISSUER,
      authorization_endpoint: `${ISSUER}/agent-connect/oauth/authorize`,
      token_endpoint: `${ISSUER}/agent-connect/oauth/token`,
      revocation_endpoint: `${ISSUER}/agent-connect/oauth/revoke`,
      pushed_authorization_request_endpoint: `${ISSUER}/agent-connect/oauth/par`,
      response_types_supported: ["code"],
      grant_types_supported: ["authorization_code", "refresh_token"],
      token_endpoint_auth_methods_supported: ["none"],
      code_challenge_methods_supported: ["S256"],
      scopes_supported: ["responses"],
      authorization_details_types_supported: ["agent_connect"],
      require_pushed_authorization_requests: true,
      authorization_response_iss_parameter_supported: true,
    });
    const protectedResource = await jsonGet(
      `${baseUrl}/.well-known/oauth-protected-resource`,
    );
    expect(protectedResource).toEqual({
      resource: RESOURCE,
      authorization_servers: [ISSUER],
      scopes_supported: ["responses"],
      bearer_methods_supported: ["header"],
      authorization_details_types_supported: ["agent_connect"],
      agent_connect_model: "openclaw/default",
    });
  });

  it("requires verified configured owner consent, one-use CSRF and same origin", async () => {
    const requestUri = await createPar(baseUrl);
    const authorizeUrl = `${baseUrl}/agent-connect/oauth/authorize?${new URLSearchParams({ client_id: CLIENT_ID, request_uri: requestUri })}`;

    const forged = await fetch(authorizeUrl, {
      headers: { "tailscale-user-login": "owner@example.com" },
    });
    expect(forged.status).toBe(401);
    expect(forged.headers.get("access-control-allow-origin")).toBeNull();

    const wrongProfile = await ownerGet(authorizeUrl, "unlisted-profile");
    expect(wrongProfile.status).toBe(401);
    const noAdmin = await ownerGet(
      authorizeUrl,
      "owner-profile",
      "operator.read",
    );
    expect(noAdmin.status).toBe(401);

    const shown = await ownerGet(authorizeUrl);
    const html = await shown.text();
    expect(shown.status).toBe(200);
    expect(shown.headers.get("content-security-policy")).toContain(
      "frame-ancestors 'none'",
    );
    expect(shown.headers.get("x-frame-options")).toBe("DENY");
    expect(html).toContain(CLIENT_ID);
    expect(html).toContain("add_note");
    expect(html).toContain("Public web search");
    expect(html).not.toContain("internal-research");
    expect(html).toContain('value="0" checked');
    const csrf = hiddenValue(html, "csrf_token");

    const crossOrigin = await ownerPost(
      `${baseUrl}/agent-connect/oauth/authorize`,
      {
        request_uri: requestUri,
        csrf_token: csrf,
        decision: "allow",
        policy_choice: "0",
      },
      CLIENT_ID,
    );
    expect(crossOrigin.status).toBe(403);

    const wrongCsrf = await ownerPost(
      `${baseUrl}/agent-connect/oauth/authorize`,
      {
        request_uri: requestUri,
        csrf_token: `${csrf}wrong`,
        decision: "allow",
        policy_choice: "0",
      },
      ISSUER,
    );
    expect(wrongCsrf.status).toBe(403);

    const replay = await ownerPost(
      `${baseUrl}/agent-connect/oauth/authorize`,
      {
        request_uri: requestUri,
        csrf_token: csrf,
        decision: "allow",
        policy_choice: "0",
      },
      ISSUER,
    );
    expect(replay.status).toBe(403);
    expect(grants.getRequest(requestUri)).toBeDefined();

    const ownerBoundRequest = await createPar(baseUrl);
    const ownerBoundPage = await ownerGet(
      `${baseUrl}/agent-connect/oauth/authorize?${new URLSearchParams({ client_id: CLIENT_ID, request_uri: ownerBoundRequest })}`,
    );
    const ownerBoundCsrf = hiddenValue(
      await ownerBoundPage.text(),
      "csrf_token",
    );
    const ownerSwap = await ownerPost(
      `${baseUrl}/agent-connect/oauth/authorize`,
      {
        request_uri: ownerBoundRequest,
        csrf_token: ownerBoundCsrf,
        decision: "allow",
        policy_choice: "0",
      },
      ISSUER,
      "second-owner",
    );
    expect(ownerSwap.status).toBe(403);
  });

  it("issues origin-bound tokens, refreshes, rechecks tools and revokes", async () => {
    const { requestUri, code } = await approve(baseUrl);
    expect(grants.getRequest(requestUri)).toBeUndefined();
    const tokenResponse = await postForm(
      `${baseUrl}/agent-connect/oauth/token`,
      {
        grant_type: "authorization_code",
        code,
        code_verifier: VERIFIER,
        client_id: CLIENT_ID,
        redirect_uri: REDIRECT_URI,
        resource: RESOURCE,
      },
      CLIENT_ID,
    );
    expect(tokenResponse.status).toBe(200);
    expect(tokenResponse.headers.get("access-control-allow-origin")).toBe(
      CLIENT_ID,
    );
    const token = (await tokenResponse.json()) as {
      access_token: string;
      refresh_token: string;
      scope: string;
    };
    expect(token.scope).toBe("responses");

    const provider = createOpenResponsesApplicationAuthProvider({
      resource: RESOURCE,
      grantService: grants,
    });
    expect(
      provider.authenticate({
        headers: {
          authorization: `Bearer ${token.access_token}`,
          origin: "https://other.example",
        },
      }),
    ).toMatchObject({ status: "deny" });
    expect(
      provider.authenticate({
        headers: {
          authorization: `Bearer ${token.access_token} malformed`,
        },
      }),
    ).toMatchObject({ status: "deny" });
    const authenticated = provider.authenticate({
      headers: {
        authorization: `Bearer ${token.access_token}`,
        origin: CLIENT_ID,
      },
    });
    expect(authenticated.status).toBe("authenticated");
    if (authenticated.status !== "authenticated") throw new Error("not auth");
    expect(
      provider.authorize({
        principal: authenticated.principal,
        request: {
          agentId: "bookhand-agent",
          clientTools: [TOOL],
          toolChoice: "auto",
        },
      }),
    ).toBe(true);
    expect(
      provider.authorize({
        principal: authenticated.principal,
        request: {
          agentId: "bookhand-agent",
          clientTools: [{ ...TOOL, name: "delete_everything" }],
          toolChoice: "auto",
        },
      }),
    ).toBe(false);

    const refreshedResponse = await postForm(
      `${baseUrl}/agent-connect/oauth/token`,
      {
        grant_type: "refresh_token",
        refresh_token: token.refresh_token,
        client_id: CLIENT_ID,
        resource: RESOURCE,
      },
      CLIENT_ID,
    );
    expect(refreshedResponse.status).toBe(200);
    const refreshed = (await refreshedResponse.json()) as {
      access_token: string;
      refresh_token: string;
    };
    expect(refreshed.access_token).not.toBe(token.access_token);
    expect(
      provider.authenticate({
        headers: { authorization: `bearer ${token.access_token}` },
      }),
    ).toMatchObject({ status: "deny" });

    const revoke = await postForm(
      `${baseUrl}/agent-connect/oauth/revoke`,
      { token: refreshed.refresh_token, client_id: CLIENT_ID },
      CLIENT_ID,
    );
    expect(revoke.status).toBe(200);
    expect(
      provider.authenticate({
        headers: { authorization: `Bearer ${refreshed.access_token}` },
      }),
    ).toMatchObject({ status: "deny" });
  });

  it("returns a prevalidated access_denied redirect without creating a grant", async () => {
    const requestUri = await createPar(baseUrl);
    const shown = await ownerGet(
      `${baseUrl}/agent-connect/oauth/authorize?${new URLSearchParams({ client_id: CLIENT_ID, request_uri: requestUri })}`,
    );
    const csrf = hiddenValue(await shown.text(), "csrf_token");
    const denied = await ownerPost(
      `${baseUrl}/agent-connect/oauth/authorize`,
      {
        request_uri: requestUri,
        csrf_token: csrf,
        decision: "deny",
        policy_choice: "",
      },
      ISSUER,
    );
    expect(denied.status).toBe(303);
    const location = new URL(denied.headers.get("location") as string);
    expect(location.origin).toBe(CLIENT_ID);
    expect(location.searchParams.get("error")).toBe("access_denied");
    expect(location.searchParams.get("state")).toBe("opaque-state");
    expect(location.searchParams.get("iss")).toBe(ISSUER);
    expect(grants.getRequest(requestUri)).toBeUndefined();
  });
});

async function createPar(baseUrl: string): Promise<string> {
  const response = await postForm(
    `${baseUrl}/agent-connect/oauth/par`,
    {
      client_id: CLIENT_ID,
      redirect_uri: REDIRECT_URI,
      response_type: "code",
      scope: "responses",
      resource: RESOURCE,
      state: "opaque-state",
      code_challenge: createHash("sha256").update(VERIFIER).digest("base64url"),
      code_challenge_method: "S256",
      authorization_details: JSON.stringify([
        { type: FIXED_TOOLS_AUTHORIZATION_DETAIL, application_tools: [TOOL] },
      ]),
    },
    CLIENT_ID,
  );
  expect(response.status).toBe(201);
  const json = (await response.json()) as { request_uri: string };
  return json.request_uri;
}

async function approve(
  baseUrl: string,
): Promise<{ requestUri: string; code: string }> {
  const requestUri = await createPar(baseUrl);
  const shown = await ownerGet(
    `${baseUrl}/agent-connect/oauth/authorize?${new URLSearchParams({ client_id: CLIENT_ID, request_uri: requestUri })}`,
  );
  const csrf = hiddenValue(await shown.text(), "csrf_token");
  const approved = await ownerPost(
    `${baseUrl}/agent-connect/oauth/authorize`,
    {
      request_uri: requestUri,
      csrf_token: csrf,
      decision: "allow",
      policy_choice: "0",
    },
    ISSUER,
  );
  expect(approved.status).toBe(303);
  const location = new URL(approved.headers.get("location") as string);
  expect(location.searchParams.get("iss")).toBe(ISSUER);
  return { requestUri, code: location.searchParams.get("code") as string };
}

function ownerGet(
  url: string,
  profile = "owner-profile",
  scopes = "operator.admin",
): Promise<Response> {
  return fetch(url, {
    redirect: "manual",
    headers: { "x-test-owner": profile, "x-test-scopes": scopes },
  });
}

function ownerPost(
  url: string,
  form: Record<string, string>,
  origin: string,
  profile = "owner-profile",
): Promise<Response> {
  return fetch(url, {
    method: "POST",
    redirect: "manual",
    headers: {
      origin,
      "content-type": "application/x-www-form-urlencoded",
      "x-test-owner": profile,
      "x-test-scopes": "operator.admin",
    },
    body: new URLSearchParams(form),
  });
}

function postForm(
  url: string,
  form: Record<string, string>,
  origin: string,
): Promise<Response> {
  return fetch(url, {
    method: "POST",
    redirect: "manual",
    headers: { origin, "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(form),
  });
}

async function jsonGet(url: string): Promise<unknown> {
  const response = await fetch(url);
  expect(response.status).toBe(200);
  return response.json();
}

function hiddenValue(html: string, name: string): string {
  const match = html.match(new RegExp(`name="${name}" value="([^"]+)"`));
  if (!match?.[1]) throw new Error(`missing ${name}`);
  return match[1];
}
