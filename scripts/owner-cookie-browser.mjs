// Actual gateway cookies through a disposable TLS terminator and real Chromium.
// The certificate exception qualifies cookie enforcement, not browser HSTS learning.
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { request as forward } from "node:http";
import { createServer } from "node:https";
import net from "node:net";
import { join } from "node:path";
import { ownerTerminal } from "../deploy/gateway/test/clean-room/owner-terminal.mjs";
import { runCleanupTasks, stopFixtureChild } from "./test-fixture-cleanup.mjs";

export const ownerCookieResolverRules =
  "MAP owner.example.test 127.0.0.1, MAP sibling.example.test 127.0.0.1";
const selectedName = "__Host-agent_connect_owner";
const ownerPath = "/agent-connect/owner";
const loginPath = `${ownerPath}/login`;
const logoutPath = `${ownerPath}/logout`;

async function availablePort() {
  const listener = net.createServer();
  try {
    await new Promise((ok, fail) => {
      listener.once("error", fail);
      listener.listen(0, "127.0.0.1", ok);
    });
    return listener.address().port;
  } finally {
    if (listener.listening)
      await new Promise((ok, fail) =>
        listener.close((error) => (error ? fail(error) : ok())),
      );
  }
}

async function assertSetCookie(response, maxAge) {
  const headers = (await response.headersArray())
    .filter(({ name }) => name.toLowerCase() === "set-cookie")
    .map(({ value }) => value);
  assert.equal(headers.length, 1, "Gateway emits exactly one selected cookie");
  const value = headers[0];
  assert.ok(value.startsWith(`${selectedName}=`));
  const attributes = value.slice(value.indexOf(";"));
  assert.match(attributes, /; Path=\/(?:;|$)/);
  assert.match(attributes, /; HttpOnly(?:;|$)/);
  assert.match(attributes, /; Secure(?:;|$)/);
  assert.match(attributes, /; SameSite=Lax(?:;|$)/);
  assert.ok(attributes.includes(`; Max-Age=${maxAge};`));
  assert.doesNotMatch(attributes, /;\s*Domain=/i);
  assert.equal(
    await response.headerValue("strict-transport-security"),
    "max-age=31536000",
  );
  return value;
}

