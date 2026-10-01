// Resumable ACP stream for the gateway's `agent-connect.resume.v1`
// subprotocol (see src/resume.rs). It has the same shape as the SDK's
// createWebSocketStream ({ readable, writable } of JSON-RPC messages), so one
// ACP connection survives socket swaps underneath it: pending requests such as
// session/prompt and application tool calls stay pending across a reconnect.
//
// This is an Agent Connect transport extension, not an ACP standard.

const SUBPROTOCOL = "agent-connect.resume.v1";
const ENDED_CODES = new Map([
  [4404, "expired"],
  [4409, "superseded"],
  [4410, "ended"],
  [4413, "overflow"],
  [4400, "bad-frame"],
]);
const PROBE_TIMEOUT_MS = 2500;
const CONNECT_TIMEOUT_MS = 6000;
const HEARTBEAT_MS = 15000;

export class ResumeEnded extends Error {
  constructor(reason, code) {
    super(`resumable session ${reason} (${code})`);
    this.reason = reason;
    this.code = code;
  }
}

export function createResumableStream(
  url,
  { token, onState = () => {}, log = () => {} },
) {
  let socket = null;
  let attached = false;
  let resumeToken = null;
  let ended = null;
  let inLast = 0; // highest gateway sequence received
  let outNext = 1;
  const unacked = []; // client frames the gateway has not acknowledged
  let readableController;
  let retryTimer = null;
  let connectTimer = null;
  let probeTimer = null;
  let ackTimer = null;
  let attempt = 0;
  const stats = { attaches: 0, duplicatesDropped: 0, resent: 0 };

  const send = (envelope) => {
    if (attached && socket?.readyState === WebSocket.OPEN)
      socket.send(JSON.stringify(envelope));
  };

  function finish(reason, code) {
    if (ended) return;
    ended = reason;
    clearTimeout(retryTimer);
    clearTimeout(connectTimer);
    clearTimeout(probeTimer);
    clearInterval(heartbeat);
    onState(`ended:${reason}`);
    if (socket) {
      if (reason === "closed") send({ t: "bye" });
      socket.onclose = null;
      socket.close();
      socket = null;
    }
    try {
      if (code === undefined) readableController.close();
      else readableController.error(new ResumeEnded(reason, code));
    } catch {}
  }

  function connect(reason) {
    if (ended) return;
    clearTimeout(retryTimer);
    clearTimeout(probeTimer);
    if (socket) {
      const old = socket;
      old.onclose = old.onmessage = old.onopen = null;
      old.close();
    }
    attached = false;
    onState(resumeToken ? "reconnecting" : "connecting", reason);
    const ws = new WebSocket(url, [SUBPROTOCOL, `bearer.${token}`]);
    socket = ws;
    clearTimeout(connectTimer);
    connectTimer = setTimeout(() => {
      if (socket === ws && !attached) connect("connect timeout");
    }, CONNECT_TIMEOUT_MS);
    ws.onopen = () =>
      ws.send(
        JSON.stringify(
          resumeToken
            ? { t: "attach", resume: resumeToken, ack: inLast }
            : { t: "attach" },
        ),
      );
    ws.onmessage = (event) => {
      if (socket === ws) receive(JSON.parse(event.data));
    };
    ws.onclose = (event) => {
      if (socket !== ws) return;
      socket = null;
      attached = false;
      const final = ENDED_CODES.get(event.code);
      if (final) {
        log("transport", `closed ${event.code} ${final}`);
        finish(final, event.code);
        return;
      }
      log("transport", `closed ${event.code}; will reconnect`);
      onState("disconnected");
      scheduleRetry();
    };
  }

  function receive(envelope) {
    switch (envelope.t) {
      case "attached": {
        clearTimeout(connectTimer);
        attached = true;
        attempt = 0;
        stats.attaches++;
        const first = resumeToken === null;
        resumeToken = envelope.resume;
        while (unacked.length && unacked[0].s <= envelope.ack) unacked.shift();
        for (const frame of unacked) {
          socket.send(JSON.stringify(frame));
          stats.resent++;
        }
        log(
          "transport",
          first
            ? "attached"
            : `reattached; gateway had ${envelope.ack}, resent ${unacked.length}`,
        );
        onState("attached");
        break;
      }
      case "m":
        if (envelope.s <= inLast) {
          stats.duplicatesDropped++;
          return;
        }
        if (envelope.s !== inLast + 1) {
          log("transport", `gap: got ${envelope.s} after ${inLast}`);
          connect("gap");
          return;
        }
        inLast = envelope.s;
        readableController.enqueue(envelope.m);
        if (!ackTimer)
          ackTimer = setTimeout(() => {
            ackTimer = null;
            send({ t: "a", s: inLast });
          }, 200);
        break;
      case "a":
        while (unacked.length && unacked[0].s <= envelope.s) unacked.shift();
        break;
      case "P":
        clearTimeout(probeTimer);
        log("transport", "probe answered");
        break;
      case "expired":
        break;
    }
  }

  function scheduleRetry() {
    if (ended) return;
    // A hidden page is frozen or about to be; reconnect on foreground instead.
    if (document.visibilityState === "hidden" || navigator.onLine === false)
      return;
    const delay = Math.min(250 * 2 ** attempt, 8000);
    attempt++;
    retryTimer = setTimeout(() => connect("retry"), delay);
  }

  // Called on foreground, network and lifecycle events. A socket that looks
  // open after a background period may be dead (half-open), so probe it.
  function checkLiveness(reason) {
    if (ended) return;
    if (!socket || socket.readyState >= WebSocket.CLOSING) {
      connect(reason);
      return;
    }
    if (!attached) return; // a connect attempt is in flight with its own timeout
    clearTimeout(probeTimer);
    const nonce = Math.random().toString(36).slice(2);
    socket.send(JSON.stringify({ t: "p", n: nonce }));
    probeTimer = setTimeout(
      () => connect(`${reason}: probe timeout`),
      PROBE_TIMEOUT_MS,
    );
  }

  const heartbeat = setInterval(
    () => send({ t: "a", s: inLast }),
    HEARTBEAT_MS,
  );

  const stream = {
    readable: new ReadableStream({
      start(controller) {
        readableController = controller;
        connect("open");
      },
      cancel: () => finish("closed"),
    }),
    writable: new WritableStream({
      write(message) {
        if (ended) throw new ResumeEnded(ended, 0);
        const frame = { t: "m", s: outNext++, m: message };
        unacked.push(frame);
        send(frame);
      },
      close: () => finish("closed"),
      abort: () => finish("closed"),
    }),
  };
  return {
    stream,
    checkLiveness,
    stats: () => ({
      ...stats,
      inLast,
      outNext,
      unacked: unacked.length,
      attached,
      ended,
      resumeToken, // exposed for the spike's takeover test only
    }),
  };
}
