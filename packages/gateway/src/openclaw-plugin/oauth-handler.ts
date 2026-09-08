import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";

import { consentPage, errorPage } from "./consent-html.js";
import {
  FIXED_TOOLS_AUTHORIZATION_DETAIL,
  OPENCLAW_MODEL_ALIAS,
  RESPONSES_SCOPE,
  STANDALONE_ENDPOINT_LAYOUT,
  type AgentConnectEndpointLayout,
  type AuthenticatedOwnerPrincipal,
  type OpenClawOAuthOptions,
} from "./contracts.js";
import {
  MAX_URL_BYTES,
  appCors,
  appPreflight,
  methodNotAllowed,
  noStore,
  readForm,
  redirectAuthorization,
  required,
  requireOnly,
  requireValue,
  sendHtml,
  sendJson,
} from "./http.js";
import {
  OAuthRequestError,
  canonicalIssuer,
  canonicalResource,
  exactGet,
  oauthJsonError,
  parseAuthorizationDetails,
  publicCors,
  requireAppOrigin,
  requireSameOrigin,
} from "./oauth-utils.js";

const CSRF_TTL_MS = 10 * 60 * 1000;
const OWNER_SCOPE = "operator.admin";

interface CsrfRecord {
  readonly hash: Buffer;
  readonly ownerProfileId: string;
  readonly requestUri: string;
  readonly policyRefs: readonly string[];
  readonly expiresAt: number;
}

export class OpenClawOAuthHandler {
  readonly issuer: string;
  readonly resource: string;
  private readonly options: OpenClawOAuthOptions;
  private readonly now: () => number;
  private readonly endpoints: AgentConnectEndpointLayout;
  private readonly csrf = new Map<string, CsrfRecord>();

  constructor(options: OpenClawOAuthOptions) {
    this.endpoints = options.endpoints ?? STANDALONE_ENDPOINT_LAYOUT;
    this.issuer = canonicalIssuer(options.issuer, this.endpoints.issuerPath);
    this.resource = canonicalResource(
      options.resource,
      this.issuer,
      this.endpoints.responsesPath,
    );
    if (options.grantService.resource !== this.resource) {
      throw new Error("grant service resource does not match plugin resource");
    }
    if (options.allowedOwnerProfileIds.length === 0) {
      throw new Error("at least one owner profile must be configured");
    }
    this.options = options;
    this.now = options.now ?? Date.now;
  }

  async handle(
    request: IncomingMessage,
    response: ServerResponse,
  ): Promise<void> {
    if (!request.url || Buffer.byteLength(request.url) > MAX_URL_BYTES) {
      return sendJson(response, 414, { error: "invalid_request" });
    }
    const url = new URL(request.url, this.issuer);
    if (url.pathname === this.endpoints.authorizationServerMetadataPath) {
      return this.authorizationServerMetadata(request, response, url);
    }
    if (url.pathname === this.endpoints.protectedResourceMetadataPath) {
      return this.protectedResourceMetadata(request, response, url);
    }
    if (url.pathname === this.endpoints.parPath) {
      return this.par(request, response, url);
    }
    if (url.pathname === this.endpoints.authorizationPath) {
      return this.authorize(request, response, url);
    }
    if (url.pathname === this.endpoints.tokenPath) {
      return this.token(request, response, url);
    }
    if (url.pathname === this.endpoints.revocationPath) {
      return this.revoke(request, response, url);
    }
    sendJson(response, 404, { error: "not_found" });
  }

  private authorizationServerMetadata(
    request: IncomingMessage,
    response: ServerResponse,
    url: URL,
  ): void {
    if (!exactGet(request, url)) return methodNotAllowed(response, "GET");
    publicCors(request, response);
    sendJson(response, 200, {
      issuer: this.issuer,
      authorization_endpoint: endpointUrl(
        this.issuer,
        this.endpoints.authorizationPath,
      ),
      token_endpoint: endpointUrl(this.issuer, this.endpoints.tokenPath),
      revocation_endpoint: endpointUrl(
        this.issuer,
        this.endpoints.revocationPath,
      ),
      pushed_authorization_request_endpoint: endpointUrl(
        this.issuer,
        this.endpoints.parPath,
      ),
      response_types_supported: ["code"],
      grant_types_supported: ["authorization_code", "refresh_token"],
      token_endpoint_auth_methods_supported: ["none"],
      code_challenge_methods_supported: ["S256"],
      scopes_supported: [RESPONSES_SCOPE],
      authorization_details_types_supported: [FIXED_TOOLS_AUTHORIZATION_DETAIL],
      require_pushed_authorization_requests: true,
      authorization_response_iss_parameter_supported: true,
    });
  }