export async function verifyOwnerCookies({
  browser,
  binary,
  root,
  fixtureEnv,
  password,
}) {
  const directory = await mkdtemp(join(root, "cookie-browser-"));
  const sockets = new Set();
  const upstreams = new Set();
  const forwarded = [];
  const proxyErrors = [];
  let proxy;
  let gateway;
  let gatewayClosed;
  let context;
  try {
    await Promise.all(
      ["home", "state"].map((name) => mkdir(join(directory, name))),
    );
    const env = {
      ...fixtureEnv,
      HOME: join(directory, "home"),
      XDG_STATE_HOME: join(directory, "state"),
    };
    const keyPath = join(directory, "fixture-key.pem");
    const certificatePath = join(directory, "fixture-cert.pem");
    const certificate = spawnSync(
      "openssl",
      [
        "req",
        "-x509",
        "-newkey",
        "rsa:2048",
        "-nodes",
        "-days",
        "1",
        "-keyout",
        keyPath,
        "-out",
        certificatePath,
        "-subj",
        "/CN=owner.example.test",
        "-addext",
        "subjectAltName=DNS:owner.example.test,DNS:sibling.example.test",
      ],
      { env, encoding: "utf8", timeout: 20000 },
    );
    assert.equal(
      certificate.status,
      0,
      `HTTPS owner-cookie fixture requires openssl with req -addext support: ${certificate.error?.message ?? certificate.stderr}`,
    );
    await chmod(keyPath, 0o600);
    const port = await availablePort();
    proxy = createServer(
      {
        key: await readFile(keyPath),
        cert: await readFile(certificatePath),
      },
      (request, response) => {
        const hostname = request.headers.host?.split(":")[0];
        let cookies;
        if (
          hostname === "sibling.example.test" &&
          request.url === "/cookie-shadow"
        ) {
          cookies = [
            `${selectedName}=parent-shadow; Domain=example.test; Path=/; Secure; HttpOnly; SameSite=Lax`,
            "cookie_domain_control=accepted; Domain=example.test; Path=/; Secure; SameSite=Lax",
          ];
        } else if (
          hostname === "owner.example.test" &&
          request.url === "/cookie-path-shadow"
        ) {
          cookies = [
            `${selectedName}=path-shadow; Path=/agent-connect; Secure; HttpOnly; SameSite=Lax`,
            "cookie_path_control=accepted; Path=/agent-connect; Secure; SameSite=Lax",
          ];
        } else if (
          hostname === "sibling.example.test" &&
          request.url === "/cookie-legacy"
        ) {
          cookies = [
            "agent_connect_owner=legacy-shadow; Domain=example.test; Path=/agent-connect; Secure; HttpOnly; SameSite=Lax",
          ];
        } else if (
          hostname === "sibling.example.test" &&
          request.url === "/cookie-legacy-byte"
        ) {
          cookies = [
            "agent_connect_owner=legacy-\xFF; Domain=example.test; Path=/agent-connect; Secure; HttpOnly; SameSite=Lax",
          ];
        }
        if (cookies) {
          response.writeHead(200, {
            "Content-Type": "text/html",
            "Set-Cookie": cookies,
          });
          response.end(
            "<!doctype html><title>Cookie fixture</title><h1>Cookie response processed</h1>",
          );
          return;
        }
        if (hostname !== "owner.example.test") {
          response.writeHead(404).end();
          return;
        }
        forwarded.push({
          method: request.method,
          path: request.url,
          cookie: request.headers.cookie ?? "",
        });
        const upstream = forward(
          {
            hostname: "127.0.0.1",
            port,
            path: request.url,
            method: request.method,
            headers: request.headers,
            agent: false,
          },
          (reply) => {
            // Raw headers retain individual Set-Cookie fields; redirects stay with Chromium.
            response.writeHead(reply.statusCode, reply.rawHeaders);
            reply.on("error", (error) => {
              proxyErrors.push(error.message);
              response.destroy();
            });
            reply.pipe(response);
          },
        );
        upstreams.add(upstream);
        upstream.once("close", () => upstreams.delete(upstream));
        upstream.on("error", (error) => {
          proxyErrors.push(error.message);
          if (!response.headersSent) response.writeHead(502);
          response.end();
        });
        request.once("aborted", () => upstream.destroy());
        request.pipe(upstream);
      },
    );
    proxy.on("connection", (socket) => {
      sockets.add(socket);
      socket.once("close", () => sockets.delete(socket));
    });
    await new Promise((ok, fail) => {
      proxy.once("error", fail);
      proxy.listen(0, "127.0.0.1", ok);
    });
    const tlsPort = proxy.address().port;
    const origin = `https://owner.example.test:${tlsPort}`;
    const sibling = `https://sibling.example.test:${tlsPort}`;
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
    assert.equal(setup.code, 0, setup.stderr);
    const configPath = join(runtime, "config.json");
    const config = JSON.parse(await readFile(configPath, "utf8"));
    Object.assign(config, {
      boxed: false,
      mock_root: root,
      harness_home: undefined,
      listen: `127.0.0.1:${port}`,
    });
    await writeFile(configPath, JSON.stringify(config), { mode: 0o600 });
    gateway = spawn(binary, ["serve", "--config", configPath], {
      env,
      stdio: ["ignore", "ignore", "pipe"],
    });
    let diagnostics = "";
    let startupError;
    gateway.stderr.on("data", (chunk) => {
      diagnostics = (diagnostics + chunk).slice(-4000);
    });
    gateway.on("error", (error) => {
      startupError = error;
    });
    gatewayClosed = new Promise((ok) => gateway.once("close", ok));
    for (let attempt = 0; attempt < 100; attempt++) {
      if (startupError) throw startupError;
      assert.equal(gateway.exitCode, null, diagnostics);
      if (diagnostics.includes("listening on")) break;
      await new Promise((ok) => setTimeout(ok, 50));
    }
    assert.match(diagnostics, /listening on/);
    context = await browser.newContext({ ignoreHTTPSErrors: true });
    const page = await context.newPage();
    const owner = `${origin}${ownerPath}`;
    const signIn = await page.goto(owner);
    await page.getByLabel("Owner passphrase").waitFor();
    await assertSetCookie(signIn, 43200);
    await page.getByLabel("Owner passphrase").fill(password);
    const [signedIn] = await Promise.all([
      page.waitForResponse(
        (reply) =>
          reply.url() === `${origin}${loginPath}` &&
          reply.request().method() === "POST",
      ),
      page.getByRole("button", { name: "Sign in", exact: true }).click(),
    ]);
    await assertSetCookie(signedIn, 43200);
    await page
      .getByRole("heading", { name: "No apps yet", exact: true })
      .waitFor();
    const ownerCookies = (await context.cookies()).filter(
      ({ name }) => name === selectedName,
    );
    assert.equal(ownerCookies.length, 1);
    const ownerCookie = ownerCookies[0];
    assert.equal(ownerCookie.domain, "owner.example.test");
    assert.equal(ownerCookie.path, "/");
    assert.equal(ownerCookie.secure, true);
    assert.equal(ownerCookie.httpOnly, true);
    assert.equal(ownerCookie.sameSite, "Lax");
    assert.ok(ownerCookie.value.startsWith("owner_"));
    await page.reload();
    await page
      .getByRole("heading", { name: "No apps yet", exact: true })
      .waitFor();
    async function assertOwnerWorks() {
      await page.goto(owner);
      await page
        .getByRole("heading", { name: "No apps yet", exact: true })
        .waitFor();
      const selected = (await context.cookies()).filter(
        ({ name }) => name === selectedName,
      );
      assert.equal(selected.length, 1, "Browser rejects prefixed shadows");
      assert.ok(
        selected[0].value === ownerCookie.value,
        "Owner credential remains unchanged",
      );
      assert.equal(selected[0].domain, "owner.example.test");
      assert.equal(selected[0].path, "/");
    }
    await assertOwnerWorks();
    await page.goto(`${sibling}/cookie-shadow`);
    assert.ok(
      (await context.cookies(owner)).some(
        ({ name, value, domain }) =>
          name === "cookie_domain_control" &&
          value === "accepted" &&
          domain === ".example.test",
      ),
      "Ordinary parent-Domain control proves sibling response was processed",
    );
    await assertOwnerWorks();
    await page.goto(`${origin}/cookie-path-shadow`);
    assert.ok(
      (await context.cookies(owner)).some(
        ({ name, value, path }) =>
          name === "cookie_path_control" &&
          value === "accepted" &&
          path === "/agent-connect",
      ),
      "Ordinary path control proves non-root cookie response was processed",
    );
    await assertOwnerWorks();
    await page.goto(`${sibling}/cookie-legacy`);
    assert.ok(
      (await context.cookies(owner)).some(
        ({ name, domain, path }) =>
          name === "agent_connect_owner" &&
          domain === ".example.test" &&
          path === "/agent-connect",
      ),
    );
    await assertOwnerWorks();
    const credentials = forwarded.findLast(
      ({ path }) => path === ownerPath,
    ).cookie;
    assert.ok(
      credentials.split(/;\s*/).includes("agent_connect_owner=legacy-shadow"),
    );
    assert.ok(
      credentials
        .split(/;\s*/)
        .includes(`${selectedName}=${ownerCookie.value}`),
    );
    await page.goto(`${sibling}/cookie-legacy-byte`);
    // Chromium's cookie-inspection API can hide non-UTF-8 bytes. Check that the
    // old value was replaced, then inspect the actual forwarded request below.
    const nonAsciiStored = (await context.cookies(owner)).some(
      ({ name, value }) =>
        name === "agent_connect_owner" && value !== "legacy-shadow",
    );
    await page.goto(owner);
    const byteCredentials = forwarded.findLast(
      ({ path }) => path === ownerPath,
    ).cookie;
    assert.ok(
      byteCredentials
        .split(/;\s*/)
        .includes(`${selectedName}=${ownerCookie.value}`),
    );
    const nonAsciiForwarded = byteCredentials
      .split(/;\s*/)
      .some(
        (pair) =>
          pair.startsWith("agent_connect_owner=") && /[^\x00-\x7F]/.test(pair),
      );
    console.log(
      `Owner-cookie Latin-1 probe: ${JSON.stringify({ stored: nonAsciiStored, forwarded: nonAsciiForwarded, authenticated: page.url() === owner })}`,
    );
    assert.equal(
      page.url(),
      owner,
      "An ordinary non-ASCII legacy cookie must not poison the selected credential",
    );
    await page
      .getByRole("heading", { name: "No apps yet", exact: true })
      .waitFor();
    const beforeLogout = forwarded.length;
    const [signedOut] = await Promise.all([
      page.waitForResponse(
        (reply) =>
          reply.url() === `${origin}${logoutPath}` &&
          reply.request().method() === "POST",
      ),
      page.getByRole("button", { name: "Sign out", exact: true }).click(),
    ]);
    assert.equal(
      await assertSetCookie(signedOut, 0),
      `${selectedName}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0; Secure`,
    );
    await page.getByLabel("Owner passphrase").waitFor();
    const afterLogout = forwarded
      .slice(beforeLogout)
      .find(({ method, path }) => method === "GET" && path === loginPath);
    assert.ok(afterLogout, "Browser followed the actual logout redirect");
    assert.ok(
      !afterLogout.cookie
        .split(/;\s*/)
        .some((pair) => pair.startsWith(`${selectedName}=`)),
      "Logout removes the selected cookie before sign-in issues an anonymous replacement",
    );
    const anonymous = (await context.cookies()).filter(
      ({ name }) => name === selectedName,
    );
    assert.equal(anonymous.length, 1);
    assert.ok(anonymous[0].value.startsWith("anonymous_"));
    await page.goto(owner);
    await page.getByLabel("Owner passphrase").waitFor();
    assert.equal(page.url(), `${origin}${loginPath}`);
    assert.deepEqual(proxyErrors, []);
    return {
      tlsGatewayCookie: true,
      parentDomainShadowRejected: true,
      nonRootPathShadowRejected: true,
      legacyCookieIgnored: true,
      logoutExpiredOwner: true,
      hstsHeader: true,
      nonAsciiLegacy: { stored: nonAsciiStored, forwarded: nonAsciiForwarded },
    };
  } finally {
    try {
      await runCleanupTasks([
        () => context?.close(),
        async () => {
          for (const upstream of upstreams) upstream.destroy();
          const closed = proxy?.listening
            ? new Promise((ok, fail) =>
                proxy.close((error) => (error ? fail(error) : ok())),
              )
            : undefined;
          for (const socket of sockets) socket.destroy();
          await closed;
        },
        () => stopFixtureChild(gateway, { exited: gatewayClosed }),
      ]);
    } catch {
      const failure = new Error(
        "Cookie-browser fixture shutdown was not confirmed; disposable runtime retained.",
      );
      // The caller must preserve its outer root too while a child may remain.
      Object.defineProperty(failure, "retainedDirectory", { value: directory });
      throw failure;
    }
    await rm(directory, { recursive: true, force: true });
  }
}
