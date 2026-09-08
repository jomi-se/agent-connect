import type { IncomingMessage, ServerResponse } from "node:http";

import { DelegatedGrantError } from "../delegated-grants.js";
import { FIXED_TOOLS_AUTHORIZATION_DETAIL } from "./contracts.js";
import {
  OAuthRequestError,
  appCors,
  isCanonicalHttpsOrigin,
  noStore,
  sendJson,
} from "./http.js";

export { OAuthRequestError } from "./http.js";

export function parseAuthorizationDetails(raw: string): unknown {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new OAuthRequestError("invalid_authorization_details");
  }
  if (!Array.isArray(parsed) || parsed.length !== 1) {
    throw new OAuthRequestError("invalid_authorization_details");
  }
  const detail = parsed[0];
  if (!detail || typeof detail !== "object" || Array.isArray(detail)) {
    throw new OAuthRequestError("invalid_authorization_details");
  }
  const record = detail as Record<string, unknown>;
  if (
    record.type !== FIXED_TOOLS_AUTHORIZATION_DETAIL ||
    !Array.isArray(record.application_tools) ||
    Object.keys(record).some(
      (key) => key !== "type" && key !== "application_tools",
    )
  ) {
    throw new OAuthRequestError("invalid_authorization_details");
  }
  return record.application_tools;
}

export function requireAppOrigin(
  request: IncomingMessage,
  clientId: string,
): void {
  const origin = request.headers.origin;
  if (origin !== undefined && origin !== clientId) {
    throw new OAuthRequestError("invalid_client");
  }
}

export function requireSameOrigin(
  request: IncomingMessage,
  issuer: string,
): void {
  if (request.headers.origin !== new URL(issuer).origin)
    throw new Error("cross-origin consent");
}

export function exactGet(request: IncomingMessage, url: URL): boolean {
  return request.method === "GET" && url.search === "";
}

export function canonicalIssuer(value: string, expectedPath = ""): string {
  const url = new URL(value);
  const canonical = expectedPath ? `${url.origin}${expectedPath}` : url.origin;
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    value !== canonical
  ) {
    throw new Error("issuer must be a canonical HTTPS URL");
  }
  return canonical;
}

export function canonicalResource(
  value: string,
  issuer: string,
  expectedPath = "/v1/responses",
): string {
  const url = new URL(value);
  if (
    url.protocol !== "https:" ||
    url.origin !== new URL(issuer).origin ||
    url.pathname !== expectedPath ||
    url.search ||
    url.hash ||
    value !== url.href
  ) {
    throw new Error(
      "resource must be the canonical Responses URL for this issuer",
    );
  }
  return value;
}

export function publicCors(
  request: IncomingMessage,
  response: ServerResponse,
): void {
  if (request.headers.origin) {
    response.setHeader("access-control-allow-origin", "*");
  }
}

export function oauthJsonError(
  request: IncomingMessage,
  response: ServerResponse,
  error: unknown,
  fallback: string,
): void {
  const code = oauthErrorCode(error, fallback);
  const origin = request.headers.origin;
  if (origin && isCanonicalHttpsOrigin(origin)) {
    appCors(request, response, origin);
  }
  noStore(response);
  sendJson(response, code === "invalid_client" ? 401 : 400, { error: code });
}

function oauthErrorCode(error: unknown, fallback: string): string {
  if (error instanceof OAuthRequestError) return error.oauthCode;
  if (!(error instanceof DelegatedGrantError)) return fallback;
  if (error.code === "invalid_client") return "invalid_client";
  if (error.code === "invalid_resource") return "invalid_target";
  if (
    error.code === "invalid_authorization_code" ||
    error.code === "invalid_refresh_token" ||
    error.code === "refresh_token_reuse" ||
    error.code === "grant_inactive" ||
    error.code === "policy_changed"
  ) {
    return "invalid_grant";
  }
  return fallback;
}
