# OpenClaw in-process delegation feasibility

Goal: decisively establish whether an owner-installed plugin can combine device-style
app approval with existing OpenClaw Responses, native app-specific session authority
and normal owner-approved agent capabilities, without a separate gateway process or
new agent/Responses engine. Optional publisher metadata is independent from pairing;
an Origin is not required for native clients. No production cutover is authorized.

Investigation: see the 2026-09-05 app-delegation research. Real device bearer HTTP
authentication fails, whereas trusted-proxy app identity can enter Responses and
reject another app. Second-turn and persisted creator/sandbox proof now exists.
Working composition: plugin-auth public ingress -> narrow same-server gateway-auth provisioning
route -> existing Responses, using fresh trusted-proxy headers for an app identity.

Inventory: owner-approved unverified installation, pending/denied/revoked access,
native/originless requests; HTTP JSON/SSE and client tools alongside native tools;
two app identities, native creator provenance, agent restriction and sandbox policy.
All map to the three contract files. This is a feasibility prototype, not a claim
of production token persistence, polished browser consent, mobile UX, or complete
hostile-app hardening. Such missing work must be listed explicitly in the verdict.

Readiness: isolated published OpenClaw 2026.9.1 and local deterministic inference
already run via scripts/openclaw-test-runtime.mjs. Use disposable credentials and
state only; do not touch agc, agc-openclaw, Bookhand, Serve, or personal auth. No
external writes/posts/pushes. Runtime planning tools are unavailable here; local
contracts, bounded agents, and executable evidence carry the investigation.

Status: two sequential independent contract-review passes passed. Implementer
lane owns only docs/research/support/delegation-plugin and its probe. The existing
test runtime gained an optional configure hook for isolated auth/plugin setup.
Source scrutiny and an independent API run passed pairing/runtime; its first
authority review caught missing hostile-header/body evidence. The amended probe
passes those cases in a fresh independent reproduction: all three feasibility
contracts now pass. See the [validation report](../../reviews/2026-09-05-openclaw-plugin-feasibility.md).
The separate
sandbox probe proves required policy fails closed before inference, with an
unsandboxed positive control. See the research report for precise limits.

The result is a feasible plugin direction, not production completion. Next work
is durable grants, actual owner approval UI, routing/CORS configuration, SDK and
Bookhand composition, and an explicit policy for lifecycle/tool snapshots. Keep
native agent capabilities under owner policy; do not reintroduce an agent loop.

New hard constraint from source tracing: an ordinary listener behind external
Tailscale Serve can classify forwarded requests as trusted-proxy and accept a
forged app identity header. Public ingress must expose only the plugin public
prefix; private provisioning must be outside that prefix, and core API/WS paths
remain private. This uses existing ingress routing, not an additional AC server.
Processes with local access to that trusted listener are within its trust domain.
The authority contract now explicitly requires route-boundary evidence.
