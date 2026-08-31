# Agent Connect gateway

The gateway is the narrow HTTPS-facing envelope for browser applications. It
binds to loopback, authenticates the configured Tailscale user, and exposes
OAuth authorization, application session provisioning (`POST /v1/app-sessions`),
and the standard Open Responses endpoint (`POST /v1/responses`) along with
namespaced Agent Connect response control routes. The private reference profile
can enroll previously unknown HTTPS Origins through gateway-owned consent; a
static Origin allowlist remains available as an operator policy.

It is intentionally not a general Omnigent reverse proxy and never exposes raw
provider session or stream routes to the client.

## Run locally

For the supported Omnigent/Codex supervisor, dedicated Codex home, current
Tailscale Serve setup, and security boundary, use the
[real gateway guide](../../deploy/real-gateway/README.md). The commands
below show the lower-level generic gateway profile.

```sh
export AGENT_CONNECT_ALLOWED_ORIGINS='https://PROJECT--agent-connect-HASH.web.app'
export AGENT_CONNECT_DYNAMIC_APP_ENROLLMENT='1'
export AGENT_CONNECT_ALLOWED_TAILSCALE_USERS='you@example.com'
export AGENT_CONNECT_WORKSPACE='/path/the/codex-agent-may-use'
export AGENT_CONNECT_STATE_PATH='/owner-only/path/agent-connect.json'
export AGENT_CONNECT_PUBLIC_ENDPOINT='https://MACHINE.TAILNET.ts.net:8443'
export AGENT_CONNECT_TRANSPORT_PROFILE='tailscale-serve'
npm run build --workspace @agent-connect/gateway
node packages/gateway/dist/initialize-main.js
npm run start --workspace @agent-connect/gateway
```

Defaults:

- gateway: `http://127.0.0.1:8787`
- Omnigent: `http://127.0.0.1:6767`

Keep the gateway on loopback. Tailscale Serve terminates HTTPS and adds the
authenticated Tailscale identity headers:

```sh
tailscale serve --bg --https=8443 http://127.0.0.1:8787
```

The browser base URL is then `https://MACHINE.TAILNET.ts.net:8443`. The one-shot
initializer prints a runtime card and generated enrollment secret as clearly
separated outputs. Save the secret in a password manager. It persists only a
salted verifier and refuses to overwrite existing state; normal gateway startup
refuses uninitialized state. Import only the public card into the app; enter the
passphrase only on the gateway-owned consent page.
The app verifies a signed gateway challenge before sending its tools and uses
S256 PKCE to obtain a revocable origin/app/tool-bound grant.

With `AGENT_CONNECT_DYNAMIC_APP_ENROLLMENT=1`, an unknown HTTPS Origin may
reach the signed-challenge and authorization endpoints. This is not ambient
agent access: Tailscale must authenticate the configured operator, the
gateway-owned page requires explicit consent, redirects must remain on the
requesting Origin, and all later requests require the exact bound grant. This
mode is accepted only with `AGENT_CONNECT_TRANSPORT_PROFILE=tailscale-serve`.
Applications may revoke their own grant through bearer-authenticated
`POST /oauth/revoke`; the response deliberately does not reveal whether the
submitted token existed. Gateway-owned grant listing and administrative
revocation remain on `/v1/grants`.

The gateway uploads its narrow Codex ACP agent bundle, selects the one online
Omnigent host, launches the runner, and replaces an unhealthy runner
automatically. Set `AGENT_CONNECT_OMNIGENT_HOST_ID` when several hosts are
online. Raw Omnigent session ids never enter the browser configuration. When an
application session is retired, the gateway deletes the provider session and
removes the per-session workspace it created, so runners do not accumulate.

## Selecting a session

Which session a request means is decided by the credential it presents, and
only by that:

| Credential         | `POST /v1/app-sessions` means                 |
| ------------------ | --------------------------------------------- |
| Application grant  | provision a new independent session, always   |
| Session capability | refresh the one session that capability names |
| Neither            | `401` — no session may be selected implicitly |

