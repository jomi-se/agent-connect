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
