# Real Omnigent + Codex reference gateway

This is the source-installable Agent Connect profile for a real, user-owned
Codex agent. It runs the Agent Connect gateway, an Omnigent server and host,
and a small compatibility wrapper around the published `codex-acp` adapter on
one Linux machine. A separate HTTPS web application can authorize through
Tailscale Serve, lend task-scoped tools, and receive real Codex tool calls.

This is the usable reference MVP and uses the user's own Codex account. The
hackathon's anonymous judge deployment has been retired and removed.

## Supported reference platform

The complete path has been tested on Ubuntu 24.04 ARM64 with:

- Node.js 22 and npm 10 or newer;
- Codex CLI with a valid subscription account already logged in through OAuth;
- Omnigent 0.5.1;
- `@agentclientprotocol/codex-acp` 1.1.2; and
- Tailscale Serve with the browser and gateway in the same tailnet.

Other Linux distributions and architectures may work but have not yet been
fully tested. Windows and macOS have not been tested. The launcher rejects
Omnigent versions other than 0.5.1 in case upstream changes would break Agent
Connect.

## 1. Install prerequisites

Install and authenticate _Codex_ and _Tailscale_ using their upstream instructions.
Install Omnigent, then install this repository:

```sh
curl -fsSL https://omnigent.ai/install.sh | sh -s -- --version 0.5.1
git clone https://github.com/jomi-se/agent-connect.git
cd agent-connect
npm install
npm run build
```

## 2. Create a dedicated Codex runtime home

Keep the runtime home distinct from the machine's interactive Codex home.
Startup links only `auth.json` from the existing machine login into this home;
configuration, history, sessions and caches remain separate. No second account
or dedicated runtime login is needed:

```sh
mkdir -p "$HOME/.agent-connect/codex-home"
chmod 700 "$HOME/.agent-connect/codex-home"
```

