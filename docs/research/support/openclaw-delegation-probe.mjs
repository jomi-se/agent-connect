import assert from "node:assert/strict";
import { generateKeyPairSync, createHash } from "node:crypto";
import { startOpenClawTestRuntime } from "/home/dev/agent-connect-openclaw/scripts/openclaw-test-runtime.mjs";

const runtime = await startOpenClawTestRuntime();
try {
  process.env.OPENCLAW_STATE_DIR = `${runtime.directory}/state`;
  process.env.OPENCLAW_HOME = runtime.directory;
  process.env.OPENCLAW_CONFIG_PATH = `${runtime.directory}/openclaw.json`;
  const dist =
    "/tmp/agent-connect-openclaw-install-rehearsal.V25XnV/install/node_modules/openclaw/dist/";
  const { h: requestPairing } = await import(
    `${dist}device-pairing-WbMm3LtM.js`
  );
  const { n: approvePairing } = await import(
    `${dist}device-pairing-approval-MZT1nVSk.js`
  );
  const {
    n: ensureToken,
    s: verifyToken,
    i: revokeToken,
  } = await import(`${dist}device-pairing-tokens-1RDMJSog.js`);
  const raw = generateKeyPairSync("ed25519")
    .publicKey.export({ type: "spki", format: "der" })
    .subarray(-32);
  const deviceId = createHash("sha256").update(raw).digest("hex");
  const scopes = ["operator.read", "operator.write"];
  const baseDir = process.env.OPENCLAW_STATE_DIR;
  const pending = await requestPairing(
    {
      deviceId,
      publicKey: raw.toString("base64url"),
      role: "operator",
      scopes,
      clientId: "gateway-client",
      clientMode: "backend",
    },
    baseDir,
  );
  const approved = await approvePairing(
    pending.request.requestId,
    { callerScopes: ["operator.admin"], approvedVia: "owner" },
    baseDir,
  );
  assert(approved && approved.status !== "forbidden", JSON.stringify(approved));
  const entry = await ensureToken({
    deviceId,
    role: "operator",
    scopes,
    baseDir,
  });
  assert(entry);
  assert.equal(
    (
      await verifyToken({
        deviceId,
        role: "operator",
        scopes,
        token: entry.token,
        baseDir,
      })
    ).ok,
    true,
  );
  assert.equal(
    (
      await verifyToken({
        deviceId,
        role: "operator",
        scopes: ["operator.admin"],
        token: entry.token,
        baseDir,
      })
    ).ok,
    false,
  );
  console.log(
    "PASS genuine paired device token verifies; admin escalation denied",
  );
  async function request(label, token, extra = {}) {
    const res = await fetch(`${runtime.baseUrl}/v1/responses`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${token}`,
        ...extra,
      },
      body: JSON.stringify({
        model: "openclaw",
        input: "Fixture greeting",
        stream: false,
      }),
      signal: AbortSignal.timeout(30000),
    });
    const body = await res.json();
    console.log(
      JSON.stringify({
        label,
        status: res.status,
        responseStatus: body.status,
        error: body.error?.type,
        cors: res.headers.get("access-control-allow-origin"),
      }),
    );
    return res.status;
  }
  assert.equal(await request("device-token Responses", entry.token), 401);
  assert.equal(
    await request("owner-token with read-only header", runtime.token, {
      "x-openclaw-scopes": "operator.read",
    }),
    200,
  );
  const preflight = await fetch(`${runtime.baseUrl}/v1/responses`, {
    method: "OPTIONS",
    headers: {
      origin: "https://bookhand.example",
      "access-control-request-method": "POST",
      "access-control-request-headers": "authorization,content-type",
    },
  });
  console.log(
    JSON.stringify({
      label: "cross-origin preflight",
      status: preflight.status,
      cors: preflight.headers.get("access-control-allow-origin"),
    }),
  );
  await revokeToken({ deviceId, role: "operator", baseDir });
  assert.equal(
    (
      await verifyToken({
        deviceId,
        role: "operator",
        scopes,
        token: entry.token,
        baseDir,
      })
    ).ok,
    false,
  );
  console.log(
    "PASS revocation enforced; inference was local deterministic fixture only",
  );
} finally {
  await runtime.close();
}
