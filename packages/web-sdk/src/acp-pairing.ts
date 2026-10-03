import type { AgentToolDefinition } from "./types.js";

/** @experimental Unstable browser ACP consent and grant errors. */
export type AcpPairingErrorCode =
  | "pairing_required"
  | "pairing_redirected"
  | "denied"
  | "callback_invalid"
  | "expired"
  | "popup_blocked"
  | "cancelled"
  | "timeout"
  | "invalid_grant"
  | "refresh_uncertain"
  | "disposed"
  | "authorization_failed";
/** @experimental Consent is always an explicit application action. */
export class AcpPairingError extends Error {
  constructor(
    readonly code: AcpPairingErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "AcpPairingError";
  }
}
/** @experimental Use session-scoped storage; sharing rotated refresh tokens across tabs is unsafe. */
export interface AcpPairingStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}
/** @experimental Browser pairing configuration. Default mode never opens consent. */
export interface AcpPairingOptions {
  readonly redirectUri?: string;
  readonly mode?: "resume" | "redirect" | "popup";
  readonly callbackUrl?: string;
  readonly clientName?: string;
  readonly storage?: AcpPairingStorage;
  readonly fetch?: typeof fetch;
  readonly timeoutMs?: number;
}
/** @experimental Application-owned credentials; never publish or log this value. */
export interface AcpManagedGrant {
  readonly gatewayUrl: string;
  readonly token: string;
  readonly refreshToken: string;
  readonly grantId: string;
  readonly expiresAt: number;
  readonly refreshExpiresAt: number;
}
interface SharedGrantState {
  revision: number;
  flight: Promise<AcpManagedGrant> | undefined;
}
const storageStates = new WeakMap<
  AcpPairingStorage,
  Map<string, SharedGrantState>
