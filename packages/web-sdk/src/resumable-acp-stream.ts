import type { AnyMessage, Stream } from "@agentclientprotocol/sdk";
import { AgentConnectError } from "./agent-session.js";
import type { AgentConnectErrorCode } from "./types.js";

/** @experimental Unstable ACP/Agent Connect resume transport error. */
export class AcpTransportError extends AgentConnectError {
  constructor(
    readonly closeCode: number,
    readonly reason: string,
    code: AgentConnectErrorCode,
  ) {
    super(code, `ACP transport ${reason} (${closeCode})`);
    this.name = "AcpTransportError";
  }
}
const CLOSE = new Map<number, [string, AgentConnectErrorCode]>([
  [1009, ["frame-too-large", "frame_too_large"]],
  [4400, ["bad-frame", "protocol_error"]],
  [4401, ["unauthorized", "invalid_app_grant"]],
  [4403, ["origin-denied", "authorization_denied"]],
  [4404, ["expired", "session_expired"]],
  [4409, ["superseded", "session_superseded"]],
  [4410, ["ended", "session_expired"]],
  [4413, ["overflow", "session_expired"]],
  [4414, ["grant-revoked", "invalid_app_grant"]],
  [4415, ["evicted", "session_superseded"]],
  [4418, ["capacity", "session_capacity"]],
  [4500, ["launch-failed", "agent_execution_failed"]],
]);
/** @experimental Unstable transport configuration; grants stay in memory. */
export interface ResumableAcpStreamOptions {
  readonly token: string | (() => Promise<string>);
  /** Access expiry used for proactive sequence-preserving credential reattachment. */
  readonly tokenExpiresAt?: () => number;
  readonly resumable?: boolean;
  readonly maxUnacknowledgedBytes?: number;
  readonly onState?: (state: string, reason?: string) => void;
  readonly webSocket?: (url: string, protocols: string[]) => WebSocket;
  readonly probeTimeoutMs?: number;
  readonly connectTimeoutMs?: number;
}
/** @experimental Unstable transport diagnostics, including an opaque reattach token. */
export interface AcpTransportSnapshot {
  readonly attaches: number;
  readonly duplicatesDropped: number;
  readonly resent: number;
  readonly inLast: number;
  readonly outNext: number;
  readonly unacked: number;
  readonly attached: boolean;
  readonly ended: string | null;
  readonly resumeToken: string | null;
}
/** @experimental Unstable ACP transport handle. Close releases timers and listeners. */
export interface ResumableAcpStream {
  readonly stream: Stream;
  readonly error: AcpTransportError | undefined;
  close(): void;
  checkLiveness(reason?: string): void;
  stats(): AcpTransportSnapshot;
}
type Frame = { t: "m"; s: number; m: AnyMessage; bytes: number };
function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function sequence(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}
function rpc(value: unknown): value is AnyMessage {
  return (
    record(value) &&
    value["jsonrpc"] === "2.0" &&
    (typeof value["method"] === "string" ||
      "result" in value ||
      "error" in value)
  );
}

