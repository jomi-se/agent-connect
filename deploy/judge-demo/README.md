# Public judge appliance

This profile runs the Agent Connect gateway, OmniGENT server and host, and the
deterministic ACP fixture in one disposable container. It has no Codex or model
credential. Only the gateway is published, on host loopback.

## Configure

From the repository root:

```sh
cp deploy/judge-demo/.env.example deploy/judge-demo/.env
chmod 600 deploy/judge-demo/.env
```

Edit `.env` and set:

- the exact Firebase origin and callback;
- the public Funnel endpoint; and
- a new high-entropy enrollment passphrase saved in the private judge
  instructions and a password manager.

The committed tool hash matches the current Firebase Canvas
`set_page_message` definition. Recompute and review it whenever that definition
changes.

## Build and validate on loopback

```sh
docker compose --env-file deploy/judge-demo/.env \
  -f deploy/judge-demo/compose.yaml build

docker compose --env-file deploy/judge-demo/.env \
  -f deploy/judge-demo/compose.yaml up -d

docker compose --env-file deploy/judge-demo/.env \
  -f deploy/judge-demo/compose.yaml ps
```

The only published address should be `127.0.0.1:10081`. Run the complete
enrollment, grant, OmniGENT, ACP, MCP, and browser-tool loop with:

```sh
AGENT_CONNECT_SMOKE_ENROLLMENT_PASSPHRASE='the same passphrase from .env' \
  node scripts/smoke-judge-appliance.mjs
```

The command prints one sanitized JSON success record. It does not print bearer
tokens or the enrollment passphrase. It derives the connector-owned approval
Origin from the signed runtime card rather than assuming a placeholder URL.
After the tool loop completes, it revokes its own application grant and proves
that the revoked credential can no longer create an application session. The
revoked entry remains visible as intentional audit history, but it cannot be
used as an active capability.

After a successful run, the container's ephemeral
`/tmp/agent-connect-acp-transcript.jsonl` records the sanitized ACP/MCP protocol
sequence. It is replaced with the container tmpfs and is not persisted in the
state volume.

Inspect the effective boundary before public exposure:

```sh
docker inspect judge-demo-judge-appliance-1 --format \
  '{{json .Config.User}} {{json .HostConfig.ReadonlyRootfs}} {{json .HostConfig.CapDrop}} {{json .HostConfig.SecurityOpt}} {{json .HostConfig.PidsLimit}} {{json .HostConfig.Memory}} {{json .HostConfig.NanoCpus}} {{json .HostConfig.PortBindings}} {{json .Mounts}}'
```

Expected essentials are user `1000:1000`, read-only root, capability drop
`ALL`, `no-new-privileges`, bounded PIDs/memory/CPU, one loopback port, and one
Docker-managed state volume. There must be no host home, repository, Codex,
SSH, or Docker-socket bind mount.

## Publish through Funnel

Only after the loopback smoke passes:

```sh
sudo tailscale funnel --bg --https=10000 http://127.0.0.1:10081
sudo tailscale funnel status --json
```

Use a clean or incognito browser for the public test because private Serve and
public Funnel currently share a cookie hostname. Copy the public runtime card
from the first-start logs into the Firebase Canvas; never copy the enrollment
passphrase into the application.

## Start automatically with Tailscale

The Compose service already uses `restart: unless-stopped`, so Docker restarts
an existing appliance after a process, daemon, or host restart. Funnel must use
Tailscale's background configuration; a foreground Funnel kept in tmux does not
survive a host reboot.

Install the checked-in systemd reconciliation unit:

```sh
sudo install -m 0644 \
  deploy/judge-demo/systemd/agent-connect-judge.service \
  /etc/systemd/system/agent-connect-judge.service
sudo systemctl daemon-reload
```

If a foreground Funnel is currently running in tmux, stop that command before
starting the unit. For the demo VM's `tfun` session:

```sh
tmux send-keys -t tfun C-c
sudo systemctl enable --now agent-connect-judge.service
```

The unit is wanted by and part of `tailscaled.service`. Whenever Tailscale
starts, it idempotently brings the Compose appliance to healthy state and
reapplies the port `10000` Funnel in `--bg` mode. It deliberately has no
`ExecStop`: a manual unit reload must not destroy the connector state volume or
silently remove judge access.

Verify the installed path:

```sh
sudo systemctl status agent-connect-judge.service --no-pager
sudo tailscale funnel status --json
curl -fsS https://artifex-box.tail246db1.ts.net:10000/healthz
```

The expected result is an active `exited` oneshot, a background Funnel proxy to
`127.0.0.1:10081`, and `{"ok":true}`. Do not use `docker compose down -v`,
remove `judge-demo_judge-state`, or prune Docker volumes while the judge runtime
must retain its published identity.

## Credential backup

The two text credentials that preserve the published connector are:

- `/home/dev/agent-connect/deploy/judge-demo/.env` on the host; and
- `/var/lib/agent-connect/connector.json` inside the appliance, backed by host
  Docker volume `judge-demo_judge-state` (normally
  `/var/lib/docker/volumes/judge-demo_judge-state/_data/connector.json`).

`connector.json` contains the connector private key, capability-signing secret,
passphrase verifier, enrolled-device hashes, and grant audit state. Store it as
a sensitive password-manager attachment or encrypted secure note. Restoring an
older copy preserves the runtime card and enrollment passphrase but loses any
devices and grant changes made after that copy.

## Logs and shutdown

```sh
docker compose --env-file deploy/judge-demo/.env \
  -f deploy/judge-demo/compose.yaml logs -f

sudo systemctl disable --now agent-connect-judge.service
sudo tailscale funnel reset

docker compose --env-file deploy/judge-demo/.env \
  -f deploy/judge-demo/compose.yaml down
```

Disable the reconciliation unit before the final Funnel shutdown. Otherwise a
later `tailscaled.service` restart will intentionally run the unit and publish
the demo again. If the systemd unit was never installed, omit that command.

Do not use `down -v` until the disposable connector identity and grants should
be destroyed. A configured enrollment passphrase is deliberately omitted from
startup logs.
