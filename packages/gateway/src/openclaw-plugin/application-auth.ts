import type {
  DelegatedGrantService,
  VerifiedDelegatedGrant,
} from "../delegated-grants.js";
import type {
  HostHttpRequest,
  OpenResponsesApplicationAuthProvider,
} from "./contracts.js";

const ACCESS_PREFIX = "ac_access_";
const ALLOWED_BROWSER_HEADERS = [
  "authorization",
  "content-type",
  "accept",
] as const;

export function createOpenResponsesApplicationAuthProvider(options: {
  readonly resource: string;
  readonly grantService: DelegatedGrantService;
}): OpenResponsesApplicationAuthProvider {
  return {
    resolveBrowserOrigin(request) {
      const origin = singleHeader(request.headers, "origin");
      return origin && isCanonicalHttpsOrigin(origin)
        ? { origin, allowHeaders: ALLOWED_BROWSER_HEADERS }
        : null;
    },
    authenticate(request) {
      const authorization = singleHeader(request.headers, "authorization");
      const bearer = authorization?.match(/^Bearer\s+(.+)$/i)?.[1];
      if (!bearer?.startsWith(ACCESS_PREFIX)) {
        return { status: "pass" };
      }
      const origin = singleHeader(request.headers, "origin");
      if (origin && !isCanonicalHttpsOrigin(origin)) {
        return { status: "deny", reason: "invalid_browser_origin" };
      }
      const verified = options.grantService.verify(bearer, {
        resource: options.resource,
        ...(origin ? { origin } : {}),
      });
      if (!verified) {
        return { status: "deny", reason: "invalid_application_credential" };
      }
      return {
        status: "authenticated",
        principal: {
          subject: verified.subject,
          policyRef: verified.policyRef,
          policyRevision: verified.policyFingerprint,
          context: verified,
        },
      };
    },
    authorize({ principal, request }) {
      const verified = asVerifiedGrant(principal.context);
      return (
        verified !== undefined &&
        principal.subject === verified.subject &&
        principal.policyRef === verified.policyRef &&
        principal.policyRevision === verified.policyFingerprint &&
        !request.hasMediaInput &&
        request.clientTools.every(
          (tool) =>
            tool.strict === undefined && Boolean(tool.description?.trim()),
        ) &&
        options.grantService.recheck(verified, {
          applicationTools: request.clientTools,
        })
      );
    },
  };
}

function asVerifiedGrant(value: unknown): VerifiedDelegatedGrant | undefined {
  if (!value || typeof value !== "object") return undefined;
  const record = value as Partial<VerifiedDelegatedGrant>;
  return typeof record.grantId === "string" &&
    typeof record.authorizationVersion === "string" &&
    typeof record.accessTokenVersion === "string"
    ? (value as VerifiedDelegatedGrant)
    : undefined;
}

function isCanonicalHttpsOrigin(value: string): boolean {
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

function singleHeader(
  headers: HostHttpRequest["headers"],
  name: string,
): string | undefined {
  const direct = headers[name] ?? headers[name.toLowerCase()];
  return typeof direct === "string" ? direct : undefined;
}
