import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer, connect } from "node:net";
import { request } from "node:http";
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
test("egress rejects reserved destinations and survives reset CONNECT clients", async () => {
  const listener = createServer();
  await new Promise((resolve) => listener.listen(0, "127.0.0.1", resolve));
  const port = listener.address().port;
  await new Promise((resolve) => listener.close(resolve));
  const child = spawn(
    process.execPath,
    [new URL("../egress-proxy.mjs", import.meta.url).pathname],
    {
      env: { PATH: process.env.PATH, EGRESS_PORT: String(port) },
      stdio: ["ignore", "ignore", "pipe"],
    },
  );
  let errors = "";
  child.stderr.on("data", (chunk) => {
    errors += chunk;
  });
  const http = (destination) =>
    new Promise((resolve, reject) => {
      const req = request(
        {
          host: "127.0.0.1",
          port,
          path: `http://${destination}/`,
          method: "GET",
        },
        (res) => {
          res.resume();
          resolve(res.statusCode);
        },
      );
      req.on("error", reject);
      req.end();
    });
  try {
    for (let i = 0; i < 50; i++) {
      try {
        await http("127.0.0.1");
        break;
      } catch {
        await delay(20);
      }
    }
    for (const destination of [
      "127.0.0.1",
      "169.254.169.254",
      "100.64.0.1",
      "10.0.0.1",
      "192.0.2.1",
      "192.88.99.1",
      "[2001:db8::1]",
      "[2002:7f00:1::1]",
      "[::1]",
      "[fc00::1]",
      "[::ffff:127.0.0.1]",
    ]) {
      assert.ok([400, 403].includes(await http(destination)), destination);
    }
    for (let i = 0; i < 20; i++)
      await new Promise((resolve) => {
        const socket = connect(port, "127.0.0.1", () => {
          socket.write(
            "CONNECT 127.0.0.1:443 HTTP/1.1\r\nHost: 127.0.0.1\r\n\r\n",
          );
          socket.resetAndDestroy();
        });
        socket.on("error", () => {});
        socket.on("close", resolve);
      });
    await delay(100);
    assert.equal(child.exitCode, null, errors);
    assert.equal(await http("169.254.169.254"), 403);
  } finally {
    child.kill();
    await new Promise((resolve) => child.once("exit", resolve));
  }
});

// These unit fixtures use local sockets and an injected DNS verdict. The
// subprocess test above separately preserves the production address boundary.
const { createEgressProxy, proxyLimits, connectTarget } =
  await import("../egress-proxy.mjs");

