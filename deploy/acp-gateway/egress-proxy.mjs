// Egress proxy for per-session containers. Session containers sit on an
// internal Docker network with no route out; this proxy is their only exit.
// Public destinations are allowed. Private, loopback, link-local (cloud
// metadata), CGNAT (tailnets), multicast and reserved addresses are refused
// after DNS resolution, and the connection goes to the exact address that was
// checked, so DNS rebinding cannot slip past the check.
import { createServer, request as httpRequest } from "node:http";
import { connect, BlockList, isIP } from "node:net";
import { lookup } from "node:dns/promises";

const port = Number(process.env.EGRESS_PORT ?? 3128);
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

const log = (verdict, target, why = "") =>
  console.log(
    JSON.stringify({ at: new Date().toISOString(), verdict, target, why }),
  );

const server = createServer(async (req, res) => {
  // Plain HTTP with an absolute URI.
  try {
    const url = new URL(req.url);
    const address = await resolveAllowed(url.hostname.replace(/^\[|\]$/g, ""));
    if (!address) {
      log("deny", url.host, "private or reserved destination");
      res.writeHead(403).end("egress denied\n");
      return;
    }
    log("allow", url.host, address);
    const upstream = httpRequest(
      {
        host: address,
        port: url.port || 80,
        method: req.method,
        path: url.pathname + url.search,
        headers: { ...req.headers, host: url.host },
      },
      (up) => {
        res.writeHead(up.statusCode ?? 502, up.headers);
        up.pipe(res);
      },
    );
    upstream.on("error", () => {
      if (!res.headersSent && !res.destroyed)
        res.writeHead(502).end("upstream error\n");
      else res.destroy();
    });
    req.on("aborted", () => upstream.destroy());
    res.on("close", () => upstream.destroy());
    req.pipe(upstream);
  } catch (error) {
    log("deny", req.url, String(error));
    if (!res.headersSent && !res.destroyed)
      res.writeHead(400).end("bad request\n");
  }
});

server.on("clientError", (_error, socket) => socket.destroy());
server.on("connect", async (req, clientSocket, head) => {
  let upstream;
  clientSocket.on("error", () => upstream?.destroy());
  clientSocket.on("close", () => upstream?.destroy());
  const [rawHost, rawPort] = req.url.startsWith("[")
    ? [req.url.slice(1, req.url.indexOf("]")), req.url.split("]:")[1]]
    : req.url.split(":");
  try {
    const address = await resolveAllowed(rawHost);
    if (!address) {
      log("deny", req.url, "private or reserved destination");
      if (!clientSocket.destroyed)
        clientSocket.end("HTTP/1.1 403 Forbidden\r\n\r\n");
      return;
    }
    log("allow", req.url, address);
    if (clientSocket.destroyed) return;
    upstream = connect(Number(rawPort || 443), address, () => {
      if (clientSocket.destroyed) {
        upstream.destroy();
        return;
      }
      clientSocket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
      upstream.write(head);
      upstream.pipe(clientSocket);
      clientSocket.pipe(upstream);
    });
    upstream.on("error", () => {
      if (!clientSocket.destroyed)
        clientSocket.end("HTTP/1.1 502 Bad Gateway\r\n\r\n");
    });
  } catch (error) {
    log("deny", req.url, String(error));
    if (!clientSocket.destroyed)
      clientSocket.end("HTTP/1.1 502 Bad Gateway\r\n\r\n");
  }
});

server.listen(port, "0.0.0.0", () => console.log(`egress proxy on :${port}`));
