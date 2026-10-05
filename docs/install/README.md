# Install Agent Connect (ACP prerelease)

Install your gateway, run guided setup, and approve an application's exact
origin and tools in your browser. **This is an early alpha
release.**
[ADR 0016](../decisions/0016-acp-application-boundary.md) was accepted on
2026-10-04. ACP, MCP-over-ACP and `agent-connect.resume.v1` remain unstable.

## 1. Install

You need Node >=24.15, Docker that your user can run without `sudo`, a browser
and a Codex or Claude Code subscription. The tested baseline is Node 24 LTS
(>=24.15, <25) with Docker Desktop or Docker Engine and its buildx plugin. Setup
builds the box locally, so first setup downloads and stores roughly 1.5 GB.
Supported hosts are Apple Silicon macOS, Linux x64 and Linux ARM64. On macOS,
use Docker Desktop with Linux containers. Windows is not yet supported. No
checkout, Rust compiler or personal harness installation is needed.

After publication:

```sh
npm install --global @open-agent-connect/gateway
agent-connect --help
```

For a locally built candidate, install the launcher and matching platform tarball
together; substitute `linux-x64` or `darwin-arm64` for your host:

```sh
npm install --global ./open-agent-connect-gateway-<version>.tgz \
  ./open-agent-connect-gateway-linux-arm64-<version>.tgz
```

Keep npm optional dependencies enabled: they select the native platform binary.
The launcher does not download executables at runtime. Adapters and harness CLIs
are pinned in the locally built Docker box.

`agent-connect release-info` reports the installed version. Setup builds the box
locally from files shipped in the npm installation; no prebuilt registry box is
required. Native archives and checksums are release build artifacts.

## 2. Run guided setup

For local use:

```sh
agent-connect setup
```