  private protectedResourceMetadata(
    request: IncomingMessage,
    response: ServerResponse,
    url: URL,
  ): void {
    if (!exactGet(request, url)) return methodNotAllowed(response, "GET");
    publicCors(request, response);
    sendJson(response, 200, {
      resource: this.resource,
      authorization_servers: [this.issuer],
      scopes_supported: [RESPONSES_SCOPE],
      bearer_methods_supported: ["header"],
      authorization_details_types_supported: [FIXED_TOOLS_AUTHORIZATION_DETAIL],
      agent_connect_model: OPENCLAW_MODEL_ALIAS,
    });
  }

  private async par(
    request: IncomingMessage,
    response: ServerResponse,
    url: URL,
  ): Promise<void> {
    if (request.method === "OPTIONS") return appPreflight(request, response);
    if (request.method !== "POST" || url.search !== "") {
      return methodNotAllowed(response, "POST, OPTIONS");
    }
    try {
      const form = await readForm(request);
      requireOnly(form, [
        "client_id",
        "redirect_uri",
        "response_type",
        "scope",
        "resource",
        "state",
        "code_challenge",
        "code_challenge_method",
        "authorization_details",
      ]);
      requireValue(form, "response_type", "code");
      requireValue(form, "scope", RESPONSES_SCOPE);
      requireValue(form, "code_challenge_method", "S256");
      const clientId = required(form, "client_id");
      requireAppOrigin(request, clientId);
      const applicationTools = parseAuthorizationDetails(
        required(form, "authorization_details"),
      );
      const pending = this.options.grantService.createRequest({
        clientId,
        redirectUri: required(form, "redirect_uri"),
        resource: required(form, "resource"),
        state: required(form, "state"),
        codeChallenge: required(form, "code_challenge"),
        codeChallengeMethod: "S256",
        applicationTools,
      });
      appCors(request, response, clientId);
      noStore(response);
      sendJson(response, 201, {
        request_uri: pending.requestUri,
        expires_in: Math.max(
          1,
          Math.ceil((pending.expiresAt - this.now()) / 1000),
        ),
      });
    } catch (error) {
      oauthJsonError(request, response, error, "invalid_request");
    }
  }

  private async authorize(
    request: IncomingMessage,
    response: ServerResponse,
    url: URL,
  ): Promise<void> {
    noStore(response);
    const owner = await this.verifyOwner(request);
    if (!owner) return ownerDenied(response);
    if (request.method === "GET") return this.showConsent(response, url, owner);
    if (request.method === "POST" && url.search === "") {
      return this.decide(request, response, owner);
    }
    methodNotAllowed(response, "GET, POST");
  }

  private showConsent(
    response: ServerResponse,
    url: URL,
    owner: AuthenticatedOwnerPrincipal,
  ): void {
    let clientId: string;
    let requestUri: string;
    try {
      requireOnly(url.searchParams, ["client_id", "request_uri"]);
      clientId = required(url.searchParams, "client_id");
      requestUri = required(url.searchParams, "request_uri");
    } catch {
      return sendHtml(
        response,
        400,
        errorPage("Invalid authorization request."),
      );
    }
    const pending = this.options.grantService.getRequest(requestUri);
    if (!pending || pending.clientId !== clientId) {
      return sendHtml(
        response,
        400,
        errorPage("Authorization request expired or invalid."),
      );
    }
    const policies = this.options.grantService.listOfferedPolicies();
    const defaultPolicyIndex = policies.findIndex(
      (policy) => policy.nativeCapabilities.length === 0,
    );
    if (defaultPolicyIndex < 0) {
      return sendHtml(
        response,
        500,
        errorPage("No application-tools-only policy is configured."),
      );
    }
    this.pruneCsrf();
    const csrfToken = randomBytes(32).toString("base64url");
    this.csrf.set(requestUri, {
      hash: csrfHash(csrfToken),
      ownerProfileId: owner.profileId,
      requestUri,
      policyRefs: policies.map((policy) => policy.ref),
      expiresAt: this.now() + CSRF_TTL_MS,
    });
    sendHtml(
      response,
      200,
      consentPage({
        clientId,
        requestUri,
        csrfToken,
        tools: pending.applicationTools.map((tool) => tool.name),
        policies,
        defaultPolicyIndex,
      }),
      pending.redirectUri,
    );
  }

  private async decide(
    request: IncomingMessage,
    response: ServerResponse,
    owner: AuthenticatedOwnerPrincipal,
  ): Promise<void> {
    try {
      requireSameOrigin(request, this.issuer);
      const form = await readForm(request);
      requireOnly(form, [
        "request_uri",
        "csrf_token",
        "decision",
        "policy_choice",
      ]);
      const requestUri = required(form, "request_uri");
      const csrf = this.consumeCsrf(
        requestUri,
        required(form, "csrf_token"),
        owner.profileId,
      );
      const pending = this.options.grantService.getRequest(requestUri);
      if (!pending) throw new Error("expired request");
      const decision = required(form, "decision");
      if (decision === "deny") {
        const denied = this.options.grantService.deny(requestUri);
        return redirectAuthorization(response, denied.redirectUri, {
          error: "access_denied",
          state: denied.state,
          iss: this.issuer,
        });
      }
      if (decision !== "allow") throw new Error("invalid decision");
      const choice = Number(required(form, "policy_choice"));
      const policyRef = Number.isSafeInteger(choice)
        ? csrf.policyRefs[choice]
        : undefined;
      if (!policyRef) throw new Error("invalid policy choice");
      const approved = this.options.grantService.approve(requestUri, {
        ownerSubject: `openclaw-profile:${owner.profileId}`,
        policyRef,
      });
      redirectAuthorization(response, approved.request.redirectUri, {
        code: approved.code,
        state: approved.request.state,
        iss: this.issuer,
      });
    } catch {
      sendHtml(response, 403, errorPage("Consent could not be completed."));
    }
  }

