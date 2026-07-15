# Private demo startup and auth validation

Date: 2026-07-15

Status: deployed phone validation in progress. The first consent attempt exposed
two Chromium integration bugs: `no-referrer` produced `Origin: null`, then
`form-action 'self'` blocked the cross-origin OAuth return redirect. The gateway
now preserves the same-origin POST and permits only the validated application
origin as the redirect target. The retry is pending.

Operator-friendly edition: [open the self-contained HTML runbook](private-demo-auth-validation.html).

This is the canonical operator path for the current VM. It deliberately uses
the proven, non-containerized OmniGENT profile. It does **not** enable the
experimental bubblewrap launcher.

## What runs where

Three local processes participate:

1. the OmniGENT server owns conversations on loopback;
2. `omnigent host` keeps this VM available to launch Codex runners;
3. the Agent Connect gateway listens on loopback port `8788` and Tailscale
   Serve exposes it as HTTPS on port `8443`.

The Firebase application remains at `https://agent-connect-demo.web.app`.
Tailscale currently routes this VM's `:8443` endpoint to
`http://127.0.0.1:8788`; the generic gateway default is `8787`, so the command
below sets `AGENT_CONNECT_PORT=8788` explicitly.

## One-time preparation

From the repository root:

```sh
npm install
npm run build

mkdir -p .omnigent-spike/private-demo-config
mkdir -p .omnigent-spike/private-demo-data
mkdir -p .omnigent-spike/private-demo-codex-home
mkdir -p .omnigent-spike/private-demo-workspace

cp config/omnigent-demo.yaml.example \
  .omnigent-spike/private-demo-config/config.yaml
cp "$HOME/.codex/auth.json" \
  .omnigent-spike/private-demo-codex-home/auth.json
if test -f "$HOME/.codex/config.toml"; then
  cp "$HOME/.codex/config.toml" \
    .omnigent-spike/private-demo-codex-home/config.toml
fi
chmod 700 .omnigent-spike/private-demo-codex-home
chmod 600 .omnigent-spike/private-demo-codex-home/auth.json
```

This copies the Codex login into a gitignored runtime home so Codex can write
its own SQLite state without touching `~/.codex`. It is still a usable
credential: keep the directory owner-only and do not expose or commit it.

The example config contains this repository's current absolute path. If the
checkout moves, update the `command` path in the copied `config.yaml`.

## Terminal 1: start the OmniGENT server

Every OmniGENT command in this run must use the same isolated config and data
directories:

```sh
cd /home/dev/agent-connect
export OMNIGENT_CONFIG_HOME="$PWD/.omnigent-spike/private-demo-config"
export OMNIGENT_DATA_DIR="$PWD/.omnigent-spike/private-demo-data"
export CODEX_HOME="$PWD/.omnigent-spike/private-demo-codex-home"
export OMNIGENT_RUNNER_ENV_PASSTHROUGH=CODEX_HOME

omnigent server start
omnigent server status
```

Copy the loopback URL printed by OmniGENT. It is usually
`http://127.0.0.1:6767`, but OmniGENT may choose another free port. The server
runs in the background.

## Terminal 2: keep the OmniGENT host online

Repeat the four exports from Terminal 1, replace `PORT` with the printed port,
then leave this process running:

```sh
cd /home/dev/agent-connect
export OMNIGENT_CONFIG_HOME="$PWD/.omnigent-spike/private-demo-config"
export OMNIGENT_DATA_DIR="$PWD/.omnigent-spike/private-demo-data"
export CODEX_HOME="$PWD/.omnigent-spike/private-demo-codex-home"
export OMNIGENT_RUNNER_ENV_PASSTHROUGH=CODEX_HOME

omnigent host http://127.0.0.1:PORT
```

In another shell, `omnigent host status` should show exactly one online local
host.

## Terminal 3: start the connector gateway

Use a new state filename for the first auth proof. Reusing that file later
preserves connector identity, enrolled devices, and grants. Do not delete an
old state file merely to rerun the demo; choose another filename if a clean
enrollment is required.