async function localProxy(t, overrides = {}) {
  const logs = [];
  const limits = proxyLimits({
    EGRESS_MAX_CONNECTIONS_PER_CLIENT: "2",
    EGRESS_MAX_CONNECTIONS: "3",
    EGRESS_IDLE_TIMEOUT_MS: "2000",
    EGRESS_ABSOLUTE_TIMEOUT_MS: "3000",
    EGRESS_REQUEST_TIMEOUT_MS: "1000",
    ...overrides,
  });
  const server = createEgressProxy({
    limits,
    resolveAddress: async () => "127.0.0.1",
    writeLog: (line) => logs.push(line),
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const sockets = new Set();
  t.after(async () => {
    for (const socket of sockets) socket.destroy();
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  });
  async function client(localAddress = "127.0.0.1") {
    const socket = connect({
      host: "127.0.0.1",
      port: server.address().port,
      localAddress,
    });
    sockets.add(socket);
    socket.on("error", () => {});
    const closed = new Promise((resolve) => socket.once("close", resolve));
    await new Promise((resolve) => socket.once("connect", resolve));
    return { socket, closed };
  }
  return { server, logs, client, port: server.address().port };
}
async function closes(promise, label, ms = 1200) {
  let timer;
  try {
    await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(label)), ms);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
async function localTarget(t, handler) {
  const sockets = new Set();
  const target = createServer((socket) => {
    sockets.add(socket);
    socket.on("error", () => {});
    handler(socket);
  });
  await new Promise((resolve) => target.listen(0, "127.0.0.1", resolve));
  t.after(async () => {
    for (const socket of sockets) socket.destroy();
    await new Promise((resolve) => target.close(resolve));
  });
  return target.address().port;
}

test("CONNECT preserves explicit ports and rejects URL credentials/paths", () => {
  assert.deepEqual(connectTarget("example.test:80"), {
    host: "example.test",
    port: 80,
  });
  assert.deepEqual(connectTarget("example.test"), {
    host: "example.test",
    port: 443,
  });
  assert.deepEqual(connectTarget("[2001:db8::1]:443"), {
    host: "2001:db8::1",
    port: 443,
  });
  for (const target of [
    "user:secret@example.test:443",
    "example.test:443/path",
    "example.test:443?token=secret",
    "example.test:99999",
  ])
    assert.throws(() => connectTarget(target));
});

test("egress validates connection and timeout bounds", () => {
  for (const settings of [
    { EGRESS_MAX_CONNECTIONS: "0" },
    { EGRESS_MAX_CONNECTIONS_PER_CLIENT: "999999" },
    { EGRESS_IDLE_TIMEOUT_MS: "NaN" },
    { EGRESS_ABSOLUTE_TIMEOUT_MS: "99" },
    { EGRESS_REQUEST_TIMEOUT_MS: "1.5" },
    { EGRESS_PORT: "0" },
    { EGRESS_MAX_CONNECTIONS: "2", EGRESS_MAX_CONNECTIONS_PER_CLIENT: "3" },
    {
      EGRESS_IDLE_TIMEOUT_MS: "1000",
      EGRESS_ABSOLUTE_TIMEOUT_MS: "500",
      EGRESS_REQUEST_TIMEOUT_MS: "100",
    },
  ])
    assert.throws(() => proxyLimits(settings));
});

test("egress caps partial clients by source and globally and recovers freed capacity", async (t) => {
  const { client, logs } = await localProxy(t);
  const first = await client();
  const second = await client();
  const sourceOverflow = await client();
  await closes(sourceOverflow.closed, "per-source overflow was not refused");
  const other = await client("127.0.0.2");
  const globalOverflow = await client("127.0.0.2");
  await closes(globalOverflow.closed, "global overflow was not refused");
  assert.ok(
    !first.socket.destroyed &&
      !second.socket.destroyed &&
      !other.socket.destroyed,
  );
  first.socket.destroy();
  await first.closed;
  await delay(20);
  const replacement = await client();
  replacement.socket.write("GET http://example.test/ HTTP/1.1\r\n");
  await delay(30);
  assert.equal(
    replacement.socket.destroyed,
    false,
    "released capacity accepts another source connection",
  );
  assert.ok(
    logs.some((line) => JSON.parse(line).reason === "connection_limit"),
  );
});

test("egress idle timeout closes partial headers", async (t) => {
  const { client } = await localProxy(t, { EGRESS_IDLE_TIMEOUT_MS: "100" });
  const { socket, closed } = await client();
  socket.write("GET http://example.test/ HTTP/1.1\r\n");
  await closes(closed, "partial headers escaped idle timeout");
});

test("CONNECT tunnels obey idle timeout and close their upstream", async (t) => {
  let upstreamClosed;
  const closed = new Promise((resolve) => {
    upstreamClosed = resolve;
  });
  const port = await localTarget(t, (socket) =>
    socket.once("close", upstreamClosed),
  );
  const proxy = await localProxy(t, { EGRESS_IDLE_TIMEOUT_MS: "100" });
  const client = await proxy.client();
  client.socket.resume();
  client.socket.write(
    `CONNECT fixture.example:${port} HTTP/1.1\r\nHost: fixture.example\r\n\r\n`,
  );
  await closes(client.closed, "idle CONNECT client stayed open");
  await closes(closed, "idle CONNECT upstream stayed open");
});

test("CONNECT absolute timeout closes even an active tunnel", async (t) => {
  let upstreamClosed;
  const closed = new Promise((resolve) => {
    upstreamClosed = resolve;
  });
  const port = await localTarget(t, (socket) => {
    socket.on("data", (data) => socket.write(data));
    socket.once("close", upstreamClosed);
  });
  const proxy = await localProxy(t, {
    EGRESS_IDLE_TIMEOUT_MS: "100",
    EGRESS_ABSOLUTE_TIMEOUT_MS: "400",
    EGRESS_REQUEST_TIMEOUT_MS: "300",
  });
  const client = await proxy.client();
  const established = new Promise((resolve) =>
    client.socket.once("data", resolve),
  );
  client.socket.resume();
  client.socket.write(
    `CONNECT fixture.example:${port} HTTP/1.1\r\nHost: fixture.example\r\n\r\n`,
  );
  await established;
  const interval = setInterval(() => client.socket.write("ping"), 20);
  t.after(() => clearInterval(interval));
  await closes(client.closed, "active CONNECT escaped absolute timeout");
  clearInterval(interval);
  await closes(closed, "absolute timeout left CONNECT upstream open");
});

test("HTTP requests have a deadline and logs never contain paths, tokens or errors", async (t) => {
  let upstreamClosed;
  const closed = new Promise((resolve) => {
    upstreamClosed = resolve;
  });
  const port = await localTarget(t, (socket) => {
    socket.resume();
    socket.once("close", upstreamClosed);
  });
  const proxy = await localProxy(t, { EGRESS_REQUEST_TIMEOUT_MS: "100" });
  const client = await proxy.client();
  client.socket.resume();
  client.socket.write(
    `GET http://fixture.example:${port}/secret?token=never-log-me HTTP/1.1\r\nHost: fixture.example\r\nAuthorization: Bearer never-log-me\r\n\r\n`,
  );
  await closes(client.closed, "HTTP request escaped deadline");
  await closes(closed, "timed out HTTP request left upstream open");
  assert.ok(
    proxy.logs.some((line) => JSON.parse(line).reason === "request_timeout"),
  );
  assert.ok(!proxy.logs.join("\n").includes("never-log-me"));
  assert.ok(!proxy.logs.join("\n").includes("fixture.example"));
});

test("denial logging has a fixed emission bound", async (t) => {
  const { port, logs } = await localProxy(t);
  for (let i = 0; i < 60; i++)
    await new Promise((resolve, reject) => {
      const req = request(
        {
          host: "127.0.0.1",
          port,
          path: "http://user:never-log-me@fixture.example/secret",
          agent: false,
        },
        (res) => {
          res.resume();
          res.once("end", resolve);
        },
      );
      req.on("error", reject);
      req.end();
    });
  assert.ok(logs.length <= 20, `unexpected log volume: ${logs.length}`);
  assert.ok(!logs.join("\n").includes("never-log-me"));
});
