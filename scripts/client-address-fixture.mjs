// Real HTTP/CLI admission proof; no agent session, model or provider login.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { request as httpRequest } from "node:http";
import net from "node:net";
import { join } from "node:path";
import { ownerTerminal } from "../deploy/gateway/test/clean-room/owner-terminal.mjs";

const ownerPath = "/agent-connect/owner";
const loginPath = `${ownerPath}/login`;
const clientHeader = "x-fixture-client-address";
const cookieName = "agent_connect_owner";
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function availablePort() {
  const listener = net.createServer();
  try {
    await new Promise((resolve, reject) => {
      listener.once("error", reject);
      listener.listen(0, "127.0.0.1", resolve);
    });
    return listener.address().port;
  } finally {
    if (listener.listening)
      await new Promise((resolve, reject) =>
        listener.close((error) => (error ? reject(error) : resolve())),
      );
  }
}

async function stopGateway(child, closed) {
  if (!child) return;
  let timer;
  async function stoppedWithin(ms) {
    try {
      return await Promise.race([
        closed.then(() => true),
        new Promise((resolve) => {
          timer = setTimeout(() => resolve(false), ms);
        }),
      ]);
    } finally {
      clearTimeout(timer);
    }
  }
  function signal(name) {
    // A failed signal is not evidence of exit. Still attempt escalation, then
    // require the close acknowledgement before allowing runtime removal.
    try {
      child.kill(name);
    } catch {
      // The bounded close waits below decide whether cleanup was confirmed.
    }
  }
  if (child.exitCode === null && child.signalCode === null) signal("SIGTERM");
  if (await stoppedWithin(5000)) return;
  signal("SIGKILL");
  assert.ok(
    await stoppedWithin(5000),
    "Client-address gateway did not stop after SIGKILL",
  );
}

