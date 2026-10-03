// Egress proxy for per-session containers. Session containers sit on an
// internal Docker network with no route out; this proxy is their only exit.
// Public destinations are allowed. Private, loopback, link-local (cloud
// metadata), CGNAT (tailnets), multicast and reserved addresses are refused
// after DNS resolution, and the connection goes to the exact address that was
// checked, so DNS rebinding cannot slip past the check.
import { createServer, request as httpRequest } from "node:http";
import { connect, BlockList, isIP } from "node:net";
import { lookup } from "node:dns/promises";
import { pathToFileURL } from "node:url";

const denied = new BlockList();
for (const [net, prefix] of [
  ["0.0.0.0", 8],
  ["10.0.0.0", 8],
  ["100.64.0.0", 10],
  ["127.0.0.0", 8],
  ["169.254.0.0", 16],
  ["172.16.0.0", 12],
  ["192.0.0.0", 24],
  ["192.0.2.0", 24],
  ["192.168.0.0", 16],
  ["192.88.99.0", 24],
  ["198.18.0.0", 15],
  ["198.51.100.0", 24],
  ["203.0.113.0", 24],
  ["224.0.0.0", 4],
  ["240.0.0.0", 4],
])
  denied.addSubnet(net, prefix, "ipv4");
for (const [net, prefix] of [
  ["::", 128],
  ["::1", 128],
  ["fc00::", 7],
  ["fe80::", 10],
  ["ff00::", 8],
  ["64:ff9b::", 96],
  ["2001:db8::", 32],
  ["2001::", 23],
  ["2002::", 16],
  ["3fff::", 20],
]) {
  denied.addSubnet(net, prefix, "ipv6");
}

const publicIpv6 = new BlockList();
publicIpv6.addSubnet("2000::", 3, "ipv6");
function isDenied(address) {
  const family = isIP(address) === 6 ? "ipv6" : "ipv4";
  // URL parsing canonicalizes mapped addresses to hex (e.g. ::ffff:7f00:1).
  // Refuse mapped IPv6 altogether rather than checking that hex as IPv4.
  if (
    family === "ipv6" &&
    (address.toLowerCase().startsWith("::ffff:") ||
      !publicIpv6.check(address, "ipv6"))
  )
    return true;
  return denied.check(address, family);
}

async function resolveAllowed(host) {
  const addresses = isIP(host)
    ? [{ address: host }]
    : await lookup(host, { all: true });
  const verdicts = addresses.map(({ address }) => ({
    address,
    denied: isDenied(address),
  }));
  const allowed = verdicts.find((v) => !v.denied);
  // Refuse if any answer is private: mixed answers are a rebinding signal.
  return verdicts.some((v) => v.denied) ? null : (allowed?.address ?? null);
}

function integer(env, name, fallback, max, min = 1) {
  const raw = String(env[name] ?? fallback);
  if (
    !/^[0-9]+$/.test(raw) ||
    !Number.isSafeInteger(Number(raw)) ||
    Number(raw) < min ||
    Number(raw) > max
  )
    throw new Error(`${name} must be an integer between ${min} and ${max}`);
  return Number(raw);
}

export function proxyLimits(env = process.env) {
  const limits = {
    port: integer(env, "EGRESS_PORT", 3128, 65535),
    perClient: integer(env, "EGRESS_MAX_CONNECTIONS_PER_CLIENT", 64, 1024),
    global: integer(env, "EGRESS_MAX_CONNECTIONS", 512, 4096),
    idleMs: integer(env, "EGRESS_IDLE_TIMEOUT_MS", 60000, 3600000, 100),
    absoluteMs: integer(
      env,
      "EGRESS_ABSOLUTE_TIMEOUT_MS",
      3600000,
      86400000,
      100,
    ),
    requestMs: integer(env, "EGRESS_REQUEST_TIMEOUT_MS", 300000, 3600000, 100),
  };
  if (limits.perClient > limits.global)
    throw new Error("per-client connections must not exceed the global limit");
  if (limits.idleMs > limits.absoluteMs || limits.requestMs > limits.absoluteMs)
    throw new Error(
      "idle/request timeouts must not exceed the absolute timeout",
    );
  return limits;
}

function boundedLogger(write) {
  let window = Date.now(),
    emitted = 0,
    suppressed = 0;
  return (verdict, reason) => {
    if (Date.now() - window >= 1000) {
      window = Date.now();
      emitted = 0;
    }
    if (emitted++ >= 20) {
      suppressed++;
      return;
    }
    // Destinations, paths, headers, errors and client addresses can contain
    // credentials or private information. Record only bounded reason codes.
    write(
      JSON.stringify({
        at: new Date().toISOString(),
        verdict,
        reason,
        suppressed,
      }),
    );
    suppressed = 0;
  };
}

export function connectTarget(target) {
  // HTTPS preserves an explicit :80 instead of URL canonicalization erasing
  // it as the default HTTP port. CONNECT's omitted port defaults to 443.
  const authority = new URL(`https://${target}`);
  if (
    authority.username ||
    authority.password ||
    authority.pathname !== "/" ||
    authority.search ||
    authority.hash
  )
    throw new Error("invalid CONNECT authority");
  return {
    host: authority.hostname.replace(/^\[|\]$/g, ""),
    port: Number(authority.port || 443),
  };
}

