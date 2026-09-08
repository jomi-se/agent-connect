import { afterEach, describe, expect, it, vi } from "vitest";

import {
  beginOpenClawAuthorization,
  completeOpenClawAuthorization,
  createOpenClawAccessTokenGetter,
  discoverOpenClawProvider,
  parseOpenClawAuthorizationTransaction,
  refreshOpenClawConnection,
  revokeOpenClawConnection,
  serializeOpenClawAuthorizationTransaction,
  type OpenClawConnection,
} from "../src/openclaw-connection.js";
import type { ApplicationTool } from "../src/types.js";

const ORIGIN = "https://claw.example";
const APP_ORIGIN = "https://books.example";
const REDIRECT_URI = `${APP_ORIGIN}/oauth/callback`;

afterEach(() => {
  vi.useRealTimers();
});

describe("OpenClaw delegated OAuth connection", () => {
  it("discovers one same-origin delegated Responses profile", async () => {
    const requests: Array<{ url: string; init?: RequestInit }> = [];
    const provider = await discoverOpenClawProvider({
      providerUrl: `${ORIGIN}/`,
      experience: "tailscale",
      fetch: vi.fn(async (input, init) => {
        requests.push({ url: String(input), init });
        return String(input).endsWith("oauth-authorization-server")
          ? Response.json(authorizationMetadata())
          : Response.json(resourceMetadata());
      }),
    });

    expect(provider).toMatchObject({
      experience: "tailscale",
      issuer: ORIGIN,
      resource: `${ORIGIN}/v1/responses`,
      tokenEndpoint: `${ORIGIN}/agent-connect/oauth/token`,
    });
    expect(requests.map(({ init }) => init?.redirect)).toEqual([
      "error",
      "error",
    ]);
    expect(requests.map(({ init }) => init?.credentials)).toEqual([
      "omit",
      "omit",
    ]);

    await expect(
      discoverOpenClawProvider({
        providerUrl: ORIGIN,
        experience: "https",
        fetch: async (input) =>
          String(input).endsWith("oauth-authorization-server")
            ? Response.json({
                ...authorizationMetadata(),
                token_endpoint: "https://attacker.example/oauth/token",
              })
            : Response.json(resourceMetadata()),
      }),
    ).rejects.toMatchObject({ code: "discovery_failed" });
    await expect(
      discoverOpenClawProvider({
        providerUrl: "https://user:secret@claw.example/#fragment",
        experience: "tailscale",
      }),
    ).rejects.toMatchObject({ code: "invalid_input" });
  });

  it("discovers the stock-plugin path issuer through standard well-known URLs", async () => {
    const issuer = `${ORIGIN}/agent-connect`;
    const resource = `${ORIGIN}/agent-connect/v1/responses`;
    const requests: string[] = [];
    const provider = await discoverOpenClawProvider({
      providerUrl: issuer,
      experience: "https",
      fetch: vi.fn(async (input) => {
        const url = String(input);
        requests.push(url);
        return url.includes("oauth-authorization-server")
          ? Response.json({ ...authorizationMetadata(), issuer })
          : Response.json({
              ...resourceMetadata(),
              resource,
              authorization_servers: [issuer],
            });
      }),
    });

    expect(requests).toEqual([
      `${ORIGIN}/.well-known/oauth-authorization-server/agent-connect`,
      `${ORIGIN}/.well-known/oauth-protected-resource/agent-connect/v1/responses`,
    ]);
    expect(provider).toMatchObject({ issuer, resource });

    await expect(
      discoverOpenClawProvider({
        providerUrl: issuer,
        experience: "https",
        fetch: async (input) =>
          String(input).includes("oauth-authorization-server")
            ? Response.json(authorizationMetadata())
            : Response.json({
                ...resourceMetadata(),
                resource,
                authorization_servers: [issuer],
              }),
      }),
    ).rejects.toMatchObject({ code: "discovery_failed" });
  });

  it("uses PAR, PKCE and RFC 9207 issuer binding without sending local context", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-06T12:00:00.000Z"));
    const calls: Array<{ url: string; form: URLSearchParams | undefined }> = [];
    const fetch = vi.fn<typeof globalThis.fetch>(async (input, init) => {
      const url = String(input);
      const form =
        init?.body instanceof URLSearchParams ? init.body : undefined;
      calls.push({ url, form });
      if (url.endsWith("oauth-authorization-server")) {
        return Response.json(authorizationMetadata());
      }
      if (url.endsWith("oauth-protected-resource")) {
        return Response.json(resourceMetadata());
      }
      if (url.endsWith("/par")) {
        return Response.json(
          {
            request_uri: "urn:ietf:params:oauth:request_uri:req_1",
            expires_in: 300,
          },
          { status: 201 },
        );
      }
      return Response.json(tokenResponse("access-one", "refresh-one"));
    });
    const provider = await discoverOpenClawProvider({
      providerUrl: ORIGIN,
      experience: "tailscale",
      fetch,
    });
    const started = await beginOpenClawAuthorization({
      provider,
      redirectUri: REDIRECT_URI,
      tools: [tool()],
      callerContext: { bookId: "book-1", draft: "Explain this" },
      fetch,
    });
    const par = calls.find(({ url }) => url.endsWith("/par"))?.form;
    expect(Object.fromEntries(par ?? [])).toMatchObject({
      client_id: APP_ORIGIN,
      redirect_uri: REDIRECT_URI,
      response_type: "code",
      scope: "responses",
      resource: `${ORIGIN}/v1/responses`,
      code_challenge_method: "S256",
    });
    expect(par?.has("bookId")).toBe(false);
    expect(JSON.parse(par?.get("authorization_details") ?? "null")).toEqual([
      {
        type: "agent_connect",
        application_tools: [
          {
            name: "lookup",
            description: "Look up a passage",
            inputSchema: {
              additionalProperties: false,
              properties: { query: { type: "string" } },
              required: ["query"],
              type: "object",
            },
          },
        ],
      },
    ]);
    expect(
      Object.fromEntries(new URL(started.authorizationUrl).searchParams),
    ).toEqual({
      client_id: APP_ORIGIN,
      request_uri: "urn:ietf:params:oauth:request_uri:req_1",
    });
    expect(
      parseOpenClawAuthorizationTransaction(
        serializeOpenClawAuthorizationTransaction(started.transaction),
      ).callerContext,
    ).toEqual({ bookId: "book-1", draft: "Explain this" });

    const connection = await completeOpenClawAuthorization({
      provider,
      redirectUri: REDIRECT_URI,
      transaction: started.transaction,
      callbackUrl: `${REDIRECT_URI}?code=code-one&state=${started.transaction.state}&iss=${encodeURIComponent(ORIGIN)}`,
      fetch,
    });
    const exchange = calls.at(-1)?.form;
    expect(Object.fromEntries(exchange ?? [])).toEqual({
      grant_type: "authorization_code",
      code: "code-one",
      code_verifier: started.transaction.codeVerifier,
      client_id: APP_ORIGIN,
      redirect_uri: REDIRECT_URI,
      resource: `${ORIGIN}/v1/responses`,
    });
    expect(connection).toMatchObject({
      endpoint: `${ORIGIN}/v1/responses`,
      model: "openclaw/default",
      accessToken: "access-one",
      refreshToken: "refresh-one",
      applicationToolsHash: started.transaction.applicationToolsHash,
      applicationTools: [{ name: "lookup" }],
    });
    expect(connection).not.toHaveProperty("callerContext");
  });

  it("rejects denial substitution before exchanging a code", async () => {
    const fetch = oauthFixture();
    const provider = await discoverOpenClawProvider({
      providerUrl: ORIGIN,
      experience: "https",
      fetch,
    });
    const started = await beginOpenClawAuthorization({
      provider,
      redirectUri: REDIRECT_URI,
      tools: [],
      fetch,
    });

    await expect(
      completeOpenClawAuthorization({
        provider,
        redirectUri: REDIRECT_URI,
        transaction: started.transaction,
        callbackUrl: `${REDIRECT_URI}?error=access_denied&state=${started.transaction.state}&iss=${encodeURIComponent(ORIGIN)}`,
        fetch,
      }),
    ).rejects.toMatchObject({ code: "authorization_denied" });
    await expect(
      completeOpenClawAuthorization({
        provider,
        redirectUri: REDIRECT_URI,
        transaction: started.transaction,
        callbackUrl: `${REDIRECT_URI}?code=code&state=${started.transaction.state}&iss=https%3A%2F%2Fattacker.example`,
        fetch,
      }),
    ).rejects.toMatchObject({ code: "transaction_mismatch" });
  });

  it("single-flights rotating refresh and requires reauthorization after ambiguity", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-06T12:00:00.000Z"));
    let stored = connection({
      expiresAt: "2026-09-06T12:00:30.000Z",
      refreshTokenExpiresAt: "2026-09-07T12:00:00.000Z",
    });
    const fetch = vi.fn<typeof globalThis.fetch>(async () =>
      Response.json(tokenResponse("access-two", "refresh-two")),
    );
    const saveConnection = vi.fn(
      (value: OpenClawConnection, expected: OpenClawConnection) => {
        expect(expected).toBe(stored);
        stored = value;
        return true;
      },
    );
    const getAccessToken = createOpenClawAccessTokenGetter({
      getConnection: () => stored,
      saveConnection,
      fetch,
    });

    await expect(
      Promise.all([getAccessToken(), getAccessToken(), getAccessToken()]),
    ).resolves.toEqual(["access-two", "access-two", "access-two"]);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(saveConnection).toHaveBeenCalledTimes(1);
    expect(
      Object.fromEntries(
        (fetch.mock.calls[0]?.[1]?.body as URLSearchParams | undefined) ?? [],
      ),
    ).toMatchObject({
      grant_type: "refresh_token",
      refresh_token: "refresh-one",
      client_id: APP_ORIGIN,
      resource: `${ORIGIN}/v1/responses`,
    });

    stored = connection({ expiresAt: "2026-09-06T11:59:00.000Z" });
    const ambiguousFetch = vi.fn(async () => {
      throw new TypeError("network dropped after POST");
    });
    const ambiguousGetter = createOpenClawAccessTokenGetter({
      getConnection: () => stored,
      saveConnection: vi.fn(() => true),
      fetch: ambiguousFetch,
    });
    await expect(ambiguousGetter()).rejects.toMatchObject({
      code: "reauthorization_required",
    });
    await expect(ambiguousGetter()).rejects.toMatchObject({
      code: "reauthorization_required",
    });
    expect(ambiguousFetch).toHaveBeenCalledTimes(1);
  });

  it("does not resurrect a connection replaced during refresh", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-06T12:00:00.000Z"));
    const original = connection({ expiresAt: "2026-09-06T11:59:00.000Z" });
    let stored = original;
    let release!: (response: Response) => void;
    const fetch = vi.fn<typeof globalThis.fetch>(
      () =>
        new Promise<Response>((resolve) => {
          release = resolve;
        }),
    );
    const saveConnection = vi.fn(
      (next: OpenClawConnection, expected: OpenClawConnection) => {
        if (stored.refreshToken !== expected.refreshToken) return false;
        stored = next;
        return true;
      },
    );
    const getAccessToken = createOpenClawAccessTokenGetter({
      getConnection: () => stored,
      saveConnection,
      fetch,
    });

    const pending = getAccessToken();
    await vi.waitFor(() => expect(release).toBeTypeOf("function"));
    const replacement = connection({
      accessToken: "new-authorization",
      refreshToken: "new-refresh",
    });
    stored = replacement;
    release(Response.json(tokenResponse("stale-access", "stale-refresh")));

    await expect(pending).rejects.toMatchObject({ code: "connection_changed" });
    expect(stored).toBe(replacement);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("rotates directly, revokes the refresh family, and types local expiry", async () => {
    const current = connection();
    const fetch = vi.fn<typeof globalThis.fetch>(async (input, init) => {
      if (String(input).endsWith("/token")) {
        return Response.json(tokenResponse("access-two", "refresh-two"));
      }
      expect(Object.fromEntries((init?.body as URLSearchParams) ?? [])).toEqual(
        {
          token: "refresh-one",
          token_type_hint: "refresh_token",
          client_id: APP_ORIGIN,
        },
      );
      return new Response(null, { status: 200 });
    });
    await expect(
      refreshOpenClawConnection({ connection: current, fetch }),
    ).resolves.toMatchObject({
      accessToken: "access-two",
      refreshToken: "refresh-two",
    });
    await revokeOpenClawConnection({ connection: current, fetch });

    await expect(
      refreshOpenClawConnection({
        connection: connection({
          refreshTokenExpiresAt: "2000-01-01T00:00:00Z",
        }),
        fetch,
      }),
    ).rejects.toMatchObject({ code: "connection_expired" });
  });
});

