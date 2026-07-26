# Consolidated repository review — 2026-07-26

Produced by a Claude Code (Fable 5) session from three parallel deep-dive reviews:

1. an in-depth code review of the workspace,
2. a review of the planning documents (ADR stack, mission, scope inventory, retrospectives),
3. a reconstruction of the request-routing and auth-model discussion from the main Codex
   session with GPT-5.6 Sol (2026-07-22 18:24 → 2026-07-23 04:42 UTC, messages ~1189–1217 of
   `rollout-2026-07-13T16-20-26-…​.jsonl`).

Repo state at review time: branch `temp-branch-during-judging`, HEAD `53cdc53`
("docs: separate ingress from gateway authorization"). Main branch is frozen until OpenAI
hackathon judging concludes (~August 2026).

---

## Overall verdict

An unusually disciplined hackathon codebase. The security-critical gateway core is ~2,500
dependency-free lines with strict input validation and real behavioral tests of the auth
ceremonies (PKCE replay, redirect mismatch, scrypt concurrency caps). knip, dependency-cruiser,
and jscpd come back essentially clean. The cleanup ahead is lifecycle leaks, observability,
naming debt, and demo scaffolding — not rot.

All three reviews converge on the same frontier: **ADR 0009 (ingress / owner-authentication /
application-authorization decomposition, plus a declarative route registry) is designed but
entirely unbuilt**, and is the natural post-judging workstream.

---

## 1. Code review

### Real bugs

| # | Bug | Where |
|---|-----|-------|
| 1 | **Workspace leak** — session workspaces `.agent-connect-sessions/<uuid>` are removed only on the error path; every successful session and every health-repair leaves a directory behind forever. | `packages/gateway/src/omnigent-runtime.ts:111` |
| 2 | **Unbounded session maps** — `managedSessions` / `sessionsByKey` are never evicted on grant revocation or expiry; expired grants are never pruned from the persisted `connector.json`. | `packages/gateway/src/gateway.ts:130-131` |
| 3 | **Zero logging** — the gateway has no log output at all. Failed auth attempts and 502 causes are invisible to the operator. Highest-value small fix; unblocks debugging everything else. | `packages/gateway/src/gateway.ts` |
| 4 | **SSE proxy robustness** — ignores `write()` backpressure and has no upstream timeout; grant revocation does not abort already-open streams. (Independently flagged in the Codex session — see §3.) | `packages/gateway/src/gateway.ts:424-448` |
| 5 | **Error mapping** — a reserved-tool-name `TypeError` (and other handler throws) fall into the catch-all and surface as 502. | `packages/gateway/src/gateway.ts:474` |
| 6 | **Dead guards** — `connectorAuth &&` conditions that are always truthy. | `gateway.ts:206, 221, 258, 281` |

### Security findings

The grant model itself is strong (Origin + appId + tool-hash + scopes exact-match, PKCE S256).
Three real gaps:

1. **The loopback trust boundary includes the agent itself.** Any local process — including the
   sandboxed Codex, because the bwrap profile sets `allow_network: true`
   (`omnigent-runtime.ts:227`) — can forge the `tailscale-user-login` header on the loopback
   port (`gateway.ts:838-850`) to enumerate and *revoke* grants, and can reach the completely
   unauthenticated Omnigent API on `127.0.0.1:6767`. Under Tailscale Serve those headers are
   only trustworthy if nothing untrusted shares the loopback interface. Fix: network-namespace
   isolation for the agent, or a shared secret between Tailscale Serve and the gateway. This is
   exactly the trust-boundary question Sol confirmed in the Codex session (§3).
2. **Attacker-resettable passphrase throttling** in the public demo — the failure counter is
   keyed per authorization request (`connector-auth.ts:276`), and attackers create those
   requests themselves, so the effective budget is 5 attempts *per fresh request*. Safe with
   the random default passphrase; brute-forceable if an operator sets a weak one. Fix: a
   global attempt budget.
3. **30-day grant token in `sessionStorage`** (`apps/firebase-canvas/src/main.ts:323`) —
   acceptable for the demo, but the integration guide should document the XSS blast radius.
   Related: the SDK never verifies `runtimeId == sha256(connectorPublicKey)`.

### Ranked cleanup list

1. Structured logging in the gateway.
2. Fix the lifecycle leaks (workspaces, session maps, persisted grants).
3. Close the loopback impersonation path (ties into the ADR 0009 trust-boundary decision).
4. Finish the connector→gateway rename — **before the wire format ossifies**
   (`RuntimeCard.connectorPublicKey`, `packages/web-sdk/src/types.ts:1004`;
   `connector-auth.ts`; `connector.json`).
5. Delete hackathon scaffolding.
6. Split `apps/firebase-canvas/src/main.ts` (1,453 lines) — the SDK usage example, effectively
   the best integration doc, is buried under marketing animations.
