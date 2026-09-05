import { createHash } from "node:crypto";
import { expect } from "vitest";
export const APP_ORIGIN = "https://preview.example";
export const tools = [
  {
    name: "set_page_message",
    description: "Set visible message",
    inputSchema: {
      type: "object",
      properties: { message: { type: "string" } },
      required: ["message"],
      additionalProperties: false,
    },
  },
];
export function headers(token?: string) {
  return {
    Origin: APP_ORIGIN,
    "Tailscale-User-Login": "owner@example.com",
    "Content-Type": "application/json",
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
  };
}
export async function authorize(baseUrl: string) {
  const pushed = await fetch(`${baseUrl}/v1/authorization-requests`, {
    method: "POST",
    headers: headers(),
    body: JSON.stringify({
      appId: "test-app",
      redirectUri: `${APP_ORIGIN}/oauth/callback`,
      state: "state_state_state_state",
      codeChallenge: createHash("sha256")
        .update("v".repeat(43))
        .digest("base64url"),
      scopes: ["agent:prompt", "agent:result", "tools:invoke"],
      tools,
    }),
  });
  expect(pushed.status).toBe(201);
  const { requestId } = await pushed.json();
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
  expect(approval.status).toBe(303);
  const code = new URL(approval.headers.get("location")!).searchParams.get(
    "code",
  );
  const token = await fetch(`${baseUrl}/oauth/token`, {
    method: "POST",
    headers: headers(),
    body: JSON.stringify({
      code,
      codeVerifier: "v".repeat(43),
      appId: "test-app",
      redirectUri: `${APP_ORIGIN}/oauth/callback`,
    }),
  });
  expect(token.status).toBe(200);
  return (await token.json()).accessToken as string;
}
export async function createSession(baseUrl: string, grant: string) {
  const response = await fetch(`${baseUrl}/v1/app-sessions`, {
    method: "POST",
    headers: headers(grant),
    body: JSON.stringify({ appId: "test-app", tools }),
  });
  expect(response.status).toBe(201);
  return (await response.json()) as { sessionId: string; accessToken: string };
}
export function post(
  baseUrl: string,
  token: string,
  body: Record<string, unknown>,
) {
  return fetch(`${baseUrl}/v1/responses`, {
    method: "POST",
    headers: headers(token),
    body: JSON.stringify({ model: "agent-connect/default", ...body }),
  });
}
