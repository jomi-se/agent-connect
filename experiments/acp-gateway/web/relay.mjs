// Fault-injecting TCP relay between the browser and the gateway, used to model
// what a phone does to a WebSocket. Control endpoint (POST):
//   /cut        reset every open connection (the OS killed the socket)
//   /blackhole  stop forwarding on the open sockets but keep them open
//               (half-open sockets); new connections still pass
//   /refuse     refuse new connections until /heal (still offline)
//   /heal       forward normally again
//   /stats      JSON counters
// Usage: RELAY_LISTEN=18946 RELAY_TARGET=18943 RELAY_CONTROL=18947 node relay.mjs
import { createServer, connect } from "node:net";
import { createServer as createHttpServer } from "node:http";

const listenPort = Number(process.env.RELAY_LISTEN ?? 18946);
const targetPort = Number(process.env.RELAY_TARGET ?? 18943);
const controlPort = Number(process.env.RELAY_CONTROL ?? 18947);
const host = "127.0.0.1";

let mode = "pass"; // pass | refuse
const pairs = new Set();
const stats = { accepted: 0, refused: 0, cuts: 0 };

createServer((client) => {
  if (mode === "refuse") {
    stats.refused++;
    client.resetAndDestroy();
    return;
  }
  stats.accepted++;
  const upstream = connect(targetPort, host);
  const pair = { client, upstream, dead: false };
  pairs.add(pair);
  const forward = (from, to) =>
    from.on("data", (chunk) => {
      if (!pair.dead) to.write(chunk);
    });
  forward(client, upstream);
  forward(upstream, client);
  const end = () => {
    pairs.delete(pair);
    client.destroy();
    upstream.destroy();
  };
  client.on("error", end).on("close", end);
  upstream.on("error", end).on("close", end);
}).listen(listenPort, host);

createHttpServer((req, res) => {
  const action = req.url.slice(1);
  if (action === "cut") {
    stats.cuts += pairs.size;
    for (const { client, upstream } of pairs) {
      client.resetAndDestroy();
      upstream.resetAndDestroy();
    }
    pairs.clear();
  } else if (action === "blackhole") {
    for (const pair of pairs) pair.dead = true;
  } else if (action === "refuse") mode = "refuse";
  else if (action === "heal") mode = "pass";
  else if (action !== "stats") {
    res.writeHead(404).end();
    return;
  }
  res.writeHead(200, { "content-type": "application/json" });
  res.end(JSON.stringify({ mode, open: pairs.size, ...stats }));
}).listen(controlPort, host, () =>
  console.log(
    `relay ${listenPort} -> ${targetPort}, control http://${host}:${controlPort}`,
  ),
);
