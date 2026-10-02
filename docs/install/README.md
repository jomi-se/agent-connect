# Install Agent Connect (ACP prerelease)

Version **0.1.0-alpha.1** is an unpublished release candidate. The instructions
below describe the artifact installation path; use locally supplied tarballs
until the owner approves and runs the first release. No checkout, Rust compiler
or personal harness installation is needed. ADR 0016 remains proposed.
ACP, MCP-over-ACP and `agent-connect.resume.v1` are unstable.

You need Node 24 LTS (>=24.15, <25), a running Docker engine and a browser.
Supported hosts: Apple Silicon macOS, Linux x64 and Linux ARM64. Docker Desktop
provides Linux containers on macOS. Windows is not yet supported. Codex is the
first supported login path; live subscription checks remain owner-run.

## Install the gateway

After publication, choose npm:

```sh
npm install --global @open-agent-connect/gateway@0.1.0-alpha.1
agent-connect-gateway --help
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
agent-connect-gateway --help
```

Alternatively download the archive for your host and `SHA256SUMS` from the
[GitHub Release](https://github.com/jomi-se/agent-connect/releases), verify its
checksum, extract it and place `agent-connect-gateway` on PATH. Artifact names:

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

`agent-connect-gateway release-info` prints the version and default session
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

## Approve the app and initialize the gateway

Read the sample's `tools.json`: it permits reading one chapter, highlighting
exact text and asking the reader a question. Review the schemas and effects
before giving this application access to your dedicated harness login.

```sh
runtime_dir="${XDG_STATE_HOME:-$HOME/.local/state}/agent-connect/sample-codex"
mkdir -p "$(dirname "$runtime_dir")"
agent-connect-gateway init --directory "$runtime_dir" --harness codex \
  --allow-origin http://127.0.0.1:5173 --tools ./tools.json
```

Setup refuses an existing destination and creates:

| Path under the runtime directory | Purpose                                                       |
| -------------------------------- | ------------------------------------------------------------- |
| `config.json`                    | Private operator config including the bearer and exact origin |
| `grant.json`                     | Application capability: `{gatewayUrl, token}`                 |
| `tools.json`                     | The approved, fixed tool snapshot                             |
| `home/`                          | Shared credentials, harness configuration and transcripts     |
| `state/`                         | Private application-action journal/runtime state              |

Directories are mode 0700 and files 0600. There is one operator-issued bearer
for one exact browser origin and snapshot per gateway instance. Setup is the
current grant issuance mechanism: there is **no OAuth pairing service, consent
portal or refresh-token API** on this ACP path. The operator reviews the tool
file and hands `grant.json` to that application. Do not commit or publicly serve
the grant or runtime directory. The sample reads an uploaded grant into memory;
it does not put the token in a URL or browser storage.

## One-time Codex login

Run this **one interactive command yourself**:

```sh
agent-connect-gateway login --harness codex --harness-home "$runtime_dir/home"
```

It starts the unmodified `codex login --device-auth` inside the release image.
Follow the provider's device-login instructions. The helper never reads, copies
or logs your credentials. Use this dedicated home, never your existing personal
Codex home. Every session mounts the whole directory read-write at `/home/node`,
running as your host UID/GID, including when it differs from node UID 1000.
Codex stores file credentials under `home/codex-home/`; Claude configuration uses
`home/claude-config/`. Credentials and data are intentionally kept together.

## Start egress and serve

```sh
agent-connect-gateway egress start
agent-connect-gateway serve --config "$runtime_dir/config.json"
```

Egress is a gateway-owned Docker container, with no published host port.
Each session has its own internal network, a temporary workspace, a read-only
image, dropped capabilities and resource limits. Only the selected proxy and
deterministic-test model, when explicitly configured, join that network.
Production sessions require Docker, this proxy and a dedicated home.

In the browser upload `grant.json`, review/confirm the tool consent checkbox,
then connect. Ask: “Read chapter 1 and highlight its first sentence.” The
highlight should appear in the sample and the chat should explain its result.
Stop cancels a running turn, including an unanswered reader question.

The default listener is loopback `127.0.0.1:18940`. For a remotely hosted app,
use HTTPS/WSS through an operator-managed reverse proxy, an exact approved
`https://app.example` origin and a `wss://gateway.example/acp` application URL.
Keep Docker's API and egress ports private. Configuring a public ingress is an
operator task; the package does not open firewall ports or configure DNS/TLS.

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

A gateway restart loses process-local ownership/resume handles. Saved transcripts
in the shared home do not create a general cross-restart conversation API.
Reconnect deliberately, then send a new user message. The sample keeps its grant
only in memory, so a page reload requires uploading it again.

## Upgrade, revoke and uninstall

Stop the gateway and active turns before upgrading. Install the matching gateway
and SDK version, read its changelog, and use `release-info`/`release.json` to
update `session_image` in the private config. Recreate the egress container with
that image (`egress stop`, then `egress start`). Keep the private dedicated home;
do not copy its credential files between boxes or into a repository. Existing
interrupted turns must not be replayed during an upgrade.

To revoke the application grant, stop this gateway and replace its bearer with a
fresh operator-issued grant, then restart; this ends attached sessions. To revoke
the harness login, use the provider's account controls for **that dedicated login**.
Do not log out or change your personal harness session.

To uninstall: stop the gateway; run `agent-connect-gateway egress stop`; uninstall
`@open-agent-connect/gateway` globally, or remove the archive-installed binary.
The helper only removes containers bearing its egress ownership label. Private
homes and journals are left for the owner to retain or delete after revoking the
dedicated login. Do not prune unrelated Docker resources.

## Troubleshooting and accepted risks

- `docker info` must work for the invoking user. Keep the same user for init,
  login and serve; ownership/mode errors require fixing that dedicated runtime,
  not changing personal credential permissions.
- An unpublished package/image is not an authentication failure. Use the local
  tarballs/native image, or wait for the first approved release.
- Close 4401 means an invalid bearer; 4403 means an origin mismatch. Match
  `http://127.0.0.1:5173` exactly; `localhost` is a different origin.
- Close 4409 means another attachment owns the session; 4418 means capacity;
  4500 means a harness/container launch failed. See
  [configuration and error reference](configuration.md) for all codes.
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