function authorizationMetadata(): Record<string, unknown> {
  return {
    issuer: ORIGIN,
    authorization_endpoint: `${ORIGIN}/agent-connect/oauth/authorize`,
    token_endpoint: `${ORIGIN}/agent-connect/oauth/token`,
    revocation_endpoint: `${ORIGIN}/agent-connect/oauth/revoke`,
    pushed_authorization_request_endpoint: `${ORIGIN}/agent-connect/oauth/par`,
    response_types_supported: ["code"],
    grant_types_supported: ["authorization_code", "refresh_token"],
    token_endpoint_auth_methods_supported: ["none"],
    code_challenge_methods_supported: ["S256"],
    scopes_supported: ["responses"],
    authorization_details_types_supported: ["agent_connect"],
    require_pushed_authorization_requests: true,
    authorization_response_iss_parameter_supported: true,
  };
}

function resourceMetadata(): Record<string, unknown> {
  return {
    resource: `${ORIGIN}/v1/responses`,
    authorization_servers: [ORIGIN],
    scopes_supported: ["responses"],
    bearer_methods_supported: ["header"],
    authorization_details_types_supported: ["agent_connect"],
    agent_connect_model: "openclaw/default",
  };
}

function tokenResponse(accessToken: string, refreshToken: string) {
  return {
    access_token: accessToken,
    refresh_token: refreshToken,
    token_type: "Bearer",
    expires_in: 3_600,
    refresh_token_expires_in: 86_400,
    scope: "responses",
  };
}