export async function verifyClientAddressPolicy({
  binary,
  root,
  fixtureEnv,
  password,
}) {
  const directory = await mkdtemp(join(root, "client-address-"));
  const sockets = new Set();
  const requests = new Set();
  const secrets = new Set([password, clientHeader, "127.0.0.2"]);
  const wrongPassword = "client-address-private-passphrase-marker";
  const malformed = "client-address-private-header-marker";
  secrets.add(wrongPassword);
  secrets.add(malformed);
  let gateway;
  let gatewayClosed;
  try {
    await Promise.all(
      ["home", "state"].map((name) =>
        mkdir(join(directory, name), { mode: 0o700 }),
      ),
    );
    const env = {
      ...fixtureEnv,
      HOME: join(directory, "home"),
      XDG_STATE_HOME: join(directory, "state"),
    };
    delete env.RUST_LOG;
    const port = await availablePort();
    const authority = `127.0.0.1:${port}`;
    const origin = `http://${authority}`;
    const runtime = join(directory, "runtime");
    const setup = await ownerTerminal(
      binary,
      [
        "init",
        "--directory",
        runtime,
        "--harness",
        "codex",
        "--public-url",
        origin,
      ],
      password,
      { env, timeout: 60000 },
    );
    // Do not include terminal output: a failure must not retain fixture secrets.
    assert.equal(setup.code, 0, "Client-address fixture initialization failed");
    const configPath = join(runtime, "config.json");
    const config = JSON.parse(await readFile(configPath, "utf8"));
    Object.assign(config, {
      boxed: false,
      mock_root: directory,
      harness_home: undefined,
      listen: authority,
      client_address_policies: {
        [origin]: { header: clientHeader, trusted_peers: ["127.0.0.1"] },
      },
    });
    await writeFile(configPath, JSON.stringify(config), { mode: 0o600 });
    let diagnostics = "";
    let remainder = "";
    let startupError = false;
    const auditLines = [];
    gateway = spawn(binary, ["serve", "--config", configPath], {
      env,
      stdio: ["ignore", "ignore", "pipe"],
    });
    // Keep the listener through shutdown: spawn failure and either failed
    // signal can emit error. Neither substitutes for the close acknowledgement.
    gateway.on("error", () => {
      startupError = true;
    });
    gatewayClosed = new Promise((resolve) => gateway.once("close", resolve));
    gateway.stderr.on("data", (chunk) => {
      diagnostics = (diagnostics + chunk).slice(-4000);
      const lines = (remainder + chunk).split("\n");
      remainder = lines.pop().slice(-4000);
      auditLines.push(
        ...lines.filter((line) => line.includes("owner_sign_in_failed")),
      );
      // Keep unexpected excess events bounded; the exact-count assertion fails.
      auditLines.splice(128);
    });
    for (let attempt = 0; attempt < 200; attempt++) {
      assert.ok(!startupError, "Client-address gateway could not be spawned");
      assert.ok(
        gateway.exitCode === null && gateway.signalCode === null,
        "Client-address gateway exited before readiness",
      );
      if (diagnostics.includes("listening on")) break;
      await delay(50);
    }
    assert.ok(
      diagnostics.includes("listening on"),
      "Client-address gateway did not become ready",
    );

    async function request({
      path = loginPath,
      method = "GET",
      peer = "127.0.0.1",
      headers = [],
      cookie,
      fields,
    }) {
      const body = fields ? new URLSearchParams(fields).toString() : "";
      const rawHeaders = [
        "Host",
        authority,
        "Connection",
        "close",
        ...headers.flat(),
      ];
      if (cookie) rawHeaders.push("Cookie", cookie);
      if (method === "POST")
        rawHeaders.push(
          "Origin",
          origin,
          "Content-Type",
          "application/x-www-form-urlencoded",
          "Content-Length",
          String(Buffer.byteLength(body)),
        );
      return await new Promise((resolve, reject) => {
        const req = httpRequest({
          hostname: "127.0.0.1",
          port,
          path,
          method,
          headers: rawHeaders,
          localAddress: peer,
          agent: false,
        });
        requests.add(req);
        req.once("close", () => requests.delete(req));
        req.once("socket", (socket) => {
          sockets.add(socket);
          socket.once("close", () => sockets.delete(socket));
        });
        req.once("error", (error) => {
          const code = /^[A-Z_]+$/.test(error.code ?? "")
            ? error.code
            : "request failure";
          reject(
            new Error(
              peer === "127.0.0.2"
                ? `Client-address fixture requires a real 127.0.0.2 loopback peer; request failed (${code})`
                : `Client-address fixture HTTP request failed (${code})`,
            ),
          );
        });
        req.setTimeout(10000, () => req.destroy(new Error("fixture timeout")));
        req.once("response", (response) => {
          const localAddress = req.socket.localAddress;
          let text = "";
          response.setEncoding("utf8");
          response.on("data", (chunk) => {
            text += chunk;
            if (text.length > 256 * 1024)
              req.destroy(new Error("fixture response limit"));
          });
          response.once("error", () =>
            reject(new Error("Client-address fixture response failed")),
          );
          response.once("aborted", () =>
            reject(new Error("Client-address fixture response aborted")),
          );
          response.once("end", () => {
            if (localAddress !== peer) {
              reject(
                new Error(
                  "Client-address fixture did not use the required transport peer",
                ),
              );
              return;
            }
            resolve({
              status: response.statusCode,
              headers: response.headers,
              text,
            });
          });
        });
        req.end(body);
      });
    }
    function selectedCookie(reply) {
      const values = reply.headers["set-cookie"] ?? [];
      assert.equal(
        values.length,
        1,
        "Expected one newly issued owner-session cookie",
      );
      const pair = values[0].split(";")[0];
      assert.ok(
        pair.startsWith(`${cookieName}=`),
        "Expected loopback owner cookie",
      );
      const token = pair.slice(cookieName.length + 1);
      assert.ok(token.length > 0, "Expected nonempty owner-session cookie");
      secrets.add(token);
      return pair;
    }
    function csrf(reply) {
      const match = reply.text.match(
        /name='csrf_token' value='([A-Za-z0-9_-]+)'/,
      );
      assert.ok(Boolean(match), "Fresh sign-in form must provide CSRF");
      secrets.add(match[1]);
      return match[1];
    }
    function address(ip) {
      secrets.add(ip);
      return [[clientHeader, ip]];
    }
    async function fresh({ peer = "127.0.0.1", headers, cookie }) {
      const page = await request({ peer, headers, cookie });
      assert.equal(page.status, 200, "Expected a fresh sign-in form");
      if (cookie)
        assert.ok(
          !Object.hasOwn(page.headers, "set-cookie"),
          "Existing anonymous session must be reused",
        );
      return { cookie: cookie ?? selectedCookie(page), csrf: csrf(page) };
    }
    async function attempt(
      form,
      { peer = "127.0.0.1", headers, passphrase = wrongPassword },
    ) {
      return await request({
        method: "POST",
        peer,
        headers,
        cookie: form.cookie,
        fields: { csrf_token: form.csrf, continue: "", passphrase },
      });
    }
    async function exhaust(peer, headersForAttempt) {
      let cookie;
      for (let index = 0; index < 11; index++) {
        const headers = headersForAttempt(index);
        const form = await fresh({ peer, headers, cookie });
        cookie = form.cookie;
        const reply = await attempt(form, { peer, headers });
        assert.equal(
          reply.status,
          index < 10 ? 401 : 429,
          "Sign-in budget must block attempt eleven for this source",
        );
      }
    }

    await exhaust("127.0.0.1", () => address("192.0.2.1"));
    const independentHeaders = address("192.0.2.2");
    const independent = await fresh({ headers: independentHeaders });
    const signedIn = await attempt(independent, {
      headers: independentHeaders,
      passphrase: password,
    });
    assert.equal(
      signedIn.status,
      302,
      "A separate trusted client must still sign in",
    );
    assert.ok(
      signedIn.headers.location === ownerPath,
      "Sign-in must return to the owner console",
    );
    const ownerCookie = selectedCookie(signedIn);

    // Actual localAddress binding, not a forged forwarding header or ConnectInfo.
    await exhaust("127.0.0.2", (index) => address(`192.0.2.${10 + index}`));
    const duplicate = [...address("192.0.2.90"), ...address("192.0.2.91")];
    const variants = [
      [],
      [[clientHeader, malformed]],
      duplicate,
      [[clientHeader, "192.0.2.90, 192.0.2.91"]],
    ];
    await exhaust("127.0.0.1", (index) => variants[index % variants.length]);

    const cappedHeaders = address("192.0.2.30");
    let firstCookie;
    for (let index = 0; index < 8; index++) {
      const form = await fresh({ headers: cappedHeaders });
      firstCookie ??= form.cookie;
    }
    const refused = await request({ headers: cappedHeaders });
    assert.equal(refused.status, 429, "Ninth pending sign-in must be refused");
    assert.ok(
      !Object.hasOwn(refused.headers, "set-cookie"),
      "Refused session must not issue a cookie",
    );
    await fresh({ headers: address("192.0.2.31") });
    const changedHeaders = address("192.0.2.32");
    const preserved = await fresh({
      headers: changedHeaders,
      cookie: firstCookie,
    });
    const changedAddress = await attempt(preserved, {
      // The cookie moved from .30 to .32 for GET; POST the same fresh CSRF
      // from .33 to prove that neither credential is address-bound.
      headers: address("192.0.2.33"),
      passphrase: password,
    });
    assert.equal(
      changedAddress.status,
      302,
      "Cookie and CSRF must remain valid after a client-address change",
    );
    assert.ok(
      changedAddress.headers.location === ownerPath,
      "Address-change sign-in must return to the owner console",
    );
    selectedCookie(changedAddress);

    // Exercise only the per-source request window. The global 600-request
    // ceiling is covered in Rust; this entire fixture stays well below it.
    const pausedHeaders = address("192.0.2.50");
    const metadataPath =
      "/.well-known/oauth-authorization-server/agent-connect";
    for (let index = 0; index < 60; index++) {
      const metadata = await request({
        path: metadataPath,
        headers: pausedHeaders,
      });
      assert.equal(
        metadata.status,
        200,
        "Source metadata requests through sixty must succeed",
      );
    }
    const paused = await request({
      path: metadataPath,
      headers: pausedHeaders,
    });
    assert.equal(
      paused.status,
      429,
      "Unauthenticated request sixty-one must exhaust the source request budget",
    );
    const owner = await request({
      path: ownerPath,
      headers: pausedHeaders,
      cookie: ownerCookie,
    });
    assert.equal(
      owner.status,
      200,
      "Existing owner session must bypass this source's exhausted request budget",
    );
    assert.ok(
      owner.text.includes("Paused for 3 request source groups"),
      "Activity must show trusted, transport and fallback groups separately",
    );
    for (let index = 0; index < 40 && auditLines.length < 33; index++)
      await delay(50);
    assert.equal(
      auditLines.length,
      33,
      "Each failed POST must produce exactly one audit event",
    );
    assert.equal(
      auditLines.filter((line) => line.includes("invalid_credentials")).length,
      30,
    );
    assert.equal(
      auditLines.filter((line) => line.includes("login_rate_limited")).length,
      3,
    );
    for (const secret of secrets) {
      assert.ok(
        !owner.text.includes(secret),
        "Owner Activity must omit client identifiers and submitted secrets",
      );
      assert.ok(
        auditLines.every((line) => !line.includes(secret)),
        "Audit must omit client identifiers and submitted secrets",
      );
    }
    return {
      actualCliPolicyAndTransportPeer: true,
      trustedClientIsolation: true,
      untrustedHeaderIgnored: true,
      sharedMalformedHeaderFallback: true,
      pendingSignInCapPreservesCookies: true,
      cookiesAndCsrfNotAddressBound: true,
      ownerExemptFromSourceRequestPause: true,
      nonSecretAuditAndActivity: true,
    };
  } finally {
    for (const request of requests) request.destroy();
    for (const socket of sockets) socket.destroy();
    try {
      await stopGateway(gateway, gatewayClosed);
    } catch {
      const failure = new Error(
        "Client-address gateway shutdown was not confirmed after bounded TERM/KILL waits; disposable runtime retained.",
      );
      // The owner-ui caller preserves its outer root when this propagates;
      // otherwise its final sweep could undo the retention here.
      Object.defineProperty(failure, "retainedDirectory", { value: directory });
      throw failure;
    }
    await rm(directory, { recursive: true, force: true });
  }
}
