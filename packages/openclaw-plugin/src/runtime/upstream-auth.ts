export type OpenClawUpstreamAuth =
  | { readonly mode: "token"; readonly credential: string }
  | { readonly mode: "password"; readonly credential: string }
  | { readonly mode: "none" };

export function requireOpenClawUpstreamAuth(
  auth: OpenClawUpstreamAuth,
): OpenClawUpstreamAuth {
  if (auth.mode !== "none" && auth.credential.length === 0) {
    throw new TypeError("OpenClaw upstream credential must not be empty");
  }
  return auth;
}

export function openClawHttpAuthHeaders(
  auth: OpenClawUpstreamAuth,
): Readonly<Record<string, string>> {
  return auth.mode === "none"
    ? {}
    : { authorization: `Bearer ${auth.credential}` };
}
