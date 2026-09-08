export type OpenClawUpstreamAuth =
  | { readonly mode: "token"; readonly credential: string }
  | { readonly mode: "password"; readonly credential: string }
  | { readonly mode: "none" };

export function resolveOpenClawUpstreamAuth(options: {
  readonly upstreamAuth?: OpenClawUpstreamAuth;
  readonly upstreamToken?: string;
}): OpenClawUpstreamAuth {
  if (options.upstreamAuth && options.upstreamToken !== undefined) {
    throw new TypeError("Specify upstreamAuth or upstreamToken, not both");
  }
  if (options.upstreamAuth) {
    if (
      options.upstreamAuth.mode !== "none" &&
      options.upstreamAuth.credential.length === 0
    ) {
      throw new TypeError("OpenClaw upstream token must not be empty");
    }
    return options.upstreamAuth;
  }
  if (typeof options.upstreamToken === "string" && options.upstreamToken) {
    return { mode: "token", credential: options.upstreamToken };
  }
  throw new TypeError("OpenClaw upstream authentication must be explicit");
}

export function openClawHttpAuthHeaders(
  auth: OpenClawUpstreamAuth,
): Readonly<Record<string, string>> {
  return auth.mode === "none"
    ? {}
    : { authorization: `Bearer ${auth.credential}` };
}
