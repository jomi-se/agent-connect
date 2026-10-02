// Test-only socket interruption: the sample itself has no fault injection API.
import { createServer, connect } from "node:net";
import { createServer as httpServer } from "node:http";
const pairs = new Set();
let accepted = 0;
let cuts = 0;
createServer((client) => {
  accepted++;
  const upstream = connect(Number(process.env.RELAY_TARGET), "127.0.0.1");
  const pair = { client, upstream };
  pairs.add(pair);
  client.pipe(upstream).pipe(client);
  const end = () => {
    pairs.delete(pair);
    client.destroy();
    upstream.destroy();
  };
  client.on("error", end).on("close", end);
  upstream.on("error", end).on("close", end);
}).listen(Number(process.env.RELAY_LISTEN), "127.0.0.1");
httpServer((request, response) => {
  if (request.url === "/cut" && request.method === "POST") {
    cuts += pairs.size;
    for (const { client, upstream } of pairs) {
      client.resetAndDestroy();
      upstream.resetAndDestroy();
    }
    pairs.clear();
  } else if (request.url !== "/stats") {
    response.writeHead(404).end();
    return;
  }
  response.setHeader("content-type", "application/json");
  response.end(JSON.stringify({ accepted, cuts, open: pairs.size }));
}).listen(Number(process.env.RELAY_CONTROL), "127.0.0.1");
