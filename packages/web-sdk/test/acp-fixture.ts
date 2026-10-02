// Controlled Agent Connect contract fixture, not provider compatibility evidence.
import type { AnyMessage } from "@agentclientprotocol/sdk";
export class Socket {
  readyState = 0;
  onopen: (() => void) | null = null;
  onclose: ((event: { code: number }) => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  onerror: (() => void) | null = null;
  readonly sent: unknown[] = [];
  constructor(readonly receive?: (value: Record<string, unknown>) => void) {}
  send(value: string) {
    const parsed = JSON.parse(value) as Record<string, unknown>;
    this.sent.push(parsed);
    this.receive?.(parsed);
  }
  open() {
    this.readyState = 1;
    this.onopen?.();
  }
  frame(value: unknown) {
    this.onmessage?.({ data: JSON.stringify(value) });
  }
  disconnect(code = 1006) {
    this.readyState = 3;
    this.onclose?.({ code });
  }
  close() {
    this.readyState = 3;
  }
  asWebSocket() {
    return this as unknown as WebSocket;
  }
}
export class Peer {
  readonly sockets: Socket[] = [];
  readonly calls: Array<{ method: string; params: Record<string, unknown> }> =
    [];
  onPrompt?: (
    socket: Socket,
    params: Record<string, unknown>,
    reply: (result: unknown) => void,
  ) => void;
  onCancel?: () => void;
  onNewSession?: (
    socket: Socket,
    params: Record<string, unknown>,
    reply: (result: unknown) => void,
    fail: (code: number, message: string) => void,
  ) => void;
  private states = new Map<
    Socket,
    {
      sequence: number;
      id: number;
      pending: Map<number, (result: unknown) => void>;
    }
  >();
  factory = (_url: string, _protocols: string[]) => {
    let socket: Socket;
    socket = new Socket((value) => {
      if (value["t"] === "attach") {
        queueMicrotask(() =>
          socket.frame({
            t: "attached",
            resume: `fixture-${this.sockets.length}`,
            ack: 0,
          }),
        );
        return;
      }
      if (value["t"] === "p") {
        socket.frame({ t: "P", n: value["n"] });
        return;
      }
      if (value["t"] !== "m") return;
      const message = value["m"] as Record<string, unknown>;
      queueMicrotask(() => socket.frame({ t: "a", s: value["s"] }));
      if (typeof message["method"] !== "string") {
        const state = this.states.get(socket)!;
        const resolve = state.pending.get(message["id"] as number);
        state.pending.delete(message["id"] as number);
        resolve?.(message["result"] ?? message["error"]);
        return;
      }
      const method = message["method"];
      const params = (message["params"] ?? {}) as Record<string, unknown>;
      this.calls.push({ method, params });
      const reply = (result: unknown) =>
        this.send(socket, {
          jsonrpc: "2.0",
          id: message["id"],
          result,
        } as AnyMessage);
      switch (method) {
        case "initialize":
          reply({
            protocolVersion: 1,
            agentCapabilities: {
              loadSession: true,
              mcpCapabilities: { acp: true },
            },
            authMethods: [],
          });
          break;
        case "session/new":
          if (this.onNewSession)
            this.onNewSession(socket, params, reply, (code, errorMessage) =>
              this.send(socket, {
                jsonrpc: "2.0",
                id: message["id"],
                error: { code, message: errorMessage },
              } as AnyMessage),
            );
          else reply({ sessionId: "owned-session" });
          break;
        case "session/load":
          this.update(socket, {
            sessionUpdate: "agent_message_chunk",
            content: { type: "text", text: "history" },
          });
          reply({});
          break;
        case "session/prompt":
          if (this.onPrompt) this.onPrompt(socket, params, reply);
          else reply({ stopReason: "end_turn" });
          break;
        case "session/cancel":
          this.onCancel?.();
          break;
      }
    });
    this.states.set(socket, { sequence: 0, id: 1000, pending: new Map() });
    this.sockets.push(socket);
    queueMicrotask(() => socket.open());
    return socket.asWebSocket();
  };
  send(socket: Socket, message: AnyMessage) {
    const state = this.states.get(socket)!;
    queueMicrotask(() =>
      socket.frame({ t: "m", s: ++state.sequence, m: message }),
    );
  }
  update(socket: Socket, update: unknown) {
    this.send(socket, {
      jsonrpc: "2.0",
      method: "session/update",
      params: { sessionId: "owned-session", update },
    } as AnyMessage);
  }
  request(socket: Socket, method: string, params: unknown): Promise<unknown> {
    const state = this.states.get(socket)!;
    const id = ++state.id;
    return new Promise((resolve) => {
      state.pending.set(id, resolve);
      this.send(socket, { jsonrpc: "2.0", id, method, params } as AnyMessage);
    });
  }
}
