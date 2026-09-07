# ADR 0014: Scoped authorization proxy to stock OpenClaw

Date: 2026-09-07. Status: accepted on `work/openclaw-scoped-proxy`; live
subscription/browser acceptance remains separate.

This supersedes ADR 0013's native-patch implementation prescription. The native
experiment remains preserved on its parent branch and in this branch's patch and
plugin artifacts; it is not on the scoped proxy's install, build, startup or
compatibility path.

## Decision

Run a small trusted Agent Connect authorization proxy in front of the published,
integrity-pinned, **unmodified** OpenClaw `POST /v1/responses` endpoint. Reuse the
existing delegated OAuth/PAR/PKCE, consent, rotating refresh, revocation and web
SDK contracts. OpenClaw continues to own inference, native tool execution,
sandboxing, context, session history and native Responses events. The proxy does
not implement an agent loop or a replacement Responses engine.

The browser presents only its origin-bound `ac_access_…` grant. The proxy
constructs a new upstream request and sends its private OpenClaw operator bearer
to one configured loopback origin. It chooses the dedicated agent and a fresh
lowercase private session key. Caller cookies, forwarding identity, OpenClaw
routing/scopes, `user`, unknown fields, media and arbitrary URLs are rejected or
omitted. The public logical model remains `openclaw/default`; the upstream model
selector is server-owned.

The supported request profile is deliberately smaller than stock OpenClaw's:

- text-only user input and correlated `function_call_output` items;
- the exact owner-approved application function snapshot, re-injected on every
  segment;
- optional `instructions`, bounded output/sampling controls, and supported
  application-only `tool_choice`;
- streaming or non-streaming creation and one explicit
  `previous_response_id` continuation.

No input images/files, remote media fetching, stable `user` routing, metadata,
background work, arbitrary history replay or ignored compatibility knobs are
accepted in version zero.

## Conversation and failure boundary

An observed upstream response id is never bearer authority. A bounded in-memory
registry binds one current checkpoint to the grant's stable authorization
version, policy fingerprint, agent, tool hash, private conversation and pending
call ids. A continuation consumes its predecessor immediately before the
upstream POST, so a failed or disconnected attempt is not replayable. Refresh
rotates credentials without changing grant identity. Revocation, expiry, policy
change, sibling grants, proxy restart and the 30-minute mapping expiry all make
continuation unavailable and require a new conversation or reconsent as
appropriate. There is no generic exactly-once claim: upstream effects can be
ambiguous after admission.

Streaming events retain native bytes and framing. The proxy parses one bounded
SSE frame at a time only to observe response ids, terminal status, client call
names and call ids. An unapproved function call is stopped before its event is
published. The proxy waits for the upstream stream to close before releasing the
terminal frame, avoiding a stock OpenClaw session-finalization race while
preserving event order. Non-streaming bodies are bounded and inspected before
publication. Upstream bodies, credentials, redirects and private errors are not
forwarded on failure.

## Owner authentication and deployment

Tailscale or private-network reachability is not owner authentication. The proxy
uses the gateway's existing one-time enrollment secret to establish a dedicated
HttpOnly, Secure, SameSite owner-browser session before showing consent. Arbitrary
`Tailscale-User-Login` and forwarding headers have no authority. Tailscale Serve
may still be the operator-managed HTTPS transport.

OpenClaw and the proxy are a single supervised local composition, not a mutable
remote pairing. Startup verifies the published package's version, tarball URL,
integrity record and absence of the patch-only export. The private OpenClaw JSON
must pin loopback, port, exact operator token, Responses enablement and
`gateway.reload.mode="off"`. Each offered policy names a dedicated agent with an
absolute isolated workspace, no bootstrap/context/skills/memory inheritance, no
fallback model, exact native tool ceiling and disabled elevation/tool search.
Code execution additionally requires a per-session, no-egress container sandbox
with no host binds and no writable host workspace.

The proxy fingerprints the entire OpenClaw config and policy files, rechecks both
before upstream effects and fails closed after any edit. A supervisor must stop
both processes, replace config, restart OpenClaw, restart the proxy and obtain
fresh consent. This is intentionally not described as an atomic hot-reload fence.
Starting OpenClaw under some other config while reusing the same token/port is
outside the supported composition; process supervision owns that invariant.

## Evidence boundary

The stock proof runs the published `2026.9.1` package with deterministic
inference. It verifies a dedicated deny-all agent against owner-origin direct
`/exec`, elevated and hallucinated native exec attempts, and verifies an
unavailable Docker sandbox fails before inference. The composition test uses the
real web SDK, owner login, OAuth, stock native Responses, two application tool
results, follow-up context, refresh and revoke. It spends no model allowance.

These checks do not prove the eventual selected subscription model's judgment,
credential lifetime, operator supervisor setup, HTTPS ingress or Bookhand UI.
Those remain an explicitly coordinated live acceptance step.