```sh
cd /home/dev/agent-connect

export OMNIGENT_URL=http://127.0.0.1:PORT
export AGENT_CONNECT_HOST=127.0.0.1
export AGENT_CONNECT_PORT=8788
export AGENT_CONNECT_WORKSPACE="$PWD/.omnigent-spike/private-demo-workspace"
export AGENT_CONNECT_STATE_PATH="$PWD/.omnigent-spike/private-demo-connector-v1.json"
export AGENT_CONNECT_PUBLIC_ENDPOINT=https://artifex-box.tail246db1.ts.net:8443
export AGENT_CONNECT_TRANSPORT_PROFILE=tailscale-serve
export AGENT_CONNECT_ALLOWED_ORIGINS=https://agent-connect-demo.web.app
export AGENT_CONNECT_ALLOWED_TAILSCALE_USERS="$(tailscale status --json | jq -r '.User[.Self.UserID|tostring].LoginName')"

npm run start --workspace @agent-connect/gateway
```

On first creation of that state file, the gateway prints two different items:

- a **public runtime card**, which may be pasted into the application;
- an **enrollment passphrase**, which must go to the connector-owned consent
  page only and should be saved in a password manager.

The current implementation cannot re-export the enrollment passphrase. Keep
the first-start output. Runtime-card re-export and credential rotation remain
pending operator features.

## Verify the HTTPS route

Before opening the phone app:

```sh
tailscale serve status
curl -fsS https://artifex-box.tail246db1.ts.net:8443/healthz
```

The Serve output must show `:8443` proxying to `127.0.0.1:8788`. If it does
not, restore the route with:

```sh
sudo tailscale serve --bg --https=8443 http://127.0.0.1:8788
```

Do not substitute Funnel for this private profile. The gateway requires an
authenticated Tailscale requester header; the separate public judge profile
has not been implemented yet.

## Phone happy-path proof

1. Open `https://agent-connect-demo.web.app` on a phone signed into the
   allowlisted tailnet.
2. Paste only the public runtime card and submit the default task.
3. If the browser asks to access local-network devices, allow it. Record this
   UX friction; it is caused by a public Firebase page contacting a private
   tailnet endpoint.
4. Confirm the browser navigates to the connector's `*.ts.net:8443` page.
5. Inspect the exact requesting origin, callback, scopes, and
   `set_page_message` schema. Enter the enrollment passphrase there and allow
   the request.
6. Confirm the browser returns to Firebase, streams the Codex task, receives a
   `tool.requested`/`tool.completed` pair, and visibly changes the page.
7. Open
   `https://artifex-box.tail246db1.ts.net:8443/v1/grants`, revoke the Canvas
   grant, then submit again. The existing capability must be rejected.

If consent returns `{"error":"authorization_origin_mismatch"}`, the gateway is
still running the pre-fix build. Rebuild and restart only the gateway, return to
Firebase, and begin authorization again. The enrollment passphrase and durable
connector state do not change.

If Allow appears to hang while the page already says the browser is enrolled,
the gateway is running the intermediate build whose CSP blocked the redirect
back to Firebase. Apply the latest build and restart only the gateway. Return to
Firebase and start a fresh authorization; do not enter or rotate the enrollment
passphrase again.

Capture screenshots or a short recording of the connector origin, consent,
return redirect, tool event, page mutation, grant list, and rejected post-
revocation request. Do not capture the passphrase, grant token, Codex login, or
connector private state.

## Negative and restart checks

After the happy path, perform these in order:

1. restart only the gateway with the same state path; connector identity and
   revocation must survive;
2. retry from an unallowlisted Origin and confirm CORS/auth rejection;
3. change the application's tool snapshot and confirm the old grant cannot
   authorize it;
4. attempt a replay of an already exchanged authorization callback and confirm
   rejection;
5. stop the OmniGENT host and confirm a task fails closed rather than silently
   selecting an unknown runtime; restart it and confirm gateway-owned session
   healing provisions a healthy downstream session.

The first run should not be blocked on every negative case. Record the happy
path and revocation first, then diagnose failures one boundary at a time.

## Stop the stack

Stop the gateway and foreground host with Ctrl-C. Then, with the same
OmniGENT config/data exports used above:

```sh
omnigent server stop
```

The connector state, isolated Codex home, and OmniGENT data remain under the
gitignored `.omnigent-spike/` tree for the next run.
