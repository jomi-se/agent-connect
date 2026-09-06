import type { IncomingMessage, ServerResponse } from "node:http";

export const MAX_FORM_BYTES = 64 * 1024;
export const MAX_URL_BYTES = 8 * 1024;

export class OAuthRequestError extends Error {
  constructor(readonly oauthCode: string) {
    super(oauthCode);
  }
}

export async function readForm(
  request: IncomingMessage,
): Promise<URLSearchParams> {
  const contentType = request.headers["content-type"]?.split(";", 1)[0]?.trim();
  if (contentType !== "application/x-www-form-urlencoded") {
    throw new OAuthRequestError("invalid_request");
  }
  const declared = Number(request.headers["content-length"] ?? 0);
  if (!Number.isFinite(declared) || declared > MAX_FORM_BYTES) {
    throw new OAuthRequestError("invalid_request");
  }
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > MAX_FORM_BYTES) throw new OAuthRequestError("invalid_request");
    chunks.push(buffer);
  }
  return new URLSearchParams(Buffer.concat(chunks).toString("utf8"));
}

export function requireOnly(
  params: URLSearchParams,
  allowed: readonly string[],
): void {
  const allowedSet = new Set(allowed);
  for (const key of new Set(params.keys())) {
    if (!allowedSet.has(key) || params.getAll(key).length !== 1) {
      throw new OAuthRequestError("invalid_request");
    }
  }
}

export function required(params: URLSearchParams, key: string): string {
  const values = params.getAll(key);
  if (values.length !== 1 || values[0] === "") {
    throw new OAuthRequestError("invalid_request");
  }
  return values[0] as string;
}

export function requireValue(
  params: URLSearchParams,
  key: string,
  expected: string,
): void {
  if (required(params, key) !== expected) {
    throw new OAuthRequestError("invalid_request");
  }
}

export function isCanonicalHttpsOrigin(value: string): boolean {
  try {
    const url = new URL(value);
    return (
      url.protocol === "https:" &&
      value === url.origin &&
      url.username === "" &&
      url.password === ""
    );
  } catch {
    return false;
  }
}

export function appPreflight(
  request: IncomingMessage,
  response: ServerResponse,
): void {
  const origin = request.headers.origin;
  const requestedMethod = request.headers["access-control-request-method"];
  const requestedHeaders = String(
    request.headers["access-control-request-headers"] ?? "",
  )
    .split(",")
    .map((header) => header.trim().toLowerCase())
    .filter(Boolean);
  if (
    !origin ||
    !isCanonicalHttpsOrigin(origin) ||
    requestedMethod !== "POST" ||
    requestedHeaders.some((header) => header !== "content-type")
  ) {
    return sendJson(response, 403, { error: "invalid_request" });
  }
  response.writeHead(204, {
    "access-control-allow-origin": origin,
    "access-control-allow-methods": "POST",
    "access-control-allow-headers": "content-type",
    "access-control-max-age": "600",
    vary: "Origin",
  });
  response.end();
}

export function appCors(
  request: IncomingMessage,
  response: ServerResponse,
  clientId: string,
): void {
  if (request.headers.origin === clientId) {
    response.setHeader("access-control-allow-origin", clientId);
    response.setHeader("vary", "Origin");
  }
}

export function noStore(response: ServerResponse): void {
  response.setHeader("cache-control", "no-store");
  response.setHeader("pragma", "no-cache");
}

export function sendJson(
  response: ServerResponse,
  status: number,
  value: Readonly<Record<string, unknown>>,
): void {
  const body = JSON.stringify(value);
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(body),
    "x-content-type-options": "nosniff",
  });
  response.end(body);
}

export function methodNotAllowed(
  response: ServerResponse,
  allow: string,
): void {
  response.setHeader("allow", allow);
  sendJson(response, 405, { error: "method_not_allowed" });
}

export function sendHtml(
  response: ServerResponse,
  status: number,
  body: string,
  authorizedRedirectUri?: string,
): void {
  // Browsers apply form-action to the eventual 303 target as well as the POST.
  // Callers supply only the redirect URI from the validated authorization request.
  const redirectOrigin = authorizedRedirectUri
    ? new URL(authorizedRedirectUri).origin
    : undefined;
  response.writeHead(status, {
    "content-type": "text/html; charset=utf-8",
    "content-length": Buffer.byteLength(body),
    "content-security-policy": `default-src 'none'; style-src 'unsafe-inline'; form-action 'self'${redirectOrigin ? ` ${redirectOrigin}` : ""}; frame-ancestors 'none'; base-uri 'none'`,
    "x-frame-options": "DENY",
    "x-content-type-options": "nosniff",
    // HTML form POSTs use an opaque Origin under no-referrer in Chromium.
    // Preserve same-origin CSRF verification without cross-origin referrer leaks.
    "referrer-policy": "same-origin",
  });
  response.end(body);
}

export function redirectAuthorization(
  response: ServerResponse,
  redirectUri: string,
  params: Readonly<Record<string, string>>,
): void {
  const target = new URL(redirectUri);
  for (const [key, value] of Object.entries(params)) {
    target.searchParams.set(key, value);
  }
  response.writeHead(303, {
    location: target.href,
    "cache-control": "no-store",
    pragma: "no-cache",
  });
  response.end();
}