function tool(): ApplicationTool {
  return {
    name: "lookup",
    description: "Look up a passage",
    inputSchema: {
      type: "object",
      properties: { query: { type: "string" } },
      required: ["query"],
      additionalProperties: false,
    },
    execute: async () => "result",
  };
}

function oauthFixture(): typeof globalThis.fetch {
  return vi.fn(async (input) => {
    const url = String(input);
    if (url.endsWith("oauth-authorization-server")) {
      return Response.json(authorizationMetadata());
    }
    if (url.endsWith("oauth-protected-resource")) {
      return Response.json(resourceMetadata());
    }
    if (url.endsWith("/par")) {
      return Response.json(
        {
          request_uri: "urn:ietf:params:oauth:request_uri:req_1",
          expires_in: 300,
        },
        { status: 201 },
      );
    }
    return Response.json(tokenResponse("access-one", "refresh-one"));
  });
}

function connection(
  overrides: Partial<OpenClawConnection> = {},
): OpenClawConnection {
  return {
    version: 1,
    providerOrigin: ORIGIN,
    endpoint: `${ORIGIN}/v1/responses`,
    clientId: APP_ORIGIN,
    accessToken: "access-one",
    refreshToken: "refresh-one",
    expiresAt: "2099-01-01T00:00:00.000Z",
    refreshTokenExpiresAt: "2099-02-01T00:00:00.000Z",
    model: "openclaw/default",
    applicationTools: [
      {
        name: "lookup",
        description: "Look up a passage",
        inputSchema: { type: "object" },
      },
    ],
    applicationToolsHash: "h".repeat(43),
    ...overrides,
  };
}
