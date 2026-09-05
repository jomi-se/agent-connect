import { randomUUID } from "node:crypto";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { dispatchGatewayMethod } from "openclaw/plugin-sdk/gateway-method-runtime";

// Disposable feasibility fixture: memory-only grants, no production consent UI.
export default {
  id: "ac-delegation-probe",
  register(api) {
    const { ownerSecret, port } = api.pluginConfig;
    const grants = new Map();
    const sessions = new Map();
    const send = (res, status, body) => {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(body));
    };
    const body = async (req) => {
      let raw = "";
      for await (const chunk of req) {
        raw += chunk;
        if (Buffer.byteLength(raw) > 65536) throw Error("body too large");
      }
      return JSON.parse(raw || "{}");
    };
    const headers = (id) => ({
      "content-type": "application/json",
      "x-ac-principal": `app:${id}`,
      "x-forwarded-for": "192.0.2.7",
      "x-openclaw-scopes": "operator.write",
    });
    api.registerHttpRoute({
      path: "/_ac-private/create-session",
      auth: "gateway",
      match: "exact",
      async handler(req, res) {
        try {
          const input = await body(req);
          if (
            req.method !== "POST" ||
            !/^agent:main:ac-probe:[a-f0-9-]+$/.test(input.key)
          )
            return send(res, 400, { error: "invalid create" });
          const result = await dispatchGatewayMethod("sessions.create", {
            agentId: "main",
            key: input.key,
          });
          send(res, result.ok ? 200 : 403, result);
        } catch (error) {
          send(res, 500, { error: String(error.message) });
        }
      },
    });
    api.registerHttpRoute({
      path: "/ac-probe/",
      auth: "plugin",
      match: "prefix",
      async handler(req, res) {
        try {
          if (req.method !== "POST")
            return send(res, 405, { error: "POST required" });
          const input = await body(req);
          if (req.url === "/ac-probe/request") {
            const id = randomUUID(),
              credential = randomUUID();
            grants.set(id, {
              id,
              credential,
              state: "pending",
              name: String(input.name || "Unnamed").slice(0, 80),
              verified: false,
            });
            return send(res, 201, {
              id,
              credential,
              state: "pending",
              verified: false,
            });
          }
          if (req.url === "/ac-probe/decision") {
            if (req.headers.authorization !== `Bearer ${ownerSecret}`)
              return send(res, 401, { error: "owner required" });
            const grant = grants.get(input.id);
            if (
              !grant ||
              !["approved", "denied", "revoked"].includes(input.state)
            )
              return send(res, 400, { error: "invalid decision" });
            grant.state = input.state;
            return send(res, 200, { id: grant.id, state: grant.state });
          }
          const grant = [...grants.values()].find(
            (g) => req.headers.authorization === `Bearer ${g.credential}`,
          );
          if (!grant || grant.state !== "approved")
            return send(res, 403, { error: "grant not approved" });
          if (req.url !== "/ac-probe/responses")
            return send(res, 404, { error: "unknown route" });
          if (input.model && input.model !== "openclaw")
            return send(res, 403, { error: "agent selection forbidden" });
          const opaque = req.headers["x-ac-session"];
          let session = opaque ? sessions.get(opaque) : undefined;
          if (opaque && (!session || session.owner !== grant.id))
            return send(res, 403, { error: "session forbidden" });
          if (!session) {
            session = {
              opaque: randomUUID(),
              owner: grant.id,
              key: `agent:main:ac-probe:${randomUUID()}`,
            };
            const created = await fetch(
              `http://127.0.0.1:${port}/_ac-private/create-session`,
              {
                method: "POST",
                headers: headers(grant.id),
                body: JSON.stringify({ key: session.key }),
                signal: AbortSignal.timeout(15000),
              },
            );
            if (!created.ok)
              return send(res, 502, {
                error: "native provisioning failed",
                native: await created.json(),
              });
            sessions.set(session.opaque, session);
          }
          const upstream = await fetch(
            `http://127.0.0.1:${port}/v1/responses`,
            {
              method: "POST",
              headers: {
                ...headers(grant.id),
                "x-openclaw-agent-id": "main",
                "x-openclaw-session-key": session.key,
              },
              body: JSON.stringify({ ...input, model: "openclaw" }),
              signal: AbortSignal.timeout(45000),
            },
          );
          res.writeHead(upstream.status, {
            "content-type":
              upstream.headers.get("content-type") || "application/json",
            "x-ac-session": session.opaque,
          });
          await pipeline(Readable.fromWeb(upstream.body), res);
        } catch (error) {
          if (!res.headersSent)
            send(res, 500, { error: String(error.message) });
          else res.destroy();
        }
      },
    });
  },
};
