import { createServer, type Server } from "node:http";

import { describe, expect, it } from "vitest";

import {
  beginOpenClawAuthorization,
  completeOpenClawAuthorization,
  createOpenClawAccessTokenGetter,
  discoverOpenClawProvider,
  revokeOpenClawConnection,
  type OpenClawConnection,
} from "../../web-sdk/src/openclaw-connection.js";
import type { ApplicationTool } from "../../web-sdk/src/types.js";
import {
  DelegatedGrantService,
  type DelegatedGrantStore,
} from "../src/delegated-grants.js";
import { OpenClawOAuthHandler } from "../src/openclaw-plugin/oauth-handler.js";

const ISSUER = "https://provider.example";
const RESOURCE = `${ISSUER}/v1/responses`;
const CLIENT_ID = "https://bookhand.example";
const REDIRECT_URI = `${CLIENT_ID}/connect/openclaw/callback`;
const TEST_OWNER_HEADERS = {
  "x-test-owner-profile": "fixture-owner",
  "x-test-owner-scopes": "operator.admin",
};
const APPLICATION_TOOL: ApplicationTool = {
  name: "add_note",
  description: "Add one note to the open book",
  inputSchema: {
    type: "object",
    properties: { text: { type: "string" } },
    required: ["text"],
    additionalProperties: false,
  },
  execute: () => "not invoked by authorization",
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

describe("web SDK against the provider OAuth handler", () => {
  it("completes discovery, consent, exchange, single-flight refresh and revocation", async () => {
    const grantService = new DelegatedGrantService({
      resource: RESOURCE,
      store: new MemoryStore(),
      accessTokenTtlSeconds: 1,
      offeredPolicies: [
        {
          ref: "application-tools-only",
          label: "Application tools only",
          agentId: "bookhand-agent",
          fingerprint: "sha256:integration-policy",
          nativeCapabilities: [],
        },
      ],
    });
    const oauth = new OpenClawOAuthHandler({
      issuer: ISSUER,
      resource: RESOURCE,
      grantService,
      allowedOwnerProfileIds: ["fixture-owner"],
      // This is test-only host attribution. It is deliberately not evidence of
      // OpenClaw native owner authentication or Tailscale WhoIs verification.
      ownerVerifier: ({ headers }) =>
        headers["x-test-owner-profile"] === "fixture-owner" &&
        headers["x-test-owner-scopes"] === "operator.admin"
          ? { profileId: "fixture-owner", scopes: ["operator.admin"] }
          : undefined,
    });
    const serverErrors: unknown[] = [];
    const server = createServer((request, response) => {
      void oauth.handle(request, response).catch((error: unknown) => {
        serverErrors.push(error);
        response.destroy(error as Error);
      });
    });
    const loopbackOrigin = await listen(server);
    let refreshRequests = 0;
    const transportFetch = mappedFetch(loopbackOrigin);
    const applicationFetch = mappedFetch(loopbackOrigin, {
      browserOrigin: CLIENT_ID,
      observe: (url, init) => {
        if (
          url.pathname === "/agent-connect/oauth/token" &&
          init.body instanceof URLSearchParams &&
          init.body.get("grant_type") === "refresh_token"
        ) {
          refreshRequests += 1;
        }
      },
    });

    try {
      const provider = await discoverOpenClawProvider({
        providerUrl: ISSUER,
        experience: "https",
        fetch: applicationFetch,
      });
      expect(provider).toMatchObject({
        issuer: ISSUER,
        resource: RESOURCE,
        tokenEndpoint: `${ISSUER}/agent-connect/oauth/token`,
      });

      const started = await beginOpenClawAuthorization({
        provider,
        redirectUri: REDIRECT_URI,
        tools: [APPLICATION_TOOL],
        callerContext: { pendingFeature: "Tutor" },
        fetch: applicationFetch,
      });
      expect(started.authorizationUrl).toBe(
        `${ISSUER}/agent-connect/oauth/authorize?${new URLSearchParams({
          client_id: CLIENT_ID,
          request_uri: started.transaction.requestUri,
        })}`,
      );

      const consent = await transportFetch(started.authorizationUrl, {
        redirect: "manual",
        headers: TEST_OWNER_HEADERS,
      });
      expect(consent.status).toBe(200);
      const consentHtml = await consent.text();
      expect(consentHtml).toContain("add_note");
      expect(consentHtml).toContain("Application tools only");
      const csrfToken = hiddenValue(consentHtml, "csrf_token");
      const requestUri = hiddenValue(consentHtml, "request_uri");
      expect(requestUri).toBe(started.transaction.requestUri);

      const approved = await transportFetch(
        `${ISSUER}/agent-connect/oauth/authorize`,
        {
          method: "POST",
          redirect: "manual",
          headers: {
            ...TEST_OWNER_HEADERS,
            origin: ISSUER,
            "content-type": "application/x-www-form-urlencoded",
          },
          body: new URLSearchParams({
            request_uri: requestUri,
            csrf_token: csrfToken,
            decision: "allow",
            policy_choice: "0",
          }),
        },
      );
      expect(approved.status).toBe(303);
      const callbackUrl = approved.headers.get("location");
      expect(callbackUrl).not.toBeNull();
      expect(new URL(callbackUrl as string).searchParams.get("iss")).toBe(
        ISSUER,
      );

      let connection = await completeOpenClawAuthorization({
        provider,
        redirectUri: REDIRECT_URI,
        transaction: started.transaction,
        callbackUrl: callbackUrl as string,
        fetch: applicationFetch,
      });
      expect(connection.applicationTools).toEqual([
        {
          name: APPLICATION_TOOL.name,
          description: APPLICATION_TOOL.description,
          inputSchema: APPLICATION_TOOL.inputSchema,
        },
      ]);
      expect(
        grantService.verify(connection.accessToken, {
          resource: RESOURCE,
          origin: CLIENT_ID,
        }),
      ).toMatchObject({
        ownerSubject: "openclaw-profile:fixture-owner",
        clientId: CLIENT_ID,
        agentId: "bookhand-agent",
        applicationTools: connection.applicationTools,
      });

      const initialAccessToken = connection.accessToken;
      let saves = 0;
      const accessToken = createOpenClawAccessTokenGetter({
        getConnection: () => connection,
        saveConnection: (refreshed, expected) => {
          if (connection !== expected) return false;
          saves += 1;
          connection = refreshed;
          return true;
        },
        fetch: applicationFetch,
        refreshBeforeMs: 60_000,
      });
      const [firstCallerToken, secondCallerToken] = await Promise.all([
        accessToken(),
        accessToken(),
      ]);
      expect(firstCallerToken).toBe(secondCallerToken);
      expect(firstCallerToken).toBe(connection.accessToken);
      expect(firstCallerToken).not.toBe(initialAccessToken);
      expect(refreshRequests).toBe(1);
      expect(saves).toBe(1);
      expect(
        grantService.verify(initialAccessToken, { resource: RESOURCE }),
      ).toBeUndefined();
      expect(
        grantService.verify(connection.accessToken, { resource: RESOURCE }),
      ).toBeDefined();

      await revokeOpenClawConnection({
        connection,
        fetch: applicationFetch,
      });
      expect(
        grantService.verify(connection.accessToken, { resource: RESOURCE }),
      ).toBeUndefined();
      expect(serverErrors).toEqual([]);
    } finally {
      await close(server);
    }
  });
});

function mappedFetch(
  loopbackOrigin: string,
  options: {
    readonly browserOrigin?: string;
    readonly observe?: (url: URL, init: RequestInit) => void;
  } = {},
): typeof globalThis.fetch {
  return (async (input: RequestInfo | URL, init: RequestInit = {}) => {
    if (input instanceof Request) {
      throw new Error("integration transport expects an absolute URL");
    }
    const logicalUrl = new URL(input.toString());
    if (logicalUrl.origin !== ISSUER) {
      throw new Error("integration transport refused an unexpected origin");
    }
    options.observe?.(logicalUrl, init);
    const headers = new Headers(init.headers);
    const method = init.method ?? "GET";
    if (
      options.browserOrigin !== undefined &&
      method !== "GET" &&
      method !== "HEAD"
    ) {
      headers.set("origin", options.browserOrigin);
    }
    const loopbackUrl = new URL(
      `${logicalUrl.pathname}${logicalUrl.search}`,
      loopbackOrigin,
    );
    return globalThis.fetch(loopbackUrl, { ...init, headers });
  }) as typeof globalThis.fetch;
}

function hiddenValue(html: string, name: string): string {
  const match = html.match(new RegExp(`name="${name}" value="([^"]+)"`));
  if (!match?.[1]) throw new Error(`missing ${name}`);
  return match[1];
}

function listen(server: Server): Promise<string> {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      const address = server.address();
      if (!address || typeof address === "string") {
        reject(new Error("fixture server did not expose an address"));
        return;
      }
      resolve(`http://127.0.0.1:${address.port}`);
    });
  });
}

function close(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}
