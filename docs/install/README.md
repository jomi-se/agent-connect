# Install Agent Connect (ACP prerelease)

Version **0.1.0-alpha.1** is an unpublished release candidate. The instructions
below describe the artifact installation path; use locally supplied tarballs
until the owner approves and runs the first release. No checkout, Rust compiler
or personal harness installation is needed. ADR 0016 remains proposed.
ACP, MCP-over-ACP and `agent-connect.resume.v1` are unstable.

The gateway launcher needs Node >=24.15, a running Docker engine and a browser.
Node 24 LTS (>=24.15, <25) remains the repository and provider-validation baseline;
the launcher's broader range does not establish testing of every later major.
Supported hosts: Apple Silicon macOS, Linux x64 and Linux ARM64. Docker Desktop
provides Linux containers on macOS. Windows is not yet supported. Codex is the
first supported login path; live subscription checks remain owner-run.

## Install the gateway

After publication, choose npm:

```sh
npm install --global @open-agent-connect/gateway@0.1.0-alpha.1
agent-connect --help
# Without a global installation:
npx @open-agent-connect/gateway@0.1.0-alpha.1 --help
```

Keep optional dependencies enabled: npm selects a platform binary. Adapters and
harness CLIs are pinned inside the session image, rather than duplicated on the
host. The launcher does not download executables at runtime.

For locally supplied release artifacts, install the launcher and matching
platform tarball together (use `linux-x64` or `darwin-arm64` when appropriate):

```sh
npm install --global ./open-agent-connect-gateway-0.1.0-alpha.1.tgz \
  ./open-agent-connect-gateway-linux-arm64-0.1.0-alpha.1.tgz
agent-connect --help
```