/** @experimental Agent Connect's sequence-acknowledged transport, not an ACP standard. */
export function createResumableAcpStream(
  url: string,
  options: ResumableAcpStreamOptions,
): ResumableAcpStream {
  const resumable = options.resumable !== false;
  const maxBytes = options.maxUnacknowledgedBytes ?? 8 * 1024 * 1024;
  let socket: WebSocket | null = null,
    attached = false,
    resumeToken: string | null = null;
  let ended: string | null = null,
    error: AcpTransportError | undefined;
  let inLast = 0,
    outNext = 1,
    queuedBytes = 0,
    attempt = 0;
  const unacked: Frame[] = [];
  let controller: ReadableStreamDefaultController<AnyMessage>;
  let retryTimer: ReturnType<typeof setTimeout> | undefined;
  let connectTimer: ReturnType<typeof setTimeout> | undefined;
  let probeTimer: ReturnType<typeof setTimeout> | undefined;
  let ackTimer: ReturnType<typeof setTimeout> | undefined;
  let initialTimer: ReturnType<typeof setTimeout> | undefined;
  let credentialTimer: ReturnType<typeof setTimeout> | undefined;
  let connecting = false;
  let generation = 0;
  let probeNonce: string | undefined;
  let resolveOpen!: () => void, rejectOpen!: (error: Error) => void;
  const firstOpen = new Promise<void>((resolve, reject) => {
    resolveOpen = resolve;
    rejectOpen = reject;
  });
  void firstOpen.catch(() => {});
  const counters = { attaches: 0, duplicatesDropped: 0, resent: 0 };
  const listeners: Array<[EventTarget, string, EventListener]> = [];
  const state = (value: string, why?: string) => {
    try {
      options.onState?.(value, why);
    } catch {}
  };
  const send = (envelope: unknown) => {
    if (attached && socket?.readyState === 1)
      socket.send(JSON.stringify(envelope));
  };
  function prune(ack: number) {
    if (ack >= outNext) {
      finish("bad-frame", 4400);
      return;
    }
    while (unacked[0] && unacked[0].s <= ack)
      queuedBytes -= unacked.shift()!.bytes;
  }
  const heartbeat = setInterval(() => {
    if (resumable) send({ t: "a", s: inLast });
  }, 15000);
  function finish(reason: string, code?: number) {
    if (ended) return;
    if (reason === "closed" && resumable) {
      try {
        send({ t: "bye" });
      } catch {}
    }
    ended = reason;
    attached = false;
    clearTimeout(retryTimer);
    clearTimeout(connectTimer);
    clearTimeout(probeTimer);
    clearTimeout(ackTimer);
    clearTimeout(initialTimer);
    clearTimeout(credentialTimer);
    generation++;
    clearInterval(heartbeat);
    for (const [target, type, listener] of listeners)
      target.removeEventListener(type, listener);
    unacked.length = 0;
    queuedBytes = 0;
    if (socket) {
      socket.onclose = socket.onmessage = socket.onopen = null;
      socket.close();
      socket = null;
    }
    if (code !== undefined) {
      error = new AcpTransportError(
        code,
        reason,
        CLOSE.get(code)?.[1] ?? "protocol_error",
      );
      controller.error(error);
    } else {
      try {
        controller.close();
      } catch {}
    }
    rejectOpen(error ?? new AcpTransportError(4410, reason, "session_expired"));
    state(`ended:${reason}`);
  }
  function retry() {
    if (
      ended ||
      (typeof document !== "undefined" &&
        document.visibilityState === "hidden") ||
      (typeof navigator !== "undefined" && navigator.onLine === false)
    )
      return;
    retryTimer = setTimeout(
      () => connect("retry"),
      Math.min(250 * 2 ** attempt++, 8000),
    );
  }
  function connect(why: string) {
    if (ended || connecting) return;
    connecting = true;
    const currentGeneration = ++generation;
    clearTimeout(retryTimer);
    clearTimeout(probeTimer);
    clearTimeout(connectTimer);
    if (socket) {
      socket.onclose = socket.onmessage = socket.onopen = null;
      socket.close();
    }
    socket = null;
    attached = false;
    clearTimeout(credentialTimer);
    state(resumeToken ? "reconnecting" : "connecting", why);
    const launch = (token: string) => {
      if (ended || currentGeneration !== generation) return;
      connecting = false;
      let ws: WebSocket;
      try {
        if (!token || !/^[A-Za-z0-9._~-]+$/.test(token))
          throw new TypeError("Invalid ACP token");
        ws =
          options.webSocket?.(url, [
            resumable ? "agent-connect.resume.v1" : "acp.v1",
            `bearer.${token}`,
          ]) ??
          new WebSocket(url, [
            resumable ? "agent-connect.resume.v1" : "acp.v1",
            `bearer.${token}`,
          ]);
      } catch {
        finish("bad-frame", 4400);
        return;
      }
      socket = ws;
      connectTimer = setTimeout(
        () => connect("connect timeout"),
        Math.max(options.connectTimeoutMs ?? 30000, 30000),
      );
      ws.onopen = () => {
        if (resumable)
          ws.send(
            JSON.stringify(
              resumeToken
                ? { t: "attach", resume: resumeToken, ack: inLast }
                : { t: "attach" },
            ),
          );
        else {
          attached = true;
          resolveOpen();
          counters.attaches++;
          clearTimeout(connectTimer);
          clearTimeout(initialTimer);
          state("attached");
          scheduleCredentials();
        }
      };
      ws.onmessage = (event) => {
        if (socket !== ws || ended) return;
        try {
          const value: unknown = JSON.parse(String(event.data));
          if (!resumable) {
            if (!rpc(value)) throw new Error();
            controller.enqueue(value);
            return;
          }
          if (!record(value)) throw new Error();
          switch (value["t"]) {
            case "attached": {
              if (
                typeof value["resume"] !== "string" ||
                !sequence(value["ack"]) ||
                value["ack"] >= outNext ||
                (resumeToken !== null && resumeToken !== value["resume"])
              )
                throw new Error();
              clearTimeout(connectTimer);
              clearTimeout(initialTimer);
              attached = true;
              attempt = 0;
              counters.attaches++;
              resumeToken = value["resume"];
              prune(value["ack"]);
              for (const { bytes: _bytes, ...frame } of unacked) {
                ws.send(JSON.stringify(frame));
                counters.resent++;
              }
              state("attached");
              scheduleCredentials();
              break;
            }
            case "m": {
              if (
                !sequence(value["s"]) ||
                value["s"] === 0 ||
                !rpc(value["m"]) ||
                !attached
              )
                throw new Error();
              if (value["s"] <= inLast) {
                counters.duplicatesDropped++;
                send({ t: "a", s: inLast });
                return;
              }
              if (value["s"] !== inLast + 1) {
                connect("sequence gap");
                return;
              }
              inLast = value["s"];
              controller.enqueue(value["m"]);
              if (ackTimer === undefined)
                ackTimer = setTimeout(() => {
                  ackTimer = undefined;
                  send({ t: "a", s: inLast });
                }, 200);
              break;
            }
            case "a":
              if (!sequence(value["s"])) throw new Error();
              prune(value["s"]);
              break;
            case "P":
              if (value["n"] === probeNonce) {
                clearTimeout(probeTimer);
                probeNonce = undefined;
                if (sequence(value["ack"])) prune(value["ack"]);
              }
              break;
            case "expired":
              finish("expired", 4404);
              break;
            default:
              throw new Error();
          }
        } catch {
          finish("bad-frame", 4400);
        }
      };
      ws.onclose = (event) => {
        if (socket !== ws || ended) return;
        socket = null;
        attached = false;
        // A suspended page can miss its renewal timer. Expired managed access
        // may renew the same attachment, but never opens consent or replays RPCs.
        if (
          event.code === 4401 &&
          resumable &&
          options.tokenExpiresAt &&
          typeof options.token !== "string" &&
          options.tokenExpiresAt() <= Date.now() + 30000
        ) {
          connect("access expired");
          return;
        }
        const terminal = CLOSE.get(event.code);
        if (terminal) {
          finish(terminal[0], event.code);
          return;
        }
        if (!resumable) {
          finish("disconnected", 4410);
          return;
        }
        state("disconnected");
        retry();
      };
      ws.onerror = () => {}; // Browsers expose failed upgrades through close, without HTTP details.
    };
    if (typeof options.token === "string") launch(options.token);
    else {
      let token: Promise<string>;
      try {
        token = options.token();
      } catch {
        connecting = false;
        finish("unauthorized", 4401);
        return;
      }
      void token.then(launch, () => {
        connecting = false;
        if (!ended && currentGeneration === generation)
          finish("unauthorized", 4401);
      });
    }
  }
  function scheduleCredentials() {
    if (!options.tokenExpiresAt || typeof options.token === "string") return;
    clearTimeout(credentialTimer);
    credentialTimer = setTimeout(
      () => renewCredentials(),
      Math.max(1000, options.tokenExpiresAt() - Date.now() - 30000),
    );
  }
  function renewCredentials() {
    if (resumable) connect("credential refresh");
    else finish("ended", 4410); // Raw ACP requires a new initialize/load cycle.
  }
  function checkLiveness(why = "foreground") {
    if (ended) return;
    if (
      options.tokenExpiresAt &&
      options.tokenExpiresAt() <= Date.now() + 30000
    ) {
      renewCredentials();
      return;
    }
    if (!socket || socket.readyState >= 2) {
      connect(why);
      return;
    }
    if (!attached || !resumable) return;
    clearTimeout(probeTimer);
    probeNonce = globalThis.crypto.randomUUID();
    socket.send(JSON.stringify({ t: "p", n: probeNonce }));
    probeTimer = setTimeout(
      () => connect(`${why}: probe timeout`),
      options.probeTimeoutMs ?? 2500,
    );
  }
  const stream: Stream = {
    readable: new ReadableStream<AnyMessage>({
      start(c) {
        controller = c;
        initialTimer = setTimeout(
          () => finish("connection timeout", 4500),
          30000,
        );
        connect("open");
      },
      cancel() {
        finish("closed");
      },
    }),
    writable: new WritableStream<AnyMessage>({
      async write(message) {
        if (ended)
          throw error ?? new AcpTransportError(4410, ended, "session_expired");
        const wire = resumable ? { t: "m", s: outNext, m: message } : message;
        const bytes = new TextEncoder().encode(JSON.stringify(wire)).length;
        if (bytes > 1024 * 1024) {
          finish("frame-too-large", 1009);
          throw error;
        }
        if (!resumable) {
          await firstOpen;
          if (ended) throw error;
          socket!.send(JSON.stringify(message));
          return;
        }
        if (queuedBytes + bytes > maxBytes) {
          finish("overflow", 4413);
          throw error;
        }
        const frame: Frame = { t: "m", s: outNext++, m: message, bytes };
        unacked.push(frame);
        queuedBytes += bytes;
        send({ t: frame.t, s: frame.s, m: frame.m });
      },
      close() {
        finish("closed");
      },
      abort() {
        finish("closed");
      },
    }),
  };
  if (typeof document !== "undefined" && typeof window !== "undefined") {
    for (const [target, type] of [
      [document, "visibilitychange"],
      [document, "resume"],
      [window, "pageshow"],
      [window, "online"],
      [window, "focus"],
    ] as const) {
      const listener = () => {
        if (document.visibilityState !== "hidden") checkLiveness(type);
      };
      target.addEventListener(type, listener);
      listeners.push([target, type, listener]);
    }
  }
  return {
    stream,
    get error() {
      return error;
    },
    close: () => finish("closed"),
    checkLiveness,
    stats: () => ({
      ...counters,
      inLast,
      outNext,
      unacked: unacked.length,
      attached,
      ended,
      resumeToken,
    }),
  };
}
