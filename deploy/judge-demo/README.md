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

## Logs and shutdown

```sh
docker compose --env-file deploy/judge-demo/.env \
  -f deploy/judge-demo/compose.yaml logs -f

sudo tailscale funnel off

docker compose --env-file deploy/judge-demo/.env \
  -f deploy/judge-demo/compose.yaml down
```

Do not use `down -v` until the disposable connector identity and grants should
be destroyed. A configured enrollment passphrase is deliberately omitted from
startup logs.
