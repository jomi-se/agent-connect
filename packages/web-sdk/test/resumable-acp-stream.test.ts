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
