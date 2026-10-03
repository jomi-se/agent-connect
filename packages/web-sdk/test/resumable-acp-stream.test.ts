import { afterEach, expect, it, vi } from "vitest";
import {
  createResumableAcpStream,
  type ResumableAcpStream,
} from "../src/resumable-acp-stream.js";
import { Socket } from "./acp-fixture.js";
const handles: ResumableAcpStream[] = [];
afterEach(() => {
  for (const handle of handles.splice(0)) handle.close();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});
function setup(options = {}) {
  const sockets: Socket[] = [];
  const handle = createResumableAcpStream("ws://localhost/acp", {
    token: "grant",
    ...options,
    webSocket: () => {
      const socket = new Socket();
      sockets.push(socket);
      return socket.asWebSocket();
    },
  });
  handles.push(handle);
  const socket = sockets[0]!;
  socket.open();
  return { handle, socket, sockets };
}
it("replays unacknowledged frames, drops duplicates and probes a half-open connection", async () => {
  vi.useFakeTimers();
  const { handle, socket, sockets } = setup();
  const writer = handle.stream.writable.getWriter();
  const reader = handle.stream.readable.getReader();
  await writer.write({
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: {},
  });
  socket.frame({ t: "attached", resume: "opaque", ack: 0 });
  socket.frame({ t: "m", s: 1, m: { jsonrpc: "2.0", id: 1, result: {} } });
  expect((await reader.read()).value).toMatchObject({ id: 1 });
  socket.frame({ t: "m", s: 1, m: { jsonrpc: "2.0", id: 1, result: {} } });
  expect(handle.stats().duplicatesDropped).toBe(1);
  handle.checkLiveness();
  await vi.advanceTimersByTimeAsync(2500);
  expect(sockets).toHaveLength(2);
  const next = sockets[1]!;
  next.open();
  expect(next.sent[0]).toEqual({ t: "attach", resume: "opaque", ack: 1 });
  next.frame({ t: "attached", resume: "opaque", ack: 0 });
  expect(next.sent[1]).toEqual({
    t: "m",
    s: 1,
    m: { jsonrpc: "2.0", id: 1, method: "initialize", params: {} },
  });
  next.frame({ t: "a", s: 1 });
  expect(handle.stats().unacked).toBe(0);
  handle.close();
  expect(vi.getTimerCount()).toBe(0);
});
it("turns close codes into typed errors and refuses invalid acknowledgements", async () => {
  for (const [code, category] of [
    [4401, "invalid_app_grant"],
    [4403, "authorization_denied"],
    [4404, "session_expired"],
    [4409, "session_superseded"],
    [4418, "session_capacity"],
  ] as const) {
    const { handle, socket } = setup();
    const read = handle.stream.readable.getReader().read();
    socket.disconnect(code);
    await expect(read).rejects.toMatchObject({
      code: category,
      closeCode: code,
    });
  }
  const { handle, socket } = setup();
  const read = handle.stream.readable.getReader().read();
  socket.frame({ t: "attached", resume: "opaque", ack: 1 });
  await expect(read).rejects.toMatchObject({ code: "protocol_error" });
});
it("bounds unacknowledged data and removes page lifecycle listeners on close", async () => {
  vi.useFakeTimers();
  const doc = Object.assign(new EventTarget(), { visibilityState: "visible" });
  const win = new EventTarget();
  vi.stubGlobal("document", doc);
  vi.stubGlobal("window", win);
  const remove = vi.spyOn(doc, "removeEventListener");
  const { handle, socket } = setup({ maxUnacknowledgedBytes: 10 });
  const reader = handle.stream.readable.getReader();
  const failure = reader.read();
  await expect(
    handle.stream.writable
      .getWriter()
      .write({ jsonrpc: "2.0", id: 1, method: "initialize" }),
  ).rejects.toMatchObject({ closeCode: 4413 });
  await expect(failure).rejects.toMatchObject({ closeCode: 4413 });
  expect(remove).toHaveBeenCalledTimes(2);
  expect(socket.readyState).toBe(3);
  expect(vi.getTimerCount()).toBe(0);
});
it("sends explicit bye only on disposal and never on page hiding", () => {
  const doc = Object.assign(new EventTarget(), { visibilityState: "visible" });
  vi.stubGlobal("document", doc);
  vi.stubGlobal("window", new EventTarget());
  const { handle, socket } = setup();
  socket.frame({ t: "attached", resume: "opaque", ack: 0 });
  doc.visibilityState = "hidden";
  doc.dispatchEvent(new Event("visibilitychange"));
  expect(socket.sent.some((v) => (v as { t: string }).t === "bye")).toBe(false);
  handle.close();
  expect(socket.sent.at(-1)).toEqual({ t: "bye" });
});
it("detaches before rotating credentials and resumes acknowledged turns without replay", async () => {
  vi.useFakeTimers();
  const sockets: Socket[] = [];
  const protocols: string[][] = [];
  let expiry = Date.now() + 300000;
  let token = "old-grant";
  const tokenGetter = async () => {
    if (sockets.length) {
      expect(sockets[0]!.readyState).toBe(3);
      token = "new-grant";
      expiry = Date.now() + 300000;
    }
    return token;
  };
  const handle = createResumableAcpStream("ws://localhost/acp", {
    token: tokenGetter,
    tokenExpiresAt: () => expiry,
    webSocket: (_url, offered) => {
      protocols.push(offered);
      const socket = new Socket();
      sockets.push(socket);
      return socket.asWebSocket();
    },
  });
  handles.push(handle);
  await vi.waitFor(() => expect(sockets).toHaveLength(1));
  const first = sockets[0]!;
  first.open();
  first.frame({ t: "attached", resume: "stable-resume", ack: 0 });
  const writer = handle.stream.writable.getWriter();
  await writer.write({
    jsonrpc: "2.0",
    id: 1,
    method: "session/prompt",
    params: { prompt: "uncertain effect" },
  });
  first.frame({ t: "a", s: 1 });
  await vi.advanceTimersByTimeAsync(270000);
  expect(sockets).toHaveLength(2);
  const next = sockets[1]!;
  next.open();
  expect(protocols[1]).toEqual(["agent-connect.resume.v1", "bearer.new-grant"]);
  expect(next.sent).toEqual([{ t: "attach", resume: "stable-resume", ack: 0 }]);
  next.frame({ t: "attached", resume: "stable-resume", ack: 1 });
  expect(next.sent).toHaveLength(1);
  expect(handle.stats()).toMatchObject({
    resent: 0,
    outNext: 2,
    unacked: 0,
    attaches: 2,
  });
  handle.close();
  expect(vi.getTimerCount()).toBe(0);
});
it("treats refresh failure as terminal authorization failure without new socket or effect replay", async () => {
  vi.useFakeTimers();
  let expiry = Date.now() + 300000;
  const socket = new Socket();
  let calls = 0;
  const handle = createResumableAcpStream("ws://localhost/acp", {
    token: async () => {
      if (calls++) throw new Error("Refresh revoked");
      return "first";
    },
    tokenExpiresAt: () => expiry,
    webSocket: () => socket.asWebSocket(),
  });
  handles.push(handle);
  await vi.waitFor(() => expect(socket.onopen).toBeTypeOf("function"));
  socket.open();
  socket.frame({ t: "attached", resume: "stable", ack: 0 });
  const read = handle.stream.readable.getReader().read();
  const rejection = expect(read).rejects.toMatchObject({
    code: "invalid_app_grant",
    closeCode: 4401,
  });
  await vi.advanceTimersByTimeAsync(270000);
  await rejection;
  expect(handle.stats().ended).toBe("unauthorized");
  expect(calls).toBe(2);
});
it("ignores credentials resolving after disposal and never creates a socket", async () => {
  let resolve!: (token: string) => void;
  let connections = 0;
  const handle = createResumableAcpStream("ws://localhost/acp", {
    token: () =>
      new Promise((done) => {
        resolve = done;
      }),
    webSocket: () => {
      connections++;
      return new Socket().asWebSocket();
    },
  });
  handles.push(handle);
  handle.close();
  resolve("late-token");
  await Promise.resolve();
  expect(connections).toBe(0);
});
it("renews missed background access expiry while retaining the same resume capability", async () => {
  vi.useFakeTimers();
  const sockets: Socket[] = [];
  let calls = 0;
  let expires = Date.now() + 300000;
  const handle = createResumableAcpStream("ws://localhost/acp", {
    token: async () => {
      calls++;
      expires = Date.now() + 300000;
      return `token-${calls}`;
    },
    tokenExpiresAt: () => expires,
    webSocket: () => {
      const socket = new Socket();
      sockets.push(socket);
      return socket.asWebSocket();
    },
  });
  handles.push(handle);
  await vi.waitFor(() => expect(sockets).toHaveLength(1));
  sockets[0]!.open();
  sockets[0]!.frame({
    t: "attached",
    resume: "same-background-session",
    ack: 0,
  });
  vi.setSystemTime(Date.now() + 301000); // Suspension advances wall time without running timers.
  sockets[0]!.disconnect(4401);
  await vi.waitFor(() => expect(sockets).toHaveLength(2));
  sockets[1]!.open();
  expect(sockets[1]!.sent).toEqual([
    { t: "attach", resume: "same-background-session", ack: 0 },
  ]);
  expect(calls).toBe(2);
  expect(handle.error).toBeUndefined();
});
it("terminates eviction and oversized-frame closes without retrying the session", async () => {
  vi.useFakeTimers();
  for (const [closeCode, code] of [
    [4415, "session_superseded"],
    [1009, "frame_too_large"],
  ] as const) {
    const { handle, socket, sockets } = setup();
    const reading = handle.stream.readable.getReader().read();
    socket.disconnect(closeCode);
    await expect(reading).rejects.toMatchObject({ code, closeCode });
    await vi.advanceTimersByTimeAsync(10000);
    expect(sockets).toHaveLength(1);
  }
});
it("rejects outgoing frames by UTF8 wire bytes before queueing or sending", async () => {
  vi.useFakeTimers();
  const { handle, socket, sockets } = setup();
  socket.frame({ t: "attached", resume: "opaque", ack: 0 });
  const read = handle.stream.readable.getReader().read();
  const failure = expect(read).rejects.toMatchObject({
    code: "frame_too_large",
    closeCode: 1009,
  });
  await expect(
    handle.stream.writable
      .getWriter()
      .write({
        jsonrpc: "2.0",
        id: 1,
        method: "session/prompt",
        params: { prompt: "🙂".repeat(262144) },
      }),
  ).rejects.toMatchObject({ code: "frame_too_large" });
  await failure;
  expect(handle.stats()).toMatchObject({ unacked: 0, outNext: 1 });
  expect(socket.sent.some((frame) => (frame as { t?: string }).t === "m")).toBe(
    false,
  );
  await vi.advanceTimersByTimeAsync(10000);
  expect(sockets).toHaveLength(1);
});
it("allows a ten-second gateway cold start without repeated socket creation", async () => {
  vi.useFakeTimers();
  const { handle, socket, sockets } = setup({ connectTimeoutMs: 6000 });
  await vi.advanceTimersByTimeAsync(10000);
  expect(sockets).toHaveLength(1);
  socket.frame({ t: "attached", resume: "cold-host", ack: 0 });
  expect(handle.stats().attached).toBe(true);
});
