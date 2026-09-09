# Archived ADR 0014: Scoped authorization proxy to stock OpenClaw

Date: 2026-09-07. Status: archived after supersession by ADR 0015.

Archived 2026-09-09. The standalone implementation and tests were removed from
`main`; git history preserves the executable source. This document is historical
evidence, not a supported deployment or rollback instruction.

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

The validator is field-closed for the gateway, inherited agent defaults, global
tool/plugin policy, every policy-offered agent and each model selected by an
offered agent. Conditional/global tool layers and extra fields on an offered
agent remain unsupported and fail closed. Unoffered personal agents, their model
entries, provider definitions and authentication profiles may coexist; they are
operator-owned, are not certified by this policy, and cannot be selected by an
application. A grant fixes one offered policy and its agent, and the proxy writes
that agent id into the private upstream request.

At startup the proxy uses OpenClaw's published Gateway client and the same private
operator token to call stock `config.get`. It validates the redacted
`sourceConfig`, requires a valid snapshot and requires the server-issued resolved
`configRevisionHash` to equal the non-null server-issued `appliedConfigHash`.
The applied revision is included in policy fingerprints. The projected raw-file
`hash` has a different domain and remains only a write-conflict revision; it is
never compared with either resolved revision or a locally calculated digest.

The proxy still hashes its full local config and policy files because
`config.get` intentionally redacts the literal operator credential. It rechecks
those local inputs and repeats authenticated `config.get` immediately before
each Responses admission, health success and owner consent decision. A missing,
changed or unapplied runtime revision fails closed. This is drift detection, not
an atomic admission fence: a trusted operator can still reconfigure OpenClaw in
the interval after the check. Concurrent operator reconfiguration is outside the
guarantee. The supported operation remains stop both processes, replace config,
restart OpenClaw, restart the proxy and obtain fresh consent; no supervisor,
hot-reload protocol or native patch is introduced.

For an admitted Responses request, disconnect observation begins before body
reading and runtime verification. After the awaited `config.get`, the proxy
checks both disconnect state and current grant authority immediately before it
reserves a conversation or sends the upstream POST. This closes local
revocation/expiry and disconnect races without claiming cross-process atomicity.

## Evidence boundary

The stock proof runs the published `2026.9.1` package with deterministic
inference. It verifies a dedicated deny-all agent against owner-origin direct
`/exec`, elevated and hallucinated native exec attempts, and verifies an
unavailable Docker sandbox fails before inference. The composition test uses the
real web SDK, owner login, OAuth, stock native Responses, two application tool
results, follow-up context, refresh and revoke. It invokes the same production
policy validator used at launcher startup against stock `config.get`, rather
than a partial test-only assertion. That fixture also observes stock redaction,
distinct raw/resolved revision domains, saved/applied equality and rejection
after a disposable on-disk edit while reload is off. Unit coverage proves the
optional/missing applied revision is rejected, unrelated personal agents can
coexist, unsafe offered agents are rejected, and revocation or a disconnect
during the runtime lookup has no upstream effect. It spends no model allowance.

These checks do not prove the eventual selected subscription model's judgment,
credential lifetime, operator supervisor setup, HTTPS ingress or Bookhand UI.
Those remain an explicitly coordinated live acceptance step.
