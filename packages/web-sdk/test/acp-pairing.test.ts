import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  AcpPairing,
  captureAcpPairingCallback,
  createAcpPairing,
  type AcpPairingOptions,
} from "../src/acp-pairing.js";
import { connectAgent } from "../src/acp-provider.js";
import { Peer } from "./acp-fixture.js";
const tools = [
  {
    name: "read",
    description: "Read selection",
    inputSchema: { type: "object" as const },
  },
];
const origin = "https://app.example";
const gateway = "https://gateway.example";
let store: Map<string, string>;
let par: URLSearchParams;
let requests: { url: string; body: URLSearchParams }[];
let tokenReply: Record<string, unknown>;
let tokenStatus: number;
let locationMock: {
  href: string;
  origin: string;
  pathname: string;
  assign: ReturnType<typeof vi.fn>;
};
let windowMock: EventTarget & { open: ReturnType<typeof vi.fn>; opener: null };
let fetchMock: ReturnType<typeof vi.fn<typeof fetch>>;
let controllers: AcpPairing[];
beforeEach(() => {
  store = new Map();
  requests = [];
  controllers = [];
  tokenStatus = 200;
  tokenReply = {
    access_token: "access-1",
    refresh_token: "refresh-1",
    grant_id: "grant-stable",
    gateway_url: "wss://gateway.example/acp",
    token_type: "Bearer",
    expires_in: 300,
    refresh_token_expires_in: 86400,
  };
  locationMock = {
    href: `${origin}/callback`,
    origin,
    pathname: "/callback",
    assign: vi.fn(),
  };
  windowMock = Object.assign(new EventTarget(), {
    open: vi.fn(),
    opener: null,
  });
  vi.stubGlobal("location", locationMock);
  vi.stubGlobal("window", windowMock);
  vi.stubGlobal("history", { state: null, replaceState: vi.fn() });
  vi.stubGlobal("sessionStorage", {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => store.set(key, value),
    removeItem: (key: string) => store.delete(key),
  });
  fetchMock = vi.fn(async (url, init) => {
    const body = new URLSearchParams(init?.body as URLSearchParams);
    requests.push({ url: String(url), body });
    if (String(url).endsWith("/par")) {
      par = body;
      return Response.json({ request_uri: "urn:request:one", expires_in: 300 });
    }
    if (String(url).endsWith("/revoke"))
      return new Response(null, { status: 200 });
    return Response.json(tokenReply, { status: tokenStatus });
  });
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => {
  for (const controller of controllers) controller.dispose();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});
function pairing(extra: AcpPairingOptions = {}) {
  const controller = createAcpPairing({ gatewayUrl: gateway, tools, ...extra });
  controllers.push(controller);
  return controller;
}
function callback(extra: Record<string, string> = {}) {
  return `${origin}/callback?${new URLSearchParams({ code: "one-use-code", state: par.get("state")!, iss: gateway, ...extra })}`;
}
async function begin(controller = pairing()) {
  await expect(controller.pair("redirect")).rejects.toMatchObject({
    code: "pairing_redirected",
  });
  return controller;
}
async function approved(extra: AcpPairingOptions = {}) {
  const controller = await begin(pairing(extra));
  await controller.getGrant(callback());
  return controller;
}
describe("experimental browser ACP PKCE pairing", () => {
  it("uses the browser global receiver for default fetch throughout the grant lifecycle", async () => {
    vi.stubGlobal(
      "fetch",
      function (this: typeof globalThis, ...args: Parameters<typeof fetch>) {
        if (this !== globalThis) throw new TypeError("Illegal invocation");
        return fetchMock(...args);
      },
    );
    const controller = await approved();
    tokenReply = {
      ...tokenReply,
      access_token: "access-2",
      refresh_token: "refresh-2",
    };
    expect((await controller.refresh()).token).toBe("access-2");
    await controller.revoke();
    expect(requests.map(({ url }) => url.split("/").at(-1))).toEqual([
      "par",
      "token",
      "token",
      "revoke",
    ]);
  });
  it("preserves an explicitly injected fetch adapter", async () => {
    const browserFetch = vi.fn(() => {
      throw new TypeError("Browser fetch must not be used");
    });
    vi.stubGlobal("fetch", browserFetch);
    const controller = await approved({ fetch: fetchMock });
    await controller.revoke();
    expect(browserFetch).not.toHaveBeenCalled();
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });
  it("binds approval and exchange to app origin, resource and exact tool snapshot without exposing verifier", async () => {
    const controller = await begin();
    expect(par.get("client_id")).toBe(origin);
    expect(par.get("redirect_uri")).toBe(`${origin}/callback`);
    expect(par.get("scope")).toBe("acp");
    expect(par.get("resource")).toBe(`${gateway}/acp`);
    expect(par.get("code_challenge_method")).toBe("S256");
    expect(JSON.parse(par.get("authorization_details")!)).toEqual([
      { type: "agent_connect", tools },
    ]);
    const url = new URL(locationMock.assign.mock.calls[0]![0] as string);
    expect([...url.searchParams.keys()].sort()).toEqual([
      "client_id",
      "request_uri",
    ]);
    expect(par.has("code_verifier")).toBe(false);
    const grant = await controller.getGrant(callback());
    expect(grant.grantId).toBe("grant-stable");
    expect(grant.expiresAt).toBeGreaterThan(Date.now());
    const exchange = requests[1]!.body;
    expect(exchange.get("client_id")).toBe(origin);
    expect(exchange.get("redirect_uri")).toBe(`${origin}/callback`);
    expect(exchange.get("resource")).toBe(`${gateway}/acp`);
    const digest = new Uint8Array(
      await crypto.subtle.digest(
        "SHA-256",
        new TextEncoder().encode(exchange.get("code_verifier")!),
      ),
    );
    expect(
      btoa(String.fromCharCode(...digest))
        .replace(/\+/g, "-")
        .replace(/\//g, "_")
        .replace(/=+$/, ""),
    ).toBe(par.get("code_challenge"));
    expect((await pairing().getGrant()).grantId).toBe(grant.grantId);
    expect(requests).toHaveLength(2);
    await expect(controller.getGrant(callback())).rejects.toMatchObject({
      code: "callback_invalid",
    });
  });
  it.each(["state", "iss", "origin", "path", "duplicate", "extra"])(
    "rejects mismatched %s callback before exchanging secrets",
    async (field) => {
      const controller = await begin();
      let url = callback();
      if (field === "state") url = callback({ state: "wrong" });
      if (field === "iss") url = callback({ iss: "https://other.example" });
      if (field === "origin") url = url.replace(origin, "https://evil.example");
      if (field === "path") url = url.replace("/callback?", "/wrong?");
      if (field === "duplicate") url += "&state=wrong";
      if (field === "extra") url += "&unregistered=value";
      await expect(controller.getGrant(url)).rejects.toMatchObject({
        code: "callback_invalid",
      });
      expect(requests).toHaveLength(1);
    },
  );
  it("reports denial and expired requests without making token calls", async () => {
    const denied = await begin();
    const url = new URL(callback());
    url.searchParams.delete("code");
    url.searchParams.set("error", "access_denied");
    await expect(denied.getGrant(url.href)).rejects.toMatchObject({
      code: "denied",
    });
    const expired = await begin();
    vi.useFakeTimers();
    vi.advanceTimersByTime(301000);
    await expect(expired.getGrant(callback())).rejects.toMatchObject({
      code: "expired",
    });
    expect(requests.filter((r) => r.url.endsWith("/token"))).toHaveLength(0);
  });
  it("scopes stored grants to gateway, app and snapshot; requires explicit consent", async () => {
    await approved();
    const changed = createAcpPairing({ gatewayUrl: gateway, tools: [] });
    controllers.push(changed);
    await expect(changed.getGrant()).rejects.toMatchObject({
      code: "pairing_required",
    });
    const other = createAcpPairing({
      gatewayUrl: "https://other.example",
      tools,
    });
    controllers.push(other);
    await expect(other.getGrant()).rejects.toMatchObject({
      code: "pairing_required",
    });
    expect(requests.filter((r) => r.url.endsWith("/par"))).toHaveLength(1);
  });
  it.each([
    "http://gateway.example",
    "https://gateway.example/path",
    "https://user:secret@gateway.example",
    "https://gateway.example/#fragment",
  ])("rejects unsafe gateway %s", (gatewayUrl) => {
    expect(() => createAcpPairing({ gatewayUrl, tools })).toThrow(TypeError);
  });
  it("rejects redirect to another app and reserved OAuth query parameters", () => {
    expect(() =>
      pairing({ redirectUri: "https://evil.example/callback" }),
    ).toThrow(TypeError);
    expect(() =>
      pairing({ redirectUri: `${origin}/callback?state=app-value` }),
    ).toThrow(TypeError);
  });
  it("supports HTTP loopback for local development", () => {
    expect(() => pairing({ redirectUri: `${origin}/callback` })).not.toThrow();
    const controller = createAcpPairing({
      gatewayUrl: "http://127.0.0.1:7890",
      tools,
    });
    controllers.push(controller);
  });
  it("captures and strips callback values before app startup and notifies popup opener", () => {
    locationMock.href = `${origin}/callback?keep=1&code=private&state=s&iss=${gateway}`;
    const captured = locationMock.href;
    const opener = { postMessage: vi.fn() };
    Object.assign(windowMock, { opener });
    expect(captureAcpPairingCallback()).toBe(captured);
    expect(history.replaceState).toHaveBeenCalledWith(
      null,
      "",
      `${origin}/callback?keep=1`,
    );
    expect(opener.postMessage).toHaveBeenCalledWith(
      { type: "agent-connect.acp.callback", url: captured },
      origin,
    );
  });
  it("opens a popup synchronously before starting PAR and reports a blocked popup", async () => {
    const pending = pairing().pair("popup");
    expect(windowMock.open).toHaveBeenCalledOnce();
    expect(fetchMock).not.toHaveBeenCalled();
    await expect(pending).rejects.toMatchObject({ code: "popup_blocked" });
  });
  it.each(["cancel", "timeout", "dispose"])(
    "releases popup observers on %s",
    async (kind) => {
      vi.useFakeTimers();
      const popup = {
        closed: false,
        location: { href: "about:blank", origin: "null", search: "" },
        close: vi.fn(),
      };
      windowMock.open.mockReturnValue(popup);
      const controller = pairing({ timeoutMs: 500 });
      const remove = vi.spyOn(windowMock, "removeEventListener");
      const pending = controller.pair("popup");
      const expectation = expect(pending).rejects.toMatchObject({
        code:
          kind === "cancel"
            ? "cancelled"
            : kind === "dispose"
              ? "disposed"
              : "timeout",
      });
      await vi.waitFor(() =>
        expect(popup.location.href).toContain("/authorize"),
      );
      if (kind === "cancel") {
        popup.closed = true;
        await vi.advanceTimersByTimeAsync(200);
      }
      if (kind === "timeout") await vi.advanceTimersByTimeAsync(500);
      if (kind === "dispose") controller.dispose();
      await expectation;
      expect(popup.close).toHaveBeenCalled();
      expect(remove).toHaveBeenCalledWith("message", expect.any(Function));
    },
  );
  it("validates popup message source and origin before approval", async () => {
    const popup = {
      closed: false,
      location: { href: "about:blank", origin: "null", search: "" },
      close: vi.fn(),
    };
    windowMock.open.mockReturnValue(popup);
    const controller = pairing();
    const pending = controller.pair("popup");
    await vi.waitFor(() => expect(popup.location.href).toContain("/authorize"));
    const send = (source: unknown, messageOrigin: string) => {
      const event = new Event("message");
      Object.assign(event, {
        source,
        origin: messageOrigin,
        data: { type: "agent-connect.acp.callback", url: callback() },
      });
      windowMock.dispatchEvent(event);
    };
    send({}, origin);
    send(popup, "https://evil.example");
    expect(requests).toHaveLength(1);
    send(popup, origin);
    expect((await pending).grantId).toBe("grant-stable");
    expect(popup.close).toHaveBeenCalled();
  });
});
describe("experimental managed ACP grants", () => {
  it("serializes refresh, rotates credentials and preserves grant ownership", async () => {
    const controller = await approved();
    const original = await controller.getGrant();
    vi.useFakeTimers();
    vi.advanceTimersByTime(270000);
    tokenReply = {
      ...tokenReply,
      access_token: "access-2",
      refresh_token: "refresh-2",
    };
    const [first, second] = await Promise.all([
      controller.getGrant(),
      controller.getGrant(),
    ]);
    expect(first).toEqual(second);
    expect(first.grantId).toBe(original.grantId);
    expect(first.token).toBe("access-2");
    expect(first.refreshExpiresAt).toBe(original.refreshExpiresAt);
    expect(
      requests.filter((r) => r.body.get("grant_type") === "refresh_token"),
    ).toHaveLength(1);
    expect(requests.at(-1)!.body.get("refresh_token")).toBe("refresh-1");
    expect((await pairing().getGrant()).token).toBe("access-2");
  });
  it("shares rotation across controllers in one tab without refresh token reuse", async () => {
    const first = await approved();
    const second = pairing();
    await second.getGrant();
    vi.useFakeTimers();
    vi.advanceTimersByTime(270000);
    tokenReply = {
      ...tokenReply,
      access_token: "access-2",
      refresh_token: "refresh-2",
    };
    const results = await Promise.all([first.getGrant(), second.getGrant()]);
    expect(results[0]).toEqual(results[1]);
    expect(
      requests.filter((r) => r.body.get("grant_type") === "refresh_token"),
    ).toHaveLength(1);
  });
  it.each(["revoked", "lost", "malformed", "ownership"])(
    "clears a %s refresh and never retries or opens consent",
    async (kind) => {
      const controller = await approved();
      vi.useFakeTimers();
      vi.advanceTimersByTime(270000);
      if (kind === "revoked") {
        tokenStatus = 400;
        tokenReply = { error: "invalid_grant" };
      }
      if (kind === "lost")
        fetchMock.mockRejectedValueOnce(
          new TypeError("Network lost after token rotation"),
        );
      if (kind === "malformed")
        tokenReply = { ...tokenReply, access_token: "invalid token" };
      if (kind === "ownership")
        tokenReply = {
          ...tokenReply,
          grant_id: "different",
          refresh_token: "refresh-2",
        };
      await expect(controller.getGrant()).rejects.toMatchObject({
        code: kind === "lost" ? "refresh_uncertain" : "invalid_grant",
      });
      await expect(controller.getGrant()).rejects.toMatchObject({
        code: "pairing_required",
      });
      expect(windowMock.open).not.toHaveBeenCalled();
      expect(requests.filter((r) => r.url.endsWith("/par"))).toHaveLength(1);
    },
  );
  it("clears expired absolute grant without calling refresh", async () => {
    const controller = await approved();
    vi.useFakeTimers();
    vi.advanceTimersByTime(86401000);
    await expect(controller.getGrant()).rejects.toMatchObject({
      code: "expired",
    });
    expect(requests).toHaveLength(2);
    await expect(controller.getGrant()).rejects.toMatchObject({
      code: "pairing_required",
    });
  });
  it("prevents a cleared in-flight refresh from restoring credentials", async () => {
    const controller = await approved();
    let reply!: (response: Response) => void;
    fetchMock.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          reply = resolve;
        }),
    );
    const pending = controller.refresh();
    const failure = expect(pending).rejects.toMatchObject({
      code: "invalid_grant",
    });
    await controller.clear();
    reply(
      Response.json({
        ...tokenReply,
        access_token: "access-2",
        refresh_token: "refresh-2",
      }),
    );
    await failure;
    await expect(pairing().getGrant()).rejects.toMatchObject({
      code: "pairing_required",
    });
  });
  it("revokes using app refresh bearer then removes stored credentials", async () => {
    const controller = await approved();
    await controller.revoke();
    expect(requests.at(-1)!.url).toBe(`${gateway}/agent-connect/oauth/revoke`);
    expect(requests.at(-1)!.body.get("token")).toBe("refresh-1");
    await expect(pairing().getGrant()).rejects.toMatchObject({
      code: "pairing_required",
    });
  });
  it("completes callback once in connectAgent then uses managed credentials on transport", async () => {
    await begin();
    const peer = new Peer();
    const provider = await connectAgent({
      gatewayUrl: gateway,
      tools,
      pairing: { callbackUrl: callback() },
      transport: { webSocket: peer.factory },
    });
    expect(peer.calls.filter((r) => r.method === "initialize")).toHaveLength(1);
    expect(requests).toHaveLength(2);
    provider.close();
    const reused = await connectAgent({
      gatewayUrl: gateway,
      tools,
      transport: { webSocket: new Peer().factory },
    });
    reused.close();
    expect(requests).toHaveLength(2);
  });
  it("freezes the tool snapshot before asynchronous browser consent completes", async () => {
    await begin();
    const supplied = structuredClone(tools);
    const peer = new Peer();
    const connection = connectAgent({
      gatewayUrl: gateway,
      tools: supplied,
      pairing: { callbackUrl: callback() },
      transport: { webSocket: peer.factory },
    });
    supplied.push({
      name: "new-unapproved",
      description: "Added during consent",
      inputSchema: { type: "object" },
    });
    const provider = await connection;
    await expect(
      provider
        .streamTask({ prompt: "wrong snapshot", tools: supplied })
        [Symbol.asyncIterator]()
        .next(),
    ).rejects.toMatchObject({ code: "webmcp_snapshot_invalidated" });
    const events = [];
    for await (const event of provider.streamTask({
      prompt: "approved snapshot",
      tools,
    }))
      events.push(event);
    expect(events.at(-1)).toMatchObject({ type: "task.completed" });
    provider.close();
  });
  it("clears revoked managed grant and interrupts prompt without consent or uncertain replay", async () => {
    await approved();
    const peer = new Peer();
    peer.onPrompt = (socket) => socket.disconnect(4414);
    const provider = await connectAgent({
      gatewayUrl: gateway,
      tools,
      transport: { webSocket: peer.factory },
    });
    const events = [];
    for await (const event of provider.streamTask({
      prompt: "uncertain effect",
      tools,
    }))
      events.push(event);
    expect(events.at(-1)).toMatchObject({
      type: "task.failed",
      code: "invalid_app_grant",
    });
    expect(
      peer.calls.filter((r) => r.method === "session/prompt"),
    ).toHaveLength(1);
    expect(peer.calls.filter((r) => r.method === "session/load")).toHaveLength(
      0,
    );
    provider.close();
    await expect(pairing().getGrant()).rejects.toMatchObject({
      code: "pairing_required",
    });
    expect(windowMock.open).not.toHaveBeenCalled();
  });
});