export function createEgressProxy({
  limits = proxyLimits(),
  resolveAddress = resolveAllowed,
  writeLog = console.log,
} = {}) {
  const log = boundedLogger(writeLog);
  const clients = new Map();
  const states = new WeakMap();
  let active = 0;
  const server = createServer(async (req, res) => {
    const state = states.get(req.socket);
    if (!state || state.busy) {
      res
        .writeHead(429, { Connection: "close" })
        .end("egress connection busy\n");
      return;
    }
    state.busy = true;
    let upstream;
    const finish = () => {
      clearTimeout(timer);
      state.busy = false;
      upstream?.destroy();
    };
    const timer = setTimeout(() => {
      log("deny", "request_timeout");
      upstream?.destroy();
      req.socket.destroy();
    }, limits.requestMs);
    timer.unref();
    res.once("close", finish);
    res.once("finish", finish);
    req.once("aborted", () => upstream?.destroy());
    try {
      const url = new URL(req.url);
      if (url.protocol !== "http:" || url.username || url.password) {
        log("deny", "invalid_http_target");
        res.writeHead(400).end("bad request\n");
        return;
      }
      const address = await resolveAddress(
        url.hostname.replace(/^\[|\]$/g, ""),
      );
      if (req.socket.destroyed || res.destroyed) return;
      if (!address) {
        log("deny", "private_destination");
        res.writeHead(403).end("egress denied\n");
        return;
      }
      log("allow", "http");
      upstream = httpRequest(
        {
          host: address,
          port: url.port || 80,
          method: req.method,
          path: url.pathname + url.search,
          headers: { ...req.headers, host: url.host },
          agent: false,
        },
        (up) => {
          res.writeHead(up.statusCode ?? 502, up.headers);
          up.pipe(res);
        },
      );
      upstream.setTimeout(limits.idleMs, () => {
        log("deny", "upstream_idle_timeout");
        upstream.destroy();
        req.socket.destroy();
      });
      upstream.on("error", () => {
        log("deny", "upstream_error");
        if (!res.headersSent && !res.destroyed)
          res.writeHead(502).end("upstream error\n");
        else res.destroy();
      });
      req.pipe(upstream);
    } catch {
      log("deny", "invalid_request");
      if (!res.headersSent && !res.destroyed)
        res.writeHead(400).end("bad request\n");
    }
  });
  // Count inbound sockets (including partial headers/DNS waits) by box source.
  // One upstream request per client socket also bounds HTTP pipelining.
  server.on("connection", (socket) => {
    socket.on("error", () => {});
    const source = socket.remoteAddress;
    const count = clients.get(source) ?? 0;
    if (count >= limits.perClient || active >= limits.global) {
      log("deny", "connection_limit");
      socket.destroy();
      return;
    }
    active++;
    clients.set(source, count + 1);
    const state = { busy: false };
    states.set(socket, state);
    const absolute = setTimeout(() => {
      log("deny", "absolute_timeout");
      socket.destroy();
    }, limits.absoluteMs);
    absolute.unref();
    socket.setTimeout(limits.idleMs, () => {
      log("deny", "client_idle_timeout");
      socket.destroy();
    });
    socket.once("close", () => {
      clearTimeout(absolute);
      active--;
      const remaining = clients.get(source) - 1;
      if (remaining) clients.set(source, remaining);
      else clients.delete(source);
    });
  });
  server.on("clientError", (_error, socket) => socket.destroy());
  server.on("connect", async (req, clientSocket, head) => {
    const state = states.get(clientSocket);
    if (!state || state.busy) {
      clientSocket.destroy();
      return;
    }
    state.busy = true;
    let upstream;
    clientSocket.on("error", () => upstream?.destroy());
    clientSocket.on("close", () => upstream?.destroy());
    try {
      const target = connectTarget(req.url);
      const address = await resolveAddress(target.host);
      if (clientSocket.destroyed) return;
      if (!address) {
        log("deny", "private_destination");
        clientSocket.end("HTTP/1.1 403 Forbidden\r\n\r\n");
        return;
      }
      log("allow", "connect");
      upstream = connect(target.port, address, () => {
        if (clientSocket.destroyed) {
          upstream.destroy();
          return;
        }
        clientSocket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
        upstream.write(head);
        upstream.pipe(clientSocket);
        clientSocket.pipe(upstream);
      });
      upstream.setTimeout(limits.idleMs, () => {
        log("deny", "upstream_idle_timeout");
        upstream.destroy();
        clientSocket.destroy();
      });
      upstream.on("close", () => clientSocket.destroy());
      upstream.on("error", () => {
        log("deny", "upstream_error");
        if (!clientSocket.destroyed)
          clientSocket.end("HTTP/1.1 502 Bad Gateway\r\n\r\n");
      });
    } catch {
      log("deny", "invalid_connect");
      if (!clientSocket.destroyed)
        clientSocket.end("HTTP/1.1 400 Bad Request\r\n\r\n");
    }
  });
  server.headersTimeout = Math.min(limits.idleMs, limits.requestMs);
  server.requestTimeout = limits.requestMs;
  server.keepAliveTimeout = limits.idleMs;
  server.maxRequestsPerSocket = 32;
  return server;
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  const limits = proxyLimits();
  createEgressProxy({ limits }).listen(limits.port, "0.0.0.0", () =>
    console.log("egress proxy ready"),
  );
}
