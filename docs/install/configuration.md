# Gateway configuration reference (unstable ACP)

Start with `agent-connect setup`, then `agent-connect doctor` and the owner
console. This reference covers explicit configuration and advanced operation.
`agent-connect --help` lists setup, diagnosis, service lifecycle, owner recovery,
`init`, `login`, `egress`, `serve` and `release-info`.
`serve --help` lists all flags. `agent-connect-gateway` remains a compatibility
alias in npm and the release archives. `agent-connect login` prompts for a
harness and uses a dedicated platform-default home; `--harness` skips selection,
`--harness-home` overrides the home, and `--config` honors an existing runtime's
home/image. `XDG_STATE_HOME` overrides the platform state root and must be absolute.
Without a terminal, omitted `--harness` is a usage error, never a silent choice.
The [install guide](README.md#2-run-guided-setup) explains dedicated login.
Release builds use the matching
session image by digest; `release-info` reports its compiled default.

Default private runtime: Linux uses
`$HOME/.local/state/agent-connect/runtime`; macOS uses
`$HOME/Library/Application Support/agent-connect/runtime`. Dedicated per-harness
homes use the same platform root with `harnesses/<harness>` instead of `runtime`.
`XDG_STATE_HOME` overrides the platform state root on either system. Setup prints
its selected location. Existing config homes retain precedence for login and
serve; they are not relocated automatically.

`setup --json` previews a plan. `--apply --non-interactive` applies it with no
provider login; new owner initialization requires a protected
`--owner-passphrase-file`. Guided setup confirms application, offers provider
login and installs/starts the user service. `--no-service` uses another supervisor.
Existing config and owner state are preserved; conflicting requested changes
are rejected. Explicit `setup --upgrade` updates the configured session image
to the installed release default, preserves private authentication/journals and
login homes, and updates the owned service executable even when the image is
unchanged. Owned egress is recreated when needed. Changed image or harness
policy invalidates existing grants; apps must pair again. Service operations accept `--config` and optional
`--manager systemd|launchd` before `install|uninstall|start|stop|status|logs`.
`install --offline` generates a definition without contacting/enabling the
manager; `logs --lines <1..1000>` returns bounded recent output.
`uninstall --offline` removes only the owned definition without contacting its
manager; stop any running service first.
One managed service identity is available per operating-system account. A service
owned by a different runtime is not replaced; multiple configured entry points
can share the existing gateway.

New setup accepts repeatable `--entry-point <origin>` and `--profile <profile>`
plus `--permissions <default-profile>`; these choices persist in its config.
The default profile must be offered. Existing setup reruns require matching
profile/entry-point choices, and upgrade changes the image only. In contrast,
serve flags override configuration for that process without persisting edits.

`serve --config config.json` reads a JSON object with snake_case keys below.
Paths in the file resolve against its directory. Config must be an owned regular
file, mode 0600 or stricter, at most 1 MiB; symlinks and unknown fields are rejected.
The containing runtime should be private. Precedence is **CLI, environment,
config, defaults**. Each key supports `AGENT_CONNECT_<UPPER_SNAKE_KEY>`;
`AGENT_CONNECT_CONFIG` selects the file. CLI booleans accept `--boxed` or
`--boxed=false`. Never place real tokens in shell history or checked-in examples.

| JSON key / flag                                       | Meaning / default                                                                                                    |
| ----------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| `harness` / `--harness`                               | Required `codex` or `claude`                                                                                         |
| `listen` / `--listen`                                 | `127.0.0.1:18940`                                                                                                    |
| `public_url` / `--public-url`                         | Required canonical external HTTPS origin for hosted owner/OAuth pages and `/acp`; HTTP loopback is permitted locally |
| `entry_points` / `--entry-point`                      | Additional configured gateway origins; pairing and issuer are bound to the selected entry point                      |
| `headless_static_bearer` / `--headless-static-bearer` | Default false; explicit headless compatibility mode without owner/OAuth pages                                        |
| `allow_origin` / `--allow-origin`                     | Headless mode only: required exact HTTP(S) browser origin, no path/trailing slash                                    |
| `token` / `--token`                                   | Headless mode only: required static application bearer; prefer private config                                        |
| `tools` / `--tools`                                   | Headless mode only: required fixed snapshot JSON array of tool names and schemas                                     |
| `harness_home` / `--harness-home`                     | Dedicated whole-home read-write bind mount; defaults to the per-harness Agent Connect home                           |
| `session_image` / `--session-image`                   | Matching release digest; local builds use a versioned local tag                                                      |
| `egress_container` / `--egress-container`             | Required operator-selected proxy; setup uses `agent-connect-egress`                                                  |
| `boxed` / `--boxed`                                   | Required true in production; set true by setup                                                                       |
| `permissions` / `--permissions`                       | Default profile; `sandboxed`, `read-only`, `app-tools-only` or `deny-all`, subject to harness limits                 |
| `profiles` / `--profile`                              | Owner-consent choices; must include the default `permissions`; repeat the flag for each profile                      |
| `codex_mode` / `--codex-mode`                         | Operator mode; boxed default `agent-full-access`, host fixture `workspace-write`                                     |
| `state_dir` / `--state-dir`                           | Private action journals and `auth/` owner/grant state; default `.agent-connect/gateway`; keep outside harness home   |
| `max_sessions` / `--max-sessions`                     | Positive capacity, default 32                                                                                        |
| `resume_grace_secs` / `--resume-grace-secs`           | Detached session grace, default 600 seconds                                                                          |
| `resume_max_bytes` / `--resume-max-bytes`             | Unacknowledged output budget, default 8388608 bytes                                                                  |
| `mock_root` / `--mock-root`                           | Isolated deterministic fixture root; never a production host-mode switch                                             |
| `mock_url` / `--mock-url`                             | Fixture model URL, default `http://127.0.0.1:18931/v1`                                                               |
| `mock_container` / `--mock-container`                 | Fixture model container; requires `mock_root`                                                                        |
| `durable_home` / `--durable-home`                     | Legacy deterministic-fixture named-volume option; use dedicated home for production                                  |

Normal config contains `public_url` and operator policy, without `token`,
`allow_origin` or `tools`. `init` prompts for a hidden owner passphrase and
confirmation, or accepts `--owner-passphrase-file <private-file>` for unattended
setup. Setup and init read an owned regular file, mode 0600 or stricter;
the gateway persists an Argon2 passphrase hash, never the plaintext passphrase.
`init` defaults `public_url` to its loopback listener URL; remote listeners need
an explicit canonical HTTPS origin. Normal `serve` requires the initialized
private authorization state under `state_dir/auth` (`authorization.json` plus
a singleton lock).

`public_url` has no path, query, fragment or trailing slash. A reverse proxy must
forward owner pages, OAuth, metadata and `/acp` under this same origin. Changing
the issuer URL requires a new owner runtime. Additional `entry_points` allow up
to sixteen canonical HTTPS origins or HTTP loopback origins with unique
host-and-port combinations. Each origin must route to this same gateway and
preserve its public Host header. Applications pair with the exact entry point
they will use; sign-in, consent, issuer and grant remain bound to that origin.
The owner console lists all configured entry points. Changes to the selected harness,
image, permissions and other fingerprinted operator policy invalidate grants.
Applications choose their exact origin and fixed tool snapshot at owner consent;
they cannot change native harness policy. Old bearer configs require explicit
`headless_static_bearer: true` or reinitialization for hosted pairing.

The hosted routes are:

| Route                                                        | Purpose                                                                                        |
| ------------------------------------------------------------ | ---------------------------------------------------------------------------------------------- |
| `/healthz`                                                   | Credential-free runtime health                                                                 |
| `/agent-connect/owner`                                       | Owner sign-in, grant list and revocation controls                                              |
| `/agent-connect/owner/login`, `/agent-connect/owner/logout`  | Owner session authentication                                                                   |
| `/agent-connect/owner/totp`                                  | Optional authenticator enrollment; enrollment then requires fresh TOTP at sign-in and approval |
| `/agent-connect/owner/grants/revoke`                         | Owner revocation of an individual grant                                                        |
| `/agent-connect/oauth/par`, `/agent-connect/oauth/authorize` | Pushed authorization request and owner consent                                                 |
| `/agent-connect/oauth/token`, `/agent-connect/oauth/revoke`  | PKCE code exchange, rotating refresh and application revocation                                |
| `/.well-known/oauth-authorization-server/agent-connect`      | Authorization-server metadata                                                                  |
| `/.well-known/oauth-protected-resource/acp`                  | Protected ACP resource metadata                                                                |
| `/acp`                                                       | Grant-authorized ACP WebSocket                                                                 |

Authorization requests expire after ten minutes; single-use authorization codes
after two minutes. Access tokens last at most five minutes. Owner consent offers
1 hour (default), 1 day, 7 days or 30 days, bounding the grant and its refresh
chain. Refresh-token reuse revokes the grant. Owner revocation affects active
and detached sessions within one second; authorization is checked before each
frame is forwarded. Grant ID and tool snapshot remain fixed across token rotation.
Owner cookies are distinct from app credentials, HttpOnly, SameSite=Lax and
Secure on HTTPS. Owner forms enforce CSRF and pages prohibit framing.
Owner secrets and authorization state are never mounted into harness boxes.

The default available profiles are `sandboxed` and `read-only` for Codex, and
`sandboxed`, `app-tools-only` and `deny-all` for Claude. Explicit `profiles` must
include the configured default `permissions`, contain no duplicates and use
profiles the selected harness supports. The owner chooses an available profile
at consent; it is stored with the grant and remains fixed across refresh and
reconnect. The browser cannot change native authority independently of consent.

`sandboxed` approves permission requests within the container boundary; it does
not enable a separate nested Codex sandbox. Codex `read-only` forces its native
read-only launch mode and permits permission prompts only for exact approved
application-tool names; native and unapproved prompts are denied. Native reads
and approved application-tool effects remain possible. Boxed Codex rejects
`deny-all` and `app-tools-only`, because native operations can bypass ACP
permission requests. `codex_mode` accepts only `read-only`, `workspace-write` or
`agent-full-access`. Claude `app-tools-only` rejects native ACP permission
requests and `deny-all` rejects every ACP permission request; these profiles do
not guarantee denial of actions performed without permission requests. Docker
remains the execution boundary. The gateway supplies cwd/mode/model policy, and
a fixed approved tool snapshot cannot expand on reconnect.

Codex read-only native operations require its nested sandbox to start. A Docker
host that prohibits the required namespace can reject native commands with
`bwrap: No permissions to create a new namespace`; those commands fail closed,
while approved application tools remain available. Do not relax container
security to bypass this error. Local acceptance observes this namespace refusal
and absence of a filesystem effect; it does not independently qualify the
native filesystem policy on a namespace-capable host.

`RUST_LOG` controls diagnostics. `AGENT_CONNECT_GATEWAY_BIN` overrides the npm
launcher's executable for local testing. Image selection is also available to
init/login/egress as `AGENT_CONNECT_SESSION_IMAGE`; egress name as
`AGENT_CONNECT_EGRESS_CONTAINER`. No API-key environment is forwarded to boxes.

Process exit codes: 0 successful completion/help; 1 runtime/I/O/Docker/login
failure; 2 invalid arguments/configuration/snapshot or unsupported npm platform.
SIGINT/SIGTERM stop the server and its session hosts.

| WebSocket close  | Typed SDK code           | Action                                                                         |
| ---------------- | ------------------------ | ------------------------------------------------------------------------------ |
| 4401             | `invalid_app_grant`      | Explicitly Connect for new consent if revoked/expired; never auto-open pairing |
| 4403             | `authorization_denied`   | Match the approved origin                                                      |
| 4404, 4410, 4413 | `session_expired`        | Load owned history if available; do not re-send uncertain turns                |
| 4409, 4415       | `session_superseded`     | Another attachment owns this session                                           |
| 4414             | `invalid_app_grant`      | Explicit Connect after owner revocation or grant lifetime expiry               |
| 1009             | `frame_too_large`        | Reduce the serialized message; terminal, never retry                           |
| 4418             | `session_capacity`       | Wait for capacity or change the operator limit                                 |
| 4500             | `agent_execution_failed` | Inspect isolated harness/container launch diagnostics                          |

Turn recovery can return `task_interrupted`. Tools whose outcome is uncertain
must not be automatically repeated. See the SDK's
[ACP README](../../packages/web-sdk/README.md) for the complete API/error contract.

Client messages have a **1 MiB UTF-8 serialized frame limit**, including resume
framing and tool results. The SDK rejects oversized results before sending;
the gateway closes raw oversized messages with terminal code 1009. A superseded
session closes with 4415 and never triggers session/load automatically. Startup
attachment has a 30-second SDK deadline; hosts that never receive a valid live
client message are cleaned up rather than retained for the reconnect grace.
Shutdown joins hosts concurrently under one ten-second deadline, with a
twenty-second overall session-task drain bound including allocation and cleanup.

Before listening, boxed `serve` checks Docker, the selected image and the owned,
running egress proxy. `egress start` safely reuses a matching proxy or restarts a
stopped one; incompatible proxies require explicit stop/recreate. The proxy uses
`unless-stopped` restart policy and rotated JSON logs (10 MiB × 3). Defaults are
64 sockets per session source and 512 total, 60-second idle, five-minute request
and one-hour absolute connection limits. Invalid limit overrides fail startup;
see `EGRESS_MAX_CONNECTIONS_PER_CLIENT`, `EGRESS_MAX_CONNECTIONS`,
`EGRESS_IDLE_TIMEOUT_MS`, `EGRESS_REQUEST_TIMEOUT_MS` and
`EGRESS_ABSOLUTE_TIMEOUT_MS` in the image proxy implementation.

Action records contain delivery/completion metadata, never tool arguments or
results. Completed records expire after 24 hours with a 1024-record cap;
uncertain records remain until resolved, and at 1024 unresolved records new
delivery fails closed. Records never authorize automatic effect replay. Recent
session ownership expires after 24 hours of inactivity and is limited to 256
sessions per grant. Expired/revoked grants are removed from process ownership.

Owner login attempts are bounded by the actual socket peer, not client-supplied
forwarding headers. A reverse proxy makes clients share its peer budget; rate
limit public ingress as well and investigate the proxy's shared budget when
legitimate owner sign-in is throttled. Application grant expiry/rotation does
not create owner sign-in authority. Optional TOTP has replay protection: login
and approval require distinct fresh codes, which can require waiting for the
next authenticator interval.

Use distinct hostnames for the gateway owner surface and third-party application
servers. Browser cookies are not isolated by port: two ports on one hostname do
not provide separate owner-cookie trust boundaries. The local sample's loopback
servers are operator-controlled; production examples use `gateway.example` and
`app.example` as separate hosts.

## HTTPS reverse proxy

Run the gateway on its default loopback listener and expose a canonical HTTPS
origin with your existing reverse proxy. These reserved-domain examples assume
setup used `--origin https://gateway.example`. Forward every route to the same
gateway: owner pages, OAuth, metadata, `/healthz` and the `/acp` WebSocket. DNS,
certificate issuance and public ingress remain operator responsibilities.

Caddy handles WebSocket upgrades automatically:

```caddyfile
gateway.example {
    reverse_proxy 127.0.0.1:18940
}
```

For nginx, put the map in its `http` context and configure your certificate
paths for the HTTPS server:

```nginx
map $http_upgrade $connection_upgrade {
    default upgrade;
    ''      close;
}

server {
    listen 443 ssl;
    server_name gateway.example;
    ssl_certificate /etc/ssl/example/fullchain.pem;
    ssl_certificate_key /etc/ssl/example/private-key.pem;

    location / {
        proxy_pass http://127.0.0.1:18940;
        proxy_http_version 1.1;
        proxy_set_header Host $http_host;
        proxy_set_header Origin $http_origin;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection $connection_upgrade;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_read_timeout 1h;
        proxy_send_timeout 1h;
    }
}
```

Preserve the browser's `Origin` and `Sec-WebSocket-Protocol` headers; do not
rewrite them to the gateway origin. WebSocket subprotocols carry app-specific
authorization, and the proxy must forward them unchanged. Never inject a bearer
credential or owner cookie in proxy configuration. Do not publish Docker's API
or egress ports. The gateway uses the actual socket peer for owner login budgets;
apply suitable public ingress rate limiting without blocking long-lived sockets.

For additional entry points, terminate HTTPS for each configured origin and
route it to the same listener while preserving the public Host header. Pair each
app with the exact gateway origin it will use; metadata, consent and tokens stay
bound to that entry point. Additional hostnames have distinct owner cookies and
do not import an existing browser sign-in. Cross-entry-point owner POSTs are
rejected even when both origins are configured.