Setup announces a local Docker build for your architecture (roughly 1 GB before
owner additions). Docker downloads the pinned Node base, locked adapters and OS
tools during this explicit build. Later setup runs reuse the versioned box.
See [owner box tools](configuration.md#owner-box-tools) to bake in extra tools.

For a gateway behind your HTTPS reverse proxy:

```sh
agent-connect setup --origin https://gateway.example
```

For additional routed gateway origins or a smaller consent-profile menu, supply
the choices during first setup; they are saved for the managed service:

```sh
agent-connect setup --origin https://gateway.example \
  --entry-point https://gateway.example.test \
  --profile sandboxed --profile read-only
```

`--permissions read-only` selects the default Codex profile. Every offered menu
must include its default. Setup reruns preserve these choices and reject
incompatible changes instead of silently expanding application authority.

The default origin is `http://127.0.0.1:18940`. Setup creates private owner
configuration, builds the local box and checks owned Docker egress, and installs and starts
the user service. It prompts for a hidden owner passphrase of at least 12 characters and
confirmation. This passphrase signs you in to Agent Connect; provider login is
separate. Use `--harness codex` to select Codex explicitly.

Run `agent-connect login` yourself to authenticate the dedicated harness home.
The interactive selector defaults to Codex, whose box runs unmodified
`codex login --device-auth`. Guided setup asks whether to run this interactive
step; `--login` requests it explicitly. Neither command imports personal harness
credentials. Read the
[shared-home credential risks](../plan/credentials.md) before login,
and [Claude Code](#claude-code) before selecting Claude.

Setup prints the runtime location and next actions. Rerun it to continue an
interrupted setup. Existing runtime configuration and owner state are preserved;
conflicting requested values fail rather than silently changing your runtime.
Use `--directory <private-runtime>` to select a different runtime,
`login --config <config>` to honor its dedicated home, or `--no-service` when
another supervisor will run it. Setup does not configure DNS, TLS or firewall
ingress. Remote access needs your own
[HTTPS reverse proxy](configuration.md#https-reverse-proxy).

Owner state, grants and action journals remain outside the dedicated harness
home. Private directories use mode 0700 and files 0600. Normal setup creates no
bearer or tool-snapshot handoff file: applications request browser consent.

### Automated setup

Preview the plan without making changes:

```sh
agent-connect setup --origin https://gateway.example --json
```

Explicit unattended application uses `--apply --non-interactive` and
`--owner-passphrase-file <private-file>`. The file must be an owned regular file
with mode 0600 or stricter. Keep it outside the harness home and remove it when
provisioning no longer needs it. Never put the passphrase in CLI arguments,
environment variables or app code. Automation never performs provider login;
the owner runs `agent-connect login --config <config> --harness codex` separately.
Use `setup --help` for the complete option list.

```sh
agent-connect setup --origin https://gateway.example --apply --non-interactive \
  --owner-passphrase-file /path/to/private-passphrase
```

## 3. Connect an application

Open `http://127.0.0.1:18940/agent-connect/owner`, or
`https://gateway.example/agent-connect/owner` remotely. Sign in with the owner
passphrase. Activity shows runtime health, pending requests, live sessions and grant history.
Security manages the authenticator and revoking all app access; Gateway lists
configured entry points, the harness and native access profiles. Connect apps through a configured entry point. Optional TOTP
setup confirms your passphrase, then shows a QR code and an authenticator link.
Click **Enter the key by hand** to copy the setup key and reveal it for manual entry.
Verification returns to Security; sign-in and each approval then need a fresh code.

In your app, enter the gateway origin and choose **Connect**. Review the exact
application origin, complete tool schemas, available restricted profile, native
harness authority and access duration before approving. Duration choices are
one hour (default), one day, seven days or thirty days. The approved tool snapshot
cannot expand on reconnect. Profile availability depends on the harness; the
Gateway page describes the native authority that remains.

To try the sample, obtain `acp-chat-sample.tgz` and
`open-agent-connect-web-0.0.10.tgz` from the matching release or artifact
producer:

```sh
tar -xzf acp-chat-sample.tgz
cd package
npm install ../open-agent-connect-web-0.0.10.tgz
npm run dev
```

Open `http://127.0.0.1:5173`, enter the gateway origin and choose **Connect**.
Ask “Read chapter 1 and highlight its first sentence.” The highlight and chat
reply verify a model turn and an approved application tool.

## 4. Verify and diagnose

```sh
agent-connect doctor
agent-connect service status
```

Doctor reports actionable checks and stable problem codes;
`agent-connect doctor --json` supports automation. `/healthz` supplies HTTP
health without credentials, and the owner console offers additional repair
guidance. Health success does not prove provider authentication or a model turn.

Start with [troubleshooting](troubleshooting.md), doctor and
`agent-connect service logs`. No manual state-file inspection is needed for
normal diagnosis. Keep bearer credentials, cookies and login data out of issues.

## Operate the gateway

Services use user systemd on Linux and launchd on macOS:

```sh
agent-connect service install
agent-connect service start
agent-connect service status
agent-connect service logs --lines 100
agent-connect service stop
agent-connect service uninstall
```

Use `service --config <config> <operation>` for another runtime. Use the same
operating-system account for setup, login and service operation. Service install
does not require root, and uninstall preserves private runtime and harness data.
The managed user service has one identity per account; additional entry points
share that gateway. It refuses to replace a service owned by another runtime.
For foreground operation, `serve --config <config>` remains available; avoid
running it alongside the service on the same listener.

Activity can end a live session without revoking its grant and revoke an individual
grant. Security can revoke all grants. Sign out ends the owner browser session. Revocation affects active and
detached authority within one second; completed effects cannot be undone. A
revoked app must explicitly Connect for new consent.

Brief socket loss may resume the same session within its grace and output
budget. Expired sessions and gateway restarts require deliberate recovery. The
sample retains its transcript and reports interruption without automatically
replaying prompts or uncertain effects. Provider transcripts do not create a
general restoration API. See the [SDK recovery contract](../../packages/web-sdk/README.md).

Lost authenticator access has a local owner-run
[`reset-totp` recovery](troubleshooting.md#lost-authenticator). Stop the gateway
before recovery; provider authentication is separate.

## Upgrade or uninstall

Stop active turns and the service, read the target release's changelog, then
install its matching gateway version. Retain the private runtime, owner state,
action journals and dedicated harness home:

```sh
agent-connect service stop
# Install the target gateway version using the same artifact method as before.
agent-connect setup --upgrade
agent-connect doctor
```

Use `--directory <private-runtime>` when upgrading a non-default runtime, and its
config for service/doctor commands. Upgrade uses the new installed release's
box, updates the owned service executable even when its image is
unchanged, recreates owned egress when needed, and preserves owner
passphrase, TOTP, grant records, journals and login homes. Image or harness-policy
changes invalidate existing application authority: pair affected apps again.
Retaining a grant record does not keep it valid under a changed policy. Never
replay interrupted turns or initialize over existing state.

To uninstall, stop and uninstall the service, stop its owned egress with
`agent-connect egress stop`, then uninstall the npm package or remove the
archive-installed executable. These operations preserve private data. Revoke
the dedicated provider login in the provider's account controls before choosing
to delete it; leave personal logins alone. Never prune unrelated Docker resources.

## Claude Code

Claude Code subscription use remains **unconfirmed against Anthropic's terms**.
It is not a confirmed substitute for Codex. An owner who chooses to investigate
it must use a separate Claude runtime and dedicated login; the helper invokes
`claude /login`. `claude setup-token` is not a gateway login method. See the
[credential and terms analysis](../plan/credentials.md).

API-key authentication belongs in a separate application-server integration with
API billing. The gateway does not forward `ANTHROPIC_API_KEY` or other API-key
variables into boxes. Never put API keys into a browser application.

## Security boundaries and advanced configuration

Docker isolates execution and the owned egress proxy constrains destinations.
The shared harness home intentionally includes credentials, configuration and
all application transcripts. A consented app could induce the harness to disclose
its dedicated credential through an allowed tool, read another app's transcript
or change shared configuration. Per-app home isolation is deferred. Use trusted
apps and a separately revocable login; network restrictions cannot prevent
disclosure through an approved tool.

Application effects require idempotency or action-ID deduplication; cancellation
cannot undo a completed effect. Owner secrets and grants remain outside the home
mounted into sessions. Box cleanup failures retain capacity until owned cleanup
and gateway restart; doctor and service logs identify failures without broad
Docker deletion.

The explicit `init --headless-static-bearer` path remains available for headless
integrations. It requires an exact app origin, fixed tools and private bearer
handoff, and has no hosted owner/OAuth flow. It is off by default. See
[configuration](configuration.md) for this path and full policy reference, or
[release operations](release.md) for artifact production and owner-controlled
publication.
