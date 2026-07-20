import { describe, expect, it, vi } from "vitest";

import {
  beginAgentAuthorization,
  completeAgentAuthorization,
  defineTool,
  parseAuthorizationTransaction,
  parseRuntimeCard,
  revokeAgentAuthorization,
  serializeAuthorizationTransaction,
  type RuntimeCard,
} from "../src/index.js";

describe("Agent Connect enrollment and authorization", () => {
  it("parses a portable runtime card and rejects incomplete input", () => {
    const card = parseRuntimeCard(
      JSON.stringify({
        version: 1,
        runtimeId: "sha256:runtime",
        endpoint: "https://runtime.example",
        connectorPublicKey: { kty: "OKP", crv: "Ed25519", x: "public" },
        transportProfile: "tailscale-serve",
        authorizationServer: "https://runtime.example",
      }),
    );
    expect(card.runtimeId).toBe("sha256:runtime");
    expect(() => parseRuntimeCard("not json")).toThrow(
      "Invalid Agent Connect runtime card",
    );
    expect(() => parseRuntimeCard(JSON.stringify({ version: 1 }))).toThrow(
      "Invalid Agent Connect runtime card",
    );
  });

  it("verifies the connector before pushing tools and completes PKCE", async () => {
    const { privateKey, publicKey } = (await crypto.subtle.generateKey(
      "Ed25519",
      true,
      ["sign", "verify"],
    )) as CryptoKeyPair;
    const runtimeCard: RuntimeCard = {
      version: 1,
      runtimeId: "sha256:runtime",
      endpoint: "https://runtime.example",
      connectorPublicKey: await crypto.subtle.exportKey("jwk", publicKey),
      transportProfile: "tailscale-serve",
      authorizationServer: "https://runtime.example",
    };
    const calls: Array<{ url: string; body: Record<string, unknown> }> = [];
    const fetch = vi.fn<typeof globalThis.fetch>(async (input, init) => {
      const url = String(input);
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      calls.push({ url, body });
      if (url.endsWith("/v1/runtime-challenges")) {
        const payload = JSON.stringify({
          version: 1,
          runtimeId: runtimeCard.runtimeId,
          endpoint: runtimeCard.endpoint,
          nonce: body["nonce"],
        });
        return Response.json({
          runtimeCard,
          nonce: body["nonce"],
          signature: base64Url(
            await crypto.subtle.sign(
              "Ed25519",
              privateKey,
              new TextEncoder().encode(payload),
            ),
          ),
        });
      }
      if (url.endsWith("/v1/authorization-requests")) {
        expect(body["tools"]).toEqual([
          expect.objectContaining({ name: "set_message" }),
        ]);
        return Response.json(
          {
            requestId: "ar_request",
            authorizeUrl:
              "https://runtime.example/authorize?request=ar_request",
            expiresAt: "2099-01-01T00:00:00.000Z",
          },
          { status: 201 },
        );
      }
      return Response.json({
        accessToken: "acg_grant",
        tokenType: "Bearer",
        expiresAt: "2099-01-01T00:00:00.000Z",
        grant: {
          id: "grant_1",
          origin: "https://app.example",
          appId: "demo",
          scopes: ["agent:prompt", "agent:result", "tools:invoke"],
          toolHash: "hash",
          toolNames: ["set_message"],
          createdAt: "2026-07-14T00:00:00.000Z",
          expiresAt: "2099-01-01T00:00:00.000Z",
        },
      });
    });
    const tools = [
      defineTool({
        name: "set_message",
        description: "Set the message",
        inputSchema: { type: "object", additionalProperties: false },
        execute: () => undefined,
      }),
    ];
    const started = await beginAgentAuthorization({
      runtimeCard,
      appId: "demo",
      redirectUri: "https://app.example/callback",
      tools,
      fetch,
    });
    expect(calls.map((call) => call.url)).toEqual([
      "https://runtime.example/v1/runtime-challenges",
      "https://runtime.example/v1/authorization-requests",
    ]);
    expect(started.authorizeUrl).toBe(
      "https://runtime.example/authorize?request=ar_request",
    );
    expect(
      parseAuthorizationTransaction(
        serializeAuthorizationTransaction(started.transaction),
      ),
    ).toEqual(started.transaction);

    const grant = await completeAgentAuthorization({
      runtimeCard,
      appId: "demo",
      redirectUri: "https://app.example/callback",
      transaction: started.transaction,
      callbackUrl: `https://app.example/callback?code=acc_code&state=${started.transaction.state}`,
      fetch,
    });
    expect(grant.accessToken).toBe("acg_grant");
    expect(calls.at(-1)?.body).toMatchObject({
      code: "acc_code",
      codeVerifier: started.transaction.codeVerifier,
      appId: "demo",
    });
  });

  it("does not disclose tools when connector proof is invalid", async () => {
    const { publicKey } = (await crypto.subtle.generateKey("Ed25519", true, [
      "sign",
      "verify",
    ])) as CryptoKeyPair;
    const runtimeCard: RuntimeCard = {
      version: 1,
      runtimeId: "sha256:runtime",
      endpoint: "https://runtime.example",
      connectorPublicKey: await crypto.subtle.exportKey("jwk", publicKey),
      transportProfile: "tailscale-serve",
      authorizationServer: "https://runtime.example",
    };
    const fetch = vi.fn<typeof globalThis.fetch>(async (_input, init) => {
      const body = JSON.parse(String(init?.body)) as { nonce: string };
      return Response.json({
        runtimeCard,
        nonce: body.nonce,
        signature: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
      });
    });
    await expect(
      beginAgentAuthorization({
        runtimeCard,
        appId: "demo",
        redirectUri: "https://app.example/callback",
        tools: [
          defineTool({
            name: "secret_tool",
            description: "Sensitive schema",
            inputSchema: { type: "object" },
            execute: () => undefined,
          }),
        ],
        fetch,
      }),
    ).rejects.toMatchObject({ code: "runtime_identity_mismatch" });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("rejects authorization denial and state substitution", async () => {
    const transaction = {
      version: 1 as const,
      runtimeId: "sha256:runtime",
      appId: "demo",
      redirectUri: "https://app.example/callback",
      state: "expected",
      codeVerifier: "v".repeat(43),
      requestId: "ar_request",
    };
    const runtimeCard: RuntimeCard = {
      version: 1,
      runtimeId: transaction.runtimeId,
      endpoint: "https://runtime.example",
      connectorPublicKey: {},
      transportProfile: "tailscale-serve",
      authorizationServer: "https://runtime.example",
    };
    await expect(
      completeAgentAuthorization({
        runtimeCard,
        appId: "demo",
        redirectUri: transaction.redirectUri,
        transaction,
        callbackUrl:
          "https://app.example/callback?error=access_denied&state=expected",
      }),
    ).rejects.toMatchObject({ code: "authorization_denied" });
    await expect(
      completeAgentAuthorization({
        runtimeCard,
        appId: "demo",
        redirectUri: transaction.redirectUri,
        transaction,
        callbackUrl:
          "https://app.example/callback?code=acc_code&state=substituted",
      }),
    ).rejects.toMatchObject({ code: "protocol_error" });
    await expect(
      completeAgentAuthorization({
        runtimeCard,
        appId: "demo",
        redirectUri: transaction.redirectUri,
        transaction,
        callbackUrl:
          "https://app.example/callback?error=access_denied&state=substituted",
      }),
    ).rejects.toMatchObject({ code: "protocol_error" });
    await expect(
      completeAgentAuthorization({
        runtimeCard,
        appId: "demo",
        redirectUri: transaction.redirectUri,
        transaction,
        callbackUrl: `https://attacker.example/callback?code=acc_code&state=${transaction.state}`,
      }),
    ).rejects.toMatchObject({ code: "protocol_error" });
  });

  it("revokes the current application grant with its bearer credential", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(async (_input, init) => {
      expect(new Headers(init?.headers).get("authorization")).toBe(
        "Bearer acg_current",
      );
      expect(JSON.parse(String(init?.body))).toEqual({ appId: "demo" });
      return new Response(null, { status: 204 });
    });

    await revokeAgentAuthorization({
      baseUrl: "https://runtime.example",
      appId: "demo",
      accessToken: "acg_current",
      fetch,
    });

    expect(fetch).toHaveBeenCalledWith(
      "https://runtime.example/oauth/revoke",
      expect.objectContaining({ method: "POST" }),
    );
  });
});

function base64Url(value: ArrayBuffer): string {
  const bytes = new Uint8Array(value);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary)
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/, "");
}