There is deliberately no third case. The only key a grant-based lookup could
search by is origin, application, and tool snapshot, which every tab of that
application shares, so "the newest match" is ambient state the caller neither
names nor owns; with parallel sessions it would eventually connect one tab to
another tab's conversation. An extra session is bounded by expiry and capacity.
A crossed conversation is not.

Reconnecting to a conversation is therefore something the application prepares
for: it must persist the session capability (and the continuation checkpoint,
to resume the conversation rather than only the session) across the reload. A
client that kept nothing starts a new session.

The consequence is that a lost HTTP response followed by a retry provisions an
orphan session. That is honest and bounded — it retires on its own clock and
counts against capacity meanwhile. If it ever becomes a real cost, the fix is
an explicit client-supplied idempotency key, not a guess at which session was
created most recently.

The request body still accepts `fresh`, which is now redundant and deprecated:
presenting the grant already means create. It remains rejected alongside a
session capability.

## Session lifetime

Sessions are cheap and short-lived on purpose. Losing the session id means
starting a new session, not recovering the old one, so nothing is gained by
keeping an abandoned one alive. Lifetime slides on activity rather than running
from issuance, and three clocks govern it:

| Variable                                     | Default | Retires a session when                                       |
| -------------------------------------------- | ------- | ------------------------------------------------------------ |
| `AGENT_CONNECT_SESSION_IDLE_TIMEOUT_SECONDS` | 900     | no request and no work in progress for this long             |
| `AGENT_CONNECT_PARKED_CALL_TIMEOUT_SECONDS`  | 180     | a published function call goes unanswered for this long      |
| `AGENT_CONNECT_RUNNING_TURN_TIMEOUT_SECONDS` | 1800    | a running turn produces nothing from the agent for this long |

The three are separate because a running turn is legitimately silent for as
long as the agent thinks, while a parked call means the application is supposed
to be executing it _right now_. A parked session and an abandoned tab are
indistinguishable — the segment ended and the gateway holds no socket to the
browser — so this is a declared policy rather than an attempt to detect which
one it is.

`AGENT_CONNECT_CAPABILITY_TTL_SECONDS` (default 3600) is unrelated: it bounds
how long a signed capability verifies, not how long the session lives. A
capability that still verifies but names a retired session is answered
`401 {"error": "session_expired"}`, so a client can tell "start over" from
"refresh your token".

## Session console

`GET /sessions` is an owner-only page — same Tailscale-authenticated,
loopback-only path as `/authorize` and `/v1/grants` — showing live sessions
with their state, turn count, cumulative tokens and cost, last activity, and
when each will be retired, plus recent ended sessions rebuilt from the durable
chain ledger. `POST /sessions` with a `session` field ends one immediately,
which releases its provider session and frees a capacity slot.

Token and cost figures come from the provider's own session snapshot. For an
ended session the final reading is taken just before teardown and kept in
memory only — the provider deletes its record along with the session, and the
gateway's durable ledger does not carry usage — so a restart drops the usage of
already-ended sessions rather than reporting it wrongly.

Applications refused a session at capacity receive `429` with `Retry-After` and
a `manageUrl` pointing here, so they have somewhere to send the user.

Gateway keys, enrolled-device token hashes, grant token hashes, revocation,
and the capability secret are durable. Pending authorization requests, codes,
provider-session mappings, and rate-limit counters are still memory-only. The
gateway accepts application-session creation only through an approved grant,
and it never exposes raw Omnigent session routes.

An experimental VM-local sandbox can be selected with
`AGENT_CONNECT_OMNIGENT_SANDBOX=linux_bwrap` plus the required Codex-home,
host-sentinel, and read-path variables. Read the
[sandbox spike](../../docs/research/2026-07-14-omnigent-vm-sandbox-spike.md)
before using it: the outer boundary passes, but the sandboxed dynamic-tool loop
is currently blocked at MCP startup and the full-access agent can read the
copied Codex login while network is enabled. It is experimental evidence, not
a safe malicious-app profile.