>();
interface Transaction {
  state: string;
  verifier: string;
  expiresAt: number;
  redirectUri: string;
}
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object")
    return `{${Object.entries(value)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`)
      .join(",")}}`;
  return JSON.stringify(value);
}
function safeUrl(value: string): URL {
  const url = new URL(value);
  const loopback = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  if (
    (url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) ||
    url.username ||
    url.password ||
    url.hash
  )
    throw new TypeError(
      "ACP pairing requires HTTPS (HTTP loopback is permitted for development)",
    );
  return url;
}
function b64(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}
function random(): string {
  return b64(crypto.getRandomValues(new Uint8Array(32)));
}
async function digest(value: string): Promise<string> {
  return b64(
    new Uint8Array(
      await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)),
    ),
  );
}
const callbackFields = ["code", "state", "iss", "error", "error_description"];
/** @experimental Call at page startup before loading app assets. Removes OAuth values from history. */
export function captureAcpPairingCallback(): string | undefined {
  if (typeof location === "undefined") return undefined;
  const url = new URL(location.href);
  if (
    !url.searchParams.has("state") ||
    (!url.searchParams.has("code") && !url.searchParams.has("error"))
  )
    return undefined;
  const callback = url.href;
  for (const field of callbackFields) url.searchParams.delete(field);
  history.replaceState(history.state, "", url.href);
  if (window.opener)
    window.opener.postMessage(
      { type: "agent-connect.acp.callback", url: callback },
      location.origin,
    );
  return callback;
}
/** @experimental PKCE pairing and serialized grant rotation, scoped to gateway, app and tools. */
export class AcpPairing {
  private readonly base: string;
  private readonly redirect: string;
  private readonly client: string;
  private readonly storage: AcpPairingStorage;
  private readonly fetcher: typeof fetch;
  private readonly key: Promise<string>;
  private readonly tools: readonly AgentToolDefinition[];
  private readonly abort = new AbortController();
  private current: AcpManagedGrant | undefined;
  private callback: string | undefined;

  private refreshing: Promise<AcpManagedGrant> | undefined;
  private pairing: Promise<AcpManagedGrant> | undefined;
  private disposed = false;
  private cancelPopup: (() => void) | undefined;
  constructor(
    private readonly options: AcpPairingOptions & {
      gatewayUrl: string;
      tools: readonly AgentToolDefinition[];
    },
  ) {
    const gateway = safeUrl(options.gatewayUrl);
    if (gateway.href !== `${gateway.origin}/`)
      throw new TypeError("ACP gateway URL must be an origin");
    this.base = gateway.origin;
    this.callback = options.callbackUrl;
    const redirect = safeUrl(
      options.redirectUri ?? `${location.origin}${location.pathname}`,
    );
    if (typeof location !== "undefined" && redirect.origin !== location.origin)
      throw new TypeError("ACP callback must belong to the application origin");
    if (callbackFields.some((field) => redirect.searchParams.has(field)))
      throw new TypeError(
        "ACP callback URI contains reserved OAuth parameters",
      );
    this.redirect = redirect.href;
    this.client = redirect.origin;
    this.storage = options.storage ?? globalThis.sessionStorage;
    if (!this.storage)
      throw new TypeError("ACP pairing requires session-scoped storage");
    this.fetcher = options.fetch ?? globalThis.fetch.bind(globalThis);
    this.tools = structuredClone(
      options.tools
        .map(({ name, description, inputSchema }) => ({
          name,
          description,
          inputSchema,
        }))
        .sort((a, b) => a.name.localeCompare(b.name)),
    );
    if (new Set(this.tools.map((tool) => tool.name)).size !== this.tools.length)
      throw new TypeError("Duplicate ACP tool names");
    this.key = digest(canonical(this.tools)).then(
      (hash) => `agent-connect:acp:${this.base}:${this.client}:${hash}`,
    );
  }
  private async shared(): Promise<SharedGrantState> {
    const key = await this.key;
    let states = storageStates.get(this.storage);
    if (!states) {
      states = new Map();
      storageStates.set(this.storage, states);
    }
    let state = states.get(key);
    if (!state) {
      state = { revision: 0, flight: undefined };
      states.set(key, state);
    }
    return state;
  }
  private alive() {
    if (this.disposed)
      throw new AcpPairingError("disposed", "ACP pairing was disposed");
  }
  private async request(
    path: string,
    body: URLSearchParams,
  ): Promise<Record<string, unknown>> {
    this.alive();
    const response = await this.fetcher(
      `${this.base}/agent-connect/oauth/${path}`,
      {
        method: "POST",
        body,
        credentials: "omit",
        redirect: "error",
        cache: "no-store",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          Accept: "application/json",
        },
        signal: AbortSignal.any([
          this.abort.signal,
          AbortSignal.timeout(15000),
        ]),
      },
    );
    const text = await response.text();
    if (text.length > 65536)
      throw new AcpPairingError(
        "authorization_failed",
        "Oversized ACP authorization response",
      );
    let data: Record<string, unknown>;
    try {
      data = JSON.parse(text) as Record<string, unknown>;
    } catch {
      throw new AcpPairingError(
        "authorization_failed",
        "Malformed ACP authorization response",
      );
    }
    if (!data || typeof data !== "object" || Array.isArray(data))
      throw new AcpPairingError(
        "authorization_failed",
        "Malformed ACP authorization response",
      );
    if (!response.ok)
      throw new AcpPairingError(
        data["error"] === "invalid_grant"
          ? "invalid_grant"
          : "authorization_failed",
        "ACP authorization request failed",
      );
    this.alive();
    return data;
  }
  private token(
    data: Record<string, unknown>,
    previous?: AcpManagedGrant,
  ): AcpManagedGrant {
    const expected = `${this.base.replace(/^http/, "ws")}/acp`;
    if (
      data["token_type"] !== "Bearer" ||
      data["gateway_url"] !== expected ||
      typeof data["access_token"] !== "string" ||
      !/^[A-Za-z0-9._~-]+$/.test(data["access_token"]) ||
      typeof data["refresh_token"] !== "string" ||
      !/^[A-Za-z0-9._~-]+$/.test(data["refresh_token"]) ||
      typeof data["grant_id"] !== "string" ||
      !data["grant_id"] ||
      typeof data["expires_in"] !== "number" ||
      !Number.isSafeInteger(data["expires_in"]) ||
      data["expires_in"] <= 0 ||
      typeof data["refresh_token_expires_in"] !== "number" ||
      !Number.isSafeInteger(data["refresh_token_expires_in"]) ||
      data["refresh_token_expires_in"] <= 0 ||
      (previous &&
        (data["grant_id"] !== previous.grantId ||
          data["refresh_token"] === previous.refreshToken))
    )
      throw new AcpPairingError(
        "invalid_grant",
        "Invalid ACP token response or changed grant ownership",
      );
    return {
      gatewayUrl: expected,
      token: data["access_token"],
      refreshToken: data["refresh_token"],
      grantId: data["grant_id"],
      expiresAt: Date.now() + data["expires_in"] * 1000,
      refreshExpiresAt: Math.min(
        previous?.refreshExpiresAt ?? Infinity,
        Date.now() + data["refresh_token_expires_in"] * 1000,
      ),
    };
  }
  private async save(grant: AcpManagedGrant) {
    const key = await this.key;
    this.alive();
    this.storage.setItem(key, JSON.stringify(grant));
    this.current = grant;
    return grant;
  }
  private async complete(callbackUrl: string): Promise<AcpManagedGrant> {
    const key = `${await this.key}:transaction`;
    const shared = await this.shared();
    const revision = shared.revision;
    const saved = this.storage.getItem(key);
    this.storage.removeItem(key);
    if (!saved)
      throw new AcpPairingError("callback_invalid", "No pending ACP pairing");
    let transaction: Transaction;
    let callback: URL;
    try {
      transaction = JSON.parse(saved) as Transaction;
      callback = new URL(callbackUrl);
    } catch {
      throw new AcpPairingError(
        "callback_invalid",
        "Invalid ACP pairing callback",
      );
    }
    const redirect = new URL(this.redirect);
    const one = (field: string) =>
      callback.searchParams.getAll(field).length === 1
        ? callback.searchParams.get(field)
        : null;
    const clean = new URL(callback.href);
    for (const field of callbackFields) clean.searchParams.delete(field);
    if (
      clean.href !== redirect.href ||
      transaction.redirectUri !== this.redirect ||
      one("state") !== transaction.state ||
      one("iss") !== this.base ||
      typeof transaction.verifier !== "string" ||
      !/^[A-Za-z0-9_-]{43}$/.test(transaction.verifier) ||
      typeof transaction.expiresAt !== "number"
    )
      throw new AcpPairingError(
        "callback_invalid",
        "ACP callback origin, state or issuer did not match",
      );
    if (transaction.expiresAt <= Date.now())
      throw new AcpPairingError("expired", "ACP pairing expired");
    if (callback.searchParams.has("code") && callback.searchParams.has("error"))
      throw new AcpPairingError(
        "callback_invalid",
        "ACP callback contains both code and error",
      );
    if (one("error"))
      throw new AcpPairingError(
        one("error") === "access_denied" ? "denied" : "authorization_failed",
        "ACP owner declined or could not approve pairing",
      );
    if (!one("code") || callback.searchParams.has("error"))
      throw new AcpPairingError(
        "callback_invalid",
        "ACP callback did not contain one authorization code",
      );
    const grant = this.token(
      await this.request(
        "token",
        new URLSearchParams({
          grant_type: "authorization_code",
          code: one("code")!,
          code_verifier: transaction.verifier,
          client_id: this.client,
          redirect_uri: this.redirect,
          resource: `${this.base}/acp`,
        }),
      ),
    );
    if (revision !== shared.revision)
      throw new AcpPairingError(
        "invalid_grant",
        "ACP pairing was cleared during exchange",
      );
    return this.save(grant);
  }
  /** Reuse or complete a grant. Never opens an approval page. */
  async getGrant(callbackUrl = this.callback): Promise<AcpManagedGrant> {
    this.alive();
    if (callbackUrl) {
      this.callback = undefined;
      return this.complete(callbackUrl);
    }
    const shared = await this.shared();
    this.alive();
    if (shared.flight) return this.save(await shared.flight);
    {
      const saved = this.storage.getItem(await this.key);
      this.current = undefined;
      if (saved) {
        try {
          const grant = JSON.parse(saved) as AcpManagedGrant;
          if (
            grant.gatewayUrl !== `${this.base.replace(/^http/, "ws")}/acp` ||
            typeof grant.grantId !== "string" ||
            !grant.grantId ||
            typeof grant.token !== "string" ||
            !/^[A-Za-z0-9._~-]+$/.test(grant.token) ||
            typeof grant.refreshToken !== "string" ||
            !/^[A-Za-z0-9._~-]+$/.test(grant.refreshToken) ||
            !Number.isFinite(grant.expiresAt) ||
            !Number.isFinite(grant.refreshExpiresAt)
          )
            throw new Error();
          this.current = grant;
        } catch {
          await this.clear();
          throw new AcpPairingError(
            "invalid_grant",
            "Stored ACP grant is invalid",
          );
        }
      }
    }
    this.alive();
    if (!this.current)
      throw new AcpPairingError(
        "pairing_required",
        "Connect explicitly to approve this application's tools",
      );
    if (this.current.refreshExpiresAt <= Date.now()) {
      await this.clear();
      throw new AcpPairingError(
        "expired",
        "ACP grant expired; explicit pairing is required",
      );
    }
    if (this.current.expiresAt > Date.now() + 35000) return this.current;
    return this.refresh();
  }
  /** Current expiry for transport credential reattachment. */
  get expiresAt(): number {
    return this.current?.expiresAt ?? 0;
  }
  /** Single-flight rotation. An uncertain response is never retried with a spent token. */
  async refresh(): Promise<AcpManagedGrant> {
    this.alive();
    if (this.refreshing) return this.refreshing;
    const shared = await this.shared();
    this.alive();
    if (shared.flight) return this.save(await shared.flight);
    const previous = this.current;
    if (!previous)
      throw new AcpPairingError("pairing_required", "No ACP grant to refresh");
    if (previous.refreshExpiresAt <= Date.now()) {
      await this.clear();
      throw new AcpPairingError("expired", "ACP grant expired");
    }
    const revision = shared.revision;
    this.refreshing = (async () => {
      try {
        const grant = this.token(
          await this.request(
            "token",
            new URLSearchParams({
              grant_type: "refresh_token",
              refresh_token: previous.refreshToken,
              client_id: this.client,
              resource: `${this.base}/acp`,
            }),
          ),
          previous,
        );
        if (revision !== shared.revision)
          throw new AcpPairingError(
            "invalid_grant",
            "ACP grant was cleared during refresh",
          );
        return await this.save(grant);
      } catch (error) {
        if (revision === shared.revision) await this.clear();
        else this.current = undefined;
        if (error instanceof AcpPairingError) throw error;
        throw new AcpPairingError(
          "refresh_uncertain",
          "ACP refresh outcome is unknown; explicit pairing is required",
        );
      } finally {
        this.refreshing = undefined;
        shared.flight = undefined;
      }
    })();
    shared.flight = this.refreshing;
    return this.refreshing;
  }
  /** Call directly from a click handler; popup creation precedes all asynchronous work. */
  pair(mode: "popup" | "redirect" = "redirect"): Promise<AcpManagedGrant> {
    this.alive();
    if (this.pairing) return this.pairing;
    const popup =
      mode === "popup"
        ? window.open("about:blank", "_blank", "popup,width=600,height=740")
        : undefined;
    if (mode === "popup" && !popup)
      return Promise.reject(
        new AcpPairingError(
          "popup_blocked",
          "Allow the approval popup or use redirect pairing",
        ),
      );
    this.pairing = this.start(mode, popup ?? undefined).finally(() => {
      this.pairing = undefined;
    });
    return this.pairing;
  }
  private async start(
    mode: "popup" | "redirect",
    popup?: Window,
  ): Promise<AcpManagedGrant> {
    const key = `${await this.key}:transaction`;
    try {
      await this.clear();
      const state = random(),
        verifier = random();
      const body = new URLSearchParams({
        client_id: this.client,
        redirect_uri: this.redirect,
        resource: `${this.base}/acp`,
        response_type: "code",
        scope: "acp",
        state,
        code_challenge: await digest(verifier),
        code_challenge_method: "S256",
        authorization_details: JSON.stringify([
          { type: "agent_connect", tools: this.tools },
        ]),
      });
      if (this.options.clientName)
        body.set("client_name", this.options.clientName);
      const result = await this.request("par", body);
      if (
        typeof result["request_uri"] !== "string" ||
        !result["request_uri"] ||
        typeof result["expires_in"] !== "number" ||
        !Number.isSafeInteger(result["expires_in"]) ||
        result["expires_in"] <= 0
      )
        throw new AcpPairingError(
          "authorization_failed",
          "Invalid ACP pushed authorization response",
        );
      this.storage.setItem(
        key,
        JSON.stringify({
          state,
          verifier,
          redirectUri: this.redirect,
          expiresAt: Date.now() + result["expires_in"] * 1000,
        } satisfies Transaction),
      );
      const authorize = new URL(`${this.base}/agent-connect/oauth/authorize`);
      authorize.search = new URLSearchParams({
        client_id: this.client,
        request_uri: result["request_uri"],
      }).toString();
      if (mode === "redirect") {
        location.assign(authorize.href);
        throw new AcpPairingError(
          "pairing_redirected",
          "Continue pairing on the owner's gateway",
        );
      }
      const callback = await this.waitPopup(popup!, authorize.href);
      return await this.complete(callback);
    } catch (error) {
      if (!(
        error instanceof AcpPairingError && error.code === "pairing_redirected"
      ))
        this.storage.removeItem(key);
      throw error;
    } finally {
      popup?.close();
    }
  }
  private waitPopup(popup: Window, url: string): Promise<string> {
    return new Promise((resolve, reject) => {
      const finish = (callback?: string, error?: AcpPairingError) => {
        clearInterval(poll);
        clearTimeout(timer);
        window.removeEventListener("message", message);
        this.cancelPopup = undefined;
        if (callback) resolve(callback);
        else reject(error);
      };
      const message = (event: MessageEvent) => {
        if (
          event.origin === this.client &&
          event.source === popup &&
          event.data?.type === "agent-connect.acp.callback" &&
          typeof event.data.url === "string"
        )
          finish(event.data.url);
      };
      const poll = setInterval(() => {
        if (popup.closed) {
          finish(
            undefined,
            new AcpPairingError("cancelled", "Approval window was closed"),
          );
          return;
        }
        try {
          if (
            popup.location.origin === this.client &&
            (popup.location.search.includes("code=") ||
              popup.location.search.includes("error="))
          )
            finish(popup.location.href);
        } catch {
          /* Cross-origin consent is unreadable until callback. */
        }
      }, 200);
      const timer = setTimeout(
        () =>
          finish(
            undefined,
            new AcpPairingError("timeout", "ACP approval timed out"),
          ),
        this.options.timeoutMs ?? 300000,
      );
      this.cancelPopup = () =>
        finish(
          undefined,
          new AcpPairingError("disposed", "ACP pairing disposed"),
        );
      window.addEventListener("message", message);
      popup.location.href = url;
    });
  }
  /** Clear local credentials without claiming server-side revocation. */
  async clear(): Promise<void> {
    const shared = await this.shared();
    shared.revision++;
    this.current = undefined;
    const key = await this.key;
    this.storage.removeItem(key);
    this.storage.removeItem(`${key}:transaction`);
    this.cancelPopup?.();
  }
  /** Revoke this app's grant, then clear local credentials even if the response is lost. */
  async revoke(): Promise<void> {
    this.alive();
    const grant = await this.getGrant();
    try {
      const response = await this.fetcher(
        `${this.base}/agent-connect/oauth/revoke`,
        {
          method: "POST",
          body: new URLSearchParams({
            token: grant.refreshToken,
            client_id: this.client,
          }),
          credentials: "omit",
          redirect: "error",
          cache: "no-store",
          signal: AbortSignal.any([
            this.abort.signal,
            AbortSignal.timeout(15000),
          ]),
        },
      );
      if (!response.ok)
        throw new AcpPairingError(
          "authorization_failed",
          "ACP grant revocation failed",
        );
    } finally {
      await this.clear();
    }
  }
  /** Stops owned requests and popup observers; stored grants remain reusable. */
  dispose(): void {
    this.disposed = true;
    this.abort.abort();
    this.cancelPopup?.();
  }
}
/** @experimental Create browser ACP pairing without starting consent. */
export function createAcpPairing(
  options: AcpPairingOptions & {
    gatewayUrl: string;
    tools: readonly AgentToolDefinition[];
  },
): AcpPairing {
  return new AcpPairing(options);
}