  private async token(
    request: IncomingMessage,
    response: ServerResponse,
    url: URL,
  ): Promise<void> {
    if (request.method === "OPTIONS") return appPreflight(request, response);
    if (request.method !== "POST" || url.search !== "") {
      return methodNotAllowed(response, "POST, OPTIONS");
    }
    try {
      const form = await readForm(request);
      const grantType = required(form, "grant_type");
      const clientId = required(form, "client_id");
      requireAppOrigin(request, clientId);
      let result;
      if (grantType === "authorization_code") {
        requireOnly(form, [
          "grant_type",
          "code",
          "code_verifier",
          "client_id",
          "redirect_uri",
          "resource",
        ]);
        result = this.options.grantService.exchange({
          code: required(form, "code"),
          codeVerifier: required(form, "code_verifier"),
          clientId,
          redirectUri: required(form, "redirect_uri"),
          resource: required(form, "resource"),
        });
      } else if (grantType === "refresh_token") {
        requireOnly(form, [
          "grant_type",
          "refresh_token",
          "client_id",
          "resource",
        ]);
        result = this.options.grantService.refresh({
          refreshToken: required(form, "refresh_token"),
          clientId,
          resource: required(form, "resource"),
        });
      } else {
        throw new OAuthRequestError("unsupported_grant_type");
      }
      appCors(request, response, clientId);
      noStore(response);
      sendJson(response, 200, {
        access_token: result.accessToken,
        refresh_token: result.refreshToken,
        token_type: result.tokenType,
        expires_in: result.expiresIn,
        refresh_token_expires_in: result.refreshTokenExpiresIn,
        scope: RESPONSES_SCOPE,
      });
    } catch (error) {
      oauthJsonError(request, response, error, "invalid_grant");
    }
  }

  private async revoke(
    request: IncomingMessage,
    response: ServerResponse,
    url: URL,
  ): Promise<void> {
    if (request.method === "OPTIONS") return appPreflight(request, response);
    if (request.method !== "POST" || url.search !== "") {
      return methodNotAllowed(response, "POST, OPTIONS");
    }
    try {
      const form = await readForm(request);
      requireOnly(form, ["token", "token_type_hint", "client_id"]);
      const clientId = required(form, "client_id");
      requireAppOrigin(request, clientId);
      this.options.grantService.revokeByToken(
        required(form, "token"),
        clientId,
      );
      appCors(request, response, clientId);
      noStore(response);
      response.writeHead(200, { "content-length": "0" });
      response.end();
    } catch (error) {
      oauthJsonError(request, response, error, "invalid_request");
    }
  }

  private async verifyOwner(
    request: IncomingMessage,
  ): Promise<AuthenticatedOwnerPrincipal | undefined> {
    const principal = await this.options.ownerVerifier(request);
    return principal &&
      principal.scopes.includes(OWNER_SCOPE) &&
      this.options.allowedOwnerProfileIds.includes(principal.profileId)
      ? principal
      : undefined;
  }

  private consumeCsrf(
    requestUri: string,
    token: string,
    ownerProfileId: string,
  ): CsrfRecord {
    this.pruneCsrf();
    const record = this.csrf.get(requestUri);
    this.csrf.delete(requestUri);
    const actual = csrfHash(token);
    if (
      !record ||
      record.expiresAt <= this.now() ||
      record.ownerProfileId !== ownerProfileId ||
      record.requestUri !== requestUri ||
      !timingSafeEqual(record.hash, actual)
    ) {
      throw new Error("invalid csrf");
    }
    return record;
  }

  private pruneCsrf(): void {
    const now = this.now();
    for (const [requestUri, record] of this.csrf) {
      if (record.expiresAt <= now) this.csrf.delete(requestUri);
    }
  }
}

function ownerDenied(response: ServerResponse): void {
  response.setHeader("www-authenticate", 'OpenClawOwner realm="consent"');
  sendHtml(
    response,
    401,
    errorPage("Verified owner authentication is required."),
  );
}

function csrfHash(value: string): Buffer {
  return createHash("sha256").update(value).digest();
}

function endpointUrl(issuer: string, pathname: string): string {
  return `${new URL(issuer).origin}${pathname}`;
}