7. Trim unstable exports from the SDK entry point (`SingleMcpServer`,
   `createBrowserAcpStream`, `connectOmnigent`).
8. Replace Ajv (`packages/web-sdk/src/agent-session.ts:206`) — its `new Function` compilation
   breaks strict-CSP host apps, a real hazard for an embeddable browser SDK.
9. Error-mapping fix, SSE backpressure/timeout, remove dead guards.
10. Global passphrase attempt budget + runtimeId↔key binding check in the SDK.

**Explicitly not worth doing:** an auth redesign beyond ADR 0009; rewriting the hand-rolled tar
(`omnigent-runtime.ts:303-350`) or SSE code for style reasons.

---

## 2. Planning-docs review

### Plan of record

- Accepted: ADRs 0001–0003, 0005, 0007, 0008.
- Superseded: ADR 0004.
- **Proposed only: ADR 0009** — it states plainly: "The current implementation does not yet
  satisfy this decomposition and must not be described as though it does." None of the
  `RouteAccess` / `IngressAdapter` / `OwnerAuthenticator` vocabulary exists in code.

### Documentation drift to fix

- `docs/mission.md` describes ADR 0009 as adopted strategy — it is proposed.
- `docs/README.md` lists superseded ADR 0004 as accepted, no superseded marker.
- `docs/scope-inventory.md` and the current-work doc (dated 2026-07-20) predate the 2026-07-22
  pairing-code removal and grants refactor.
- The grant-route security retrospective has a stale intro.

### Live deadline

- **Judge demo teardown due 2026-08-06** per the current-work doc.

### Decisions the docs call for that were never made

- Accept/amend ADR 0009 and define its interfaces.
- The AG-UI vs ACP application-boundary decision (ADR 0006's gating spike never ran).
- Durable pending-action store (the signature reliability feature from the original handoff).
- OAuth client registration for arbitrary origins; DPoP threat assessment; abuse policy.
- Tool namespacing to lift the Omnigent 0.5.1 pin.
- Operator recovery surface; non-Tailscale transport profile; session-history ownership.

---

## 3. Codex-session reconstruction (routing + auth shape)

The written outcome of this discussion is ADR 0009; the parts that live only in the session:

- **Declarative route registry**: `defineRoute({...})` with mandatory exposure, cors,
  transportAuth, authorization, csrf, rateLimit, body schema + maxBytes, error allowlist,
  audit, handler. Fixed execution pipeline. The route table doubles as an inspectable security
  matrix that can generate tests.
- **Route access classes** (not a privilege ladder): `"public" | "prospective-application" |
  "gateway-owner" | "authorized-application" | "active-session"`.
- **SSE as a first-class route kind** (`response: { kind: "sse-proxy",
  revocation: "abort-stream", … }`) — designed specifically to fix the revocation and
  backpressure bugs the code review independently found (§1 #4).
- **Framework decision deferred to two disposable vertical spikes** — Fastify + thin mandatory
  policy wrapper (leaning), Hapi (challenger) — each implementing 4 representative routes:
  public health JSON, bounded authorization-request JSON, consent POST with CSRF/redirect,
  authenticated upstream SSE proxy. NestJS forbidden (user), Effect rejected, Hono/oRPC noted.
- **Auth model**: four separate ceremonies (gateway authentication via runtime-card challenge,
  gateway-owner authentication, application authorization, session authorization). Only owner
  authentication is pluggable — passphrase→cookie baseline; WebAuthn, OIDC/SSO, Tailscale
  tsidp, managed account as swaps. Deployment profile =
  `{ ingress; ownerAuthentication; applicationExposure }`, explicitly selected and fail-closed
  validated — auto-detected transport must never silently change auth policy.
- **The open trust decision** gating the auth work: is the local agent inside or outside the
  trusted computing boundary? Under Tailscale Serve any local process can fabricate
  `Tailscale-User-Login` on the loopback port, so removing device enrollment is a
  trust-boundary decision, not UX cleanup. ("Enrollment" as a term was banned as ambiguous.)

---

## Suggested post-judging sequence

1. **Now (safe, no code):** fix the doc drift (§2), commit orphan files to the working branch,
   tear down the judge demo on **2026-08-06**. No pushes/merges to main until judging ends.
2. **After judging, first branch:** gateway logging + the lifecycle/leak bugs (§1 #1–3) —
   small, high-value, independent of the redesign.
3. **ADR 0009 track:** accept/amend the ADR, run the two routing spikes, decide the
   agent-trust-boundary question, implement the route-access model — which naturally absorbs
   the SSE revocation/backpressure fixes and the loopback hardening.
4. The connector→gateway rename and scaffolding deletion ride along with whichever branch
   does step 3.
