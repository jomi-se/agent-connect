import assert from "node:assert/strict";
import { startOpenClawTestRuntime } from "../../../scripts/openclaw-test-runtime.mjs";
const rt = await startOpenClawTestRuntime({
  configure(c) {
    c.gateway.trustedProxies = ["127.0.0.1"];
    c.gateway.auth = {
      mode: "trusted-proxy",
      trustedProxy: {
        allowLoopback: true,
        userHeader: "x-ac-principal",
        requiredHeaders: ["x-forwarded-for"],
      },
    };
    c.gateway.roles = {
      default: "application",
      definitions: {
        application: {
          sessions: { others: "none" },
          agents: ["main"],
          scopes: ["operator.read", "operator.write"],
        },
      },
    };
  },
});
try {
  async function call(identity, key, extra = {}, input = "Hello") {
    const r = await fetch(`${rt.baseUrl}/v1/responses`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-forwarded-for": "192.0.2.7",
        "x-ac-principal": identity,
        "x-openclaw-scopes": "operator.write",
        "x-openclaw-session-key": key,
        ...extra,
      },
      body: JSON.stringify({ model: "openclaw", stream: false, input }),
      signal: AbortSignal.timeout(30000),
    });
    const b = await r.json();
    console.log(
      JSON.stringify({
        identity,
        status: r.status,
        responseStatus: b.status,
        error: b.error?.message,
        tools: rt.modelRequests
          .at(-1)
          ?.body.tools?.map((x) => x.function?.name),
      }),
    );
    return { status: r.status, body: b };
  }
  const key = "agent:main:openresponses:delegation-proof";
  const a = await call("app:a", key);
  assert.equal(a.status, 200);
  const again = await call("app:a", key);
  assert.equal(again.status, 403);
  const b = await call("app:b", key);
  assert.equal(b.status, 403);
  const elevate = await call("app:a", "agent:main:openresponses:another", {
    "x-openclaw-scopes": "operator.admin",
  });
  assert.equal(elevate.status, 403);
  console.log(
    `PASS implicit-session same-app continuation regression reproduced; evidence ${rt.directory}`,
  );
} finally {
  await rt.close();
}