The source defaults to `$HOME/.codex`, resolved before the launcher isolates
Omnigent's `HOME`. Set `AGENT_CONNECT_CODEX_AUTH_HOME` when the machine login lives
elsewhere. It never defaults to the runtime `CODEX_HOME`. The source must have a
regular, file-backed `auth.json`; keyring-only storage is not supported by this
reference profile. If needed, configure file storage for the **same existing
account** in the source home using Codex's supported credential-storage settings.
See [Codex credential storage](https://learn.chatgpt.com/docs/auth#credential-storage).

The launcher selects a small `CODEX_PATH` wrapper which passes
`-c 'cli_auth_credentials_store="file"'` to the actual Codex CLI, so file storage
applies from app-server startup, not only at session creation. It also sets the
matching `CODEX_CONFIG` override, without editing either home's `config.toml`. Explicit
`keyring` or `auto` overrides fail before startup. It does not change source
credential permissions or copy source configuration/history.

The symlink follows source refreshes and atomic source-file replacements. This
shares credential state, not a cross-process refresh lock: concurrent Codex
refreshes can still race, and a client that replaces the destination symlink
instead of writing through it will be refused on the next startup. Treat the
linked credential and any migration backup like a password.

### Migrating an existing standalone runtime login

Normal startup refuses to overwrite an existing regular runtime `auth.json`.
First stop the gateway, Omnigent host and all Codex processes using that runtime
home. With those writers stopped, explicitly migrate the exact configured homes:

```sh
node scripts/link-codex-auth.mjs --migrate \
  /absolute/path/to/machine-codex-home \
  /absolute/path/to/agent-connect-codex-home
```

The helper preserves the old runtime credential in a unique private backup
directory beside `auth.json`, with file mode `0600`, and prints only its path.
Link failure restores the old file; an unexpected concurrent destination is
never overwritten and the backup is retained for manual recovery. Successful
repeated runs accept the correct link unchanged. Unexpected links, directories,
missing source files and aliased homes are refused; there is no copy fallback.
To roll back a successful migration, stop writers again, confirm and remove only
the runtime symlink, then move the printed backup file back to runtime `auth.json`.

## 3. Configure the gateway

```sh
cp deploy/real-gateway/.env.example deploy/real-gateway/.env
chmod 600 deploy/real-gateway/.env
```

Edit `.env` with:

- the Tailscale Serve URL for this machine;
- the exact Tailscale login allowed to operate the gateway;
- the dedicated `CODEX_HOME`;
- a dedicated session workspace directory; and
- `INITIAL_AGENT_MODE`, which defaults to `read-only`.

## Codex configuration

The reference launcher passes a dedicated `CODEX_HOME`, one
`AGENT_CONNECT_WORKSPACE`, and an explicit Codex ACP mode into every Omnigent
runner. It shares only the selected machine login's `auth.json`; pointing runtime
`CODEX_HOME` at the source home (including a symlink alias) is rejected.

| `INITIAL_AGENT_MODE` | Codex behavior                                                         | Recommended use                                        |
| -------------------- | ---------------------------------------------------------------------- | ------------------------------------------------------ |
| `read-only`          | Inspect files; file edits and shell commands require approval          | Default for apps you did not write                     |
| `agent`              | `workspace-write`, sandboxed command network off, approvals on request | A dedicated disposable workspace on a host you control |
| `agent-full-access`  | No Codex filesystem/network sandbox and no approval prompts            | Do not use for arbitrary external applications         |

Consider setting up the codex web search setting in the dedicated runtime home's `config.toml`:

```toml
web_search = "disabled" # no web research
# web_search = "cached" # indexed results; lower exposure and less freshness
# web_search = "live"   # current pages; useful for research, higher prompt-injection risk
```

The product-research demo profile uses `live`. A general gateway should
default to `cached` or `disabled` and enable live search only when the user
accepts the additional untrusted-content boundary.

`AGENT_CONNECT_WORKSPACE` is the session cwd and the write boundary in `agent`
mode. However, keep in mind it is **not a sandbox boundary**. The Codex process
and its ACP adapter still run as the gateway's Unix user on the host. Use a
dedicated OS account or a disposable VM/container when unrelated host data is
in scope.

Codex settings are user-owned under the configured runtime home:

```sh
$EDITOR "$CODEX_HOME/config.toml"
```

That file controls model and reasoning defaults, web search, MCP servers,
skills, plugins, and other normal Codex configuration. The same runtime home
may also contain sessions, memories, caches, and logs. Treat every configured
MCP, skill, plugin, absolute path, and trusted project as additional authority
available to remote tasks. Prefer a freshly created runtime home containing
only `auth.json` and a small reviewed `config.toml`. The `.env` `CODEX_CONFIG`
JSON is merged over that file for each ACP process.

In this MVP, the calling web application cannot yet approve Codex tool requests
through Agent Connect.

## 4. Initialize, then start the real gateway

Create the gateway identity in a one-shot foreground command:

```sh
deploy/real-gateway/run.sh initialize
```

It prints two deliberately separate values exactly once:

- a public runtime card: this is how a web app knows how to target and verify an
  Agent Connect gateway. Enter it in the web app using the Agent Connect SDK;
  and
- a private enrollment passphrase: save it immediately in a password manager.
  It is requested only on the gateway-owned authorization page and cannot be
  recovered from the durable state.

The initializer stores the gateway keys and only a salted scrypt verifier for
the passphrase. It refuses to overwrite an existing identity. Normal startup
does not accept or retain a plaintext passphrase and refuses to create state
implicitly.

Then start the stack:

```sh
deploy/real-gateway/run.sh
```

This command starts and supervises all downstream actors: the Agent Connect
gateway, the Omnigent server, and the Omnigent execution host.

The durable gateway identity, grants, and enrollment state live in the
gitignored `.agent-connect/real-connector` directory by default. This legacy
internal directory name is retained for compatibility. Keep the
foreground process in tmux/screen or replace it with a user-managed service for
long-running use. The supervisor also gives Omnigent a dedicated home
inside that state directory. Codex continues to use its isolated `CODEX_HOME`
with the shared machine credential.

## 5. Publish the gateway through Tailscale Serve

Using the default gateway port:

```sh
sudo tailscale serve --bg --https=8443 http://127.0.0.1:8787
tailscale serve status
curl -fsS https://YOUR-MACHINE.YOUR-TAILNET.ts.net:8443/healthz
```

## 6. Run the private Canvas demo

Start the Canvas in a second terminal:

```sh
npm run dev --workspace @agent-connect/firebase-canvas -- --port 5173
```

Publish both local services to the tailnet. The second target must match
`AGENT_CONNECT_GATEWAY_PORT` when the `.env` overrides its default of `8787`:

```sh
sudo tailscale serve --bg --https=443 http://127.0.0.1:5173
sudo tailscale serve --bg --https=8443 http://127.0.0.1:8787
tailscale serve status
```

Open the Canvas. `connectAgent()` uses the bounded Open Responses profile by
default; no protocol query parameter is needed:

```text
https://YOUR-MACHINE.YOUR-TAILNET.ts.net/
```

These routes use Tailscale Serve and should appear as `tailnet only`. The real
Codex profile does not require Tailscale Funnel and should not have a public
Funnel listener. `tailscale funnel reset` removes the combined Serve
configuration as well as Funnel configuration on current Tailscale versions,
so re-add these private routes afterwards if that command was used as a public
demo kill switch.

## 7. Connect a web application

Follow the [web application integration guide](../../docs/guides/web-app-integration.md).
The application imports the runtime card, verifies a fresh signed gateway
challenge, redirects to gateway-owned consent, exchanges the code for a
scoped grant, creates an Agent Connect session, and streams the real
Codex task.

## Security boundary

Only authorize applications you trust. The consent screen restricts which
application Origin and tool snapshot receive access but it cannot make malicious
prompts suddenly safe. This reference profile is not an arbitrary-app sandbox
and must not be exposed anonymously.