Alternatively download the archive for your host and `SHA256SUMS` from the
[GitHub Release](https://github.com/jomi-se/agent-connect/releases), verify its
checksum, extract it and place `agent-connect` on PATH (the archive also includes `agent-connect-gateway` for compatibility). Artifact names:

| Host          | Archive                                                   |
| ------------- | --------------------------------------------------------- |
| Apple Silicon | `agent-connect-gateway-aarch64-apple-darwin.tar.xz`       |
| Linux x64     | `agent-connect-gateway-x86_64-unknown-linux-musl.tar.xz`  |
| Linux ARM64   | `agent-connect-gateway-aarch64-unknown-linux-musl.tar.xz` |

```sh
# Linux: validates downloaded assets in the current directory.
sha256sum --ignore-missing --check SHA256SUMS
# macOS: shasum -a 256 <archive>; compare with its SHA256SUMS entry.
tar -xf agent-connect-gateway-aarch64-unknown-linux-musl.tar.xz
```

The release also supplies `agent-connect-gateway-installer.sh`. Download it
from the **same versioned release**, verify the checksum, inspect it and run
`sh agent-connect-gateway-installer.sh`. The cargo-dist installer downloads the
matching archive from that release and installs the executable. There is no
PowerShell/Windows installer in this release.

`agent-connect release-info` prints the version and default session
image. Released binaries pin the image by immutable digest; Docker pulls it
when needed. Local candidates use `agent-connect-session:0.1.0-alpha.1`: load
the supplied native Docker image with `docker load --input <image.tar>` or ask
the artifact producer to load it. A multi-architecture OCI archive is build
evidence, not a Docker-load archive.

## Run the sample web app

Download `acp-chat-sample.tgz` and
`open-agent-connect-web-0.1.0-alpha.1.tgz` from that same release. From the
directory containing both:

```sh
tar -xzf acp-chat-sample.tgz
cd package
npm install ../open-agent-connect-web-0.1.0-alpha.1.tgz
npm run dev
```

This builds against the packed SDK, without repository aliases. Open
`http://127.0.0.1:5173`. Keep this terminal running and use another terminal
in the sample directory for gateway setup.

## Initialize owner sign-in

Create a private runtime outside the dedicated harness home:

```sh
runtime_dir="${XDG_STATE_HOME:-$HOME/.local/state}/agent-connect/sample-codex"
mkdir -p "$(dirname "$runtime_dir")"
agent-connect init --directory "$runtime_dir" --harness codex
```

For a remotely hosted gateway, add `--public-url https://gateway.example`.
The URL is a canonical HTTPS origin without a path or trailing slash. With the
default loopback listener, omission selects `http://127.0.0.1:18940`; HTTP is
permitted only for local loopback use.

Setup prompts for a hidden owner passphrase of at least 12 characters and a
confirmation. This authenticates you to the gateway; provider login is a
separate step. Unattended setup requires `--owner-passphrase-file <private-file>`
with an owned regular file, mode 0600 or stricter. Do not put the passphrase in
arguments, environment variables, app code or the harness home.

Setup refuses an existing destination and creates:

| Path under the runtime directory | Purpose                                                                       |
| -------------------------------- | ----------------------------------------------------------------------------- |
| `config.json`                    | Private operator configuration, canonical public URL and boxed harness policy |
| `state/auth/`                    | Owner passphrase hash, optional TOTP secret and application grant state       |
| `state/`                         | Private application-action journals and runtime state                         |

Directories are mode 0700 and files 0600. Normal setup creates no `grant.json`
or `tools.json`: each application requests its tools at the gateway consent
page. Keep the entire runtime private and outside the home mounted into boxes.
Owner authentication state is separate from application bearer credentials.

## One-time Codex login

Run this **one interactive command yourself**:

```sh
agent-connect login
```

It shows the available harnesses. Press Enter to choose Codex, select Claude
Code explicitly, or enter `q` to cancel. It then starts the provider's login
inside the release image: Codex uses unmodified `codex login --device-auth`.
Follow the provider's login instructions. The helper never reads, copies
or logs your credentials. Use this dedicated home, never your existing personal
Codex home. Login and new runtime setup share these defaults:

| Platform                          | Dedicated home per harness                                            |
| --------------------------------- | --------------------------------------------------------------------- |
| Linux                             | `$HOME/.local/state/agent-connect/harnesses/<harness>`                |
| macOS                             | `$HOME/Library/Application Support/agent-connect/harnesses/<harness>` |
| Either, with `XDG_STATE_HOME` set | `$XDG_STATE_HOME/agent-connect/harnesses/<harness>`                   |

The CLI prints the chosen home. `<harness>` is `codex` or `claude`; homes are
private (0700), and a login is shared across that harness's application runtimes.
It is not copied into each runtime. `init` records the selected home in its
private config; production `serve` also uses this default when none is configured.
Existing configs retain their home. For one of those, use
`agent-connect login --config "$runtime_dir/config.json"`; the selector defaults
to its configured harness, and selecting a different harness is refused.
Use `--harness codex` to skip the selector and `--harness-home <absolute-dir>`
to override the home. These overrides are available on login and setup.
The provider's interactive login still needs a terminal.

Every session mounts the whole directory read-write at `/home/node`,
running as your host UID/GID, including when it differs from node UID 1000.
Codex stores file credentials under `codex-home/` inside that dedicated home; Claude configuration uses
`claude-config/`. Credentials and data are intentionally kept together.

## Start egress and serve

```sh
agent-connect egress start
agent-connect serve --config "$runtime_dir/config.json"
```

Egress is a gateway-owned Docker container, with no published host port.
Each session has its own internal network, a temporary workspace, a read-only
image, dropped capabilities and resource limits. Only the selected proxy and
deterministic-test model, when explicitly configured, join that network.
Production sessions require Docker, this proxy and a dedicated home.

Open `http://127.0.0.1:18940/agent-connect/owner` and sign in with the owner
passphrase. Optionally enroll a TOTP authenticator under the owner page's
factor enrollment form. Keep a secure authenticator backup; this alpha has no
recovery-code or remote factor-reset flow. A lost factor requires stopping the
old gateway and initializing a new private runtime, then pairing apps again.
Once enrolled, both sign-in and each approval require
a fresh authenticator code. The owner cookie is HttpOnly and SameSite=Lax,
with Secure required on HTTPS; it is never an application grant. Owner forms
use CSRF protection, and hosted pages forbid framing with CSP and frame headers.

In the sample, enter the gateway origin (`http://127.0.0.1:18940` locally or
`https://gateway.example` remotely), then choose **Connect**. The explicit
browser action opens gateway consent. Sign in if needed, review the exact
application origin, complete tool schemas, requested access duration and native
boxed harness authority, then approve or deny. The sample requests reading a
chapter, highlighting exact text and asking the reader a question. A grant
approves that fixed snapshot; reconnect cannot expand it. Duration choices are
1 hour (the default), 1 day, 7 days or 30 days.

Ask: “Read chapter 1 and highlight its first sentence.” The highlight should
appear in the sample and the chat should explain its result. Stop cancels a
running turn, including an unanswered reader question. After Stop or a terminal
failure, choose **New connection** before sending another message. The sample
retains the transcript and starts a fresh harness session without re-sending
earlier prompts or effects. If capacity remains full during box teardown, wait
a moment and choose **New connection** again.

The default listener is loopback `127.0.0.1:18940`. Remote use requires a single
operator-managed HTTPS origin matching `public_url`: forward `/acp`, all
`/agent-connect/owner` and `/agent-connect/oauth` routes, and the `/.well-known`
metadata routes through the same reverse proxy. For example,
`https://gateway.example` serves owner pages and OAuth, while
`wss://gateway.example/acp` serves the socket. Keep Docker's API and egress
ports private. The package does not configure DNS, TLS or firewall ingress.

## Claude Code and the API-key alternative

Claude Code subscription usage through Agent Connect is **unconfirmed against
Anthropic's terms**. It is not a confirmed alternative to Codex. If the owner
chooses to investigate it, initialize a separate `--harness claude` runtime and
run `login --harness claude --harness-home <dedicated-home>`; this invokes
`claude /login`. `claude setup-token` is a compared variant, not a gateway login
method, and the gateway does not collect that token.

Anthropic's [authentication guidance](https://code.claude.com/docs/en/legal-and-compliance#authentication-and-credential-use)
describes API-key authentication as the product integration alternative,
with API billing. This gateway does **not** forward `ANTHROPIC_API_KEY` or other
API-key variables into boxes. Use a separate application-server Claude API
integration if API authentication is required; never put an API key in this
browser sample. See the [credential/terms analysis](../plan/acp-gateway-credentials.md).

## Reconnect and recovery

Brief socket loss or Page Lifecycle suspension reattaches to the same resumable
transport while its grace period and retained-output budget permit it. A lost
attachment is distinct from a new harness session. After expiry, the SDK may
load the owned session's history; it reports an interrupted turn and never
automatically re-sends the prompt or an uncertain application-tool result.
Authorization failures and attachment takeover do not trigger recovery.
Access tokens last five minutes; the SDK rotates refresh tokens and briefly
detaches/reconnects while retaining the same grant and session ownership.
It never replays a prompt to renew authorization. Refresh-token reuse revokes
the grant; uncertain refresh results require explicit recovery rather than retry.
The default pairing mode never opens another consent popup.

A gateway restart loses process-local ownership/resume handles. Saved transcripts
in the shared home do not create a general cross-restart conversation API.
Reconnect deliberately, then send a new user message. Managed grants default to
`sessionStorage`, scoped to gateway origin, application origin and tool snapshot.
A page reload can reuse that grant within the same tab; this does not restore a
harness conversation automatically. An actual browser back/forward-cache
restoration retains the chat and pending app question; the application must
preserve them on `pagehide.persisted`. This is
conditional on browser caching, not a promise that every Back navigation resumes.

## Upgrade, revoke and uninstall

Stop the gateway and active turns before upgrading. Install the matching gateway
and SDK version, read its changelog, and use `release-info`/`release.json` to
update `session_image` in the private config. Recreate the egress container with
that image (`egress stop`, then `egress start`). Keep the private dedicated home;
do not copy its credential files between boxes or into a repository. Existing
interrupted turns must not be replayed during an upgrade.

To revoke an application grant, open `/agent-connect/owner` on the gateway,
sign in and choose **Revoke access** for that application. No restart is needed.
Revocation ends active and detached authority within one second, and the gateway
checks authorization before forwarding each frame; completed effects cannot be
undone. The application must explicitly Connect again for new consent. Gateway
policy changes invalidate grants through the policy fingerprint.

To revoke the harness login, use the provider's account controls for **that dedicated login**.
Do not log out or change your personal harness session.

To uninstall: stop the gateway; run `agent-connect egress stop`; uninstall
`@open-agent-connect/gateway` globally, or remove both archive-installed executables (`agent-connect` and its compatibility command).
The helper only removes containers bearing its egress ownership label. Private
homes and journals are left for the owner to retain or delete after revoking the
dedicated login. Do not prune unrelated Docker resources.

## Explicit headless static bearer mode

For an intentionally headless integration, `init --headless-static-bearer`
requires `--allow-origin <exact-origin>` and `--tools <snapshot.json>`. It creates
a static bearer in private config and a `grant.json` for the application. Serve
also requires `--headless-static-bearer` (or that explicit config setting), the
exact origin, tool snapshot and token. This mode hosts no owner or OAuth pages
and has no managed refresh or individual hosted revocation. Treat grant files as
secrets. It is disabled by default; use hosted consent for normal installation.

Existing manual-bearer configs must explicitly opt into this headless mode or
initialize a new owner runtime. There is no automatic grant migration.

## Troubleshooting and accepted risks

- `docker info` must work for the invoking user. Keep the same user for init,
  login and serve; ownership/mode errors require fixing that dedicated runtime,
  not changing personal credential permissions.
- An unpublished package/image is not an authentication failure. Use the local
  tarballs/native image, or wait for the first approved release.
- Close 4401 means an invalid or expired application grant; revoked grants need
  a new explicit Connect action. Close 4403 means an origin mismatch. Match
  `http://127.0.0.1:5173` exactly; `localhost` is a different origin.
- Close 4409 means another attachment owns the session; 4418 means capacity;
  4500 means a harness/container launch failed. See
  [configuration and error reference](configuration.md) for all codes.
- A boxed session retains its capacity slot until its container and private
  network are removed. Cleanup retries are bounded; if Docker cleanup fails,
  that slot stays reserved for this gateway process. Inspect the cleanup error
  and the resources' `org.agent-connect.component=acp-session` and
  `org.agent-connect.session` labels before removing only that session's
  immutable IDs. Shared egress/model peers must stay running. Stop active turns
  before restarting; restart loses resume ownership and does not itself clean
  resources left by an earlier process. Allow at least 30 seconds for graceful
  shutdown while allocation is in progress; SIGKILL or daemon outages can leave
  resources requiring operator inspection. Never use a broad Docker prune.
- Missing platform binary: reinstall with optional dependencies enabled or
  install its platform tarball alongside the launcher.
- `RUST_LOG=info` enables diagnostics. Inspect Docker errors and proxy denials;
  do not paste grants, login files or credential-bearing logs into issues.

The shared home intentionally includes credentials, configuration and all app
transcripts. A consented application's prompt could induce the harness to read
the dedicated credential and send it through an allowed app tool. The egress
proxy cannot prevent that. Sessions can also read other apps' transcripts or
alter shared configuration. Use only trusted/consented apps and a separately
revocable login. This is the [accepted credential risk](../plan/acp-gateway-credentials.md),
not a promise of credential isolation. Application effects require idempotency
or action-ID deduplication; cancellation cannot undo a completed effect.

The [previous OpenClaw installation](../../deploy/openclaw-gateway/README.md)
and npm package remain available. Their grants and histories do not migrate
automatically. See [release operator instructions](release.md) for the first
approved publication and local artifact validation.
