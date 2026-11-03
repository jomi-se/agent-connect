# ADR 0020: Container engines

Status: Proposed (2026-11-01)

## Context

The gateway is a network service that starts containers. On a rootful Docker
engine, anything that can start containers can start host root, so any bug in
the gateway, or in what it parses, became a root compromise of the owner's
machine. The people most likely to deploy a gateway casually are the least
likely to know that. The gateway also ran boxes as the owner's host uid with
the shared harness home bind-mounted, which works only where container ids are
host ids.

## Decisions

1. **Ask the engine, never the client.** The gateway reads what the engine
   reports (`docker info` security options and operating system, `podman info`
   rootless) and fails rather than guessing. A context name, `DOCKER_HOST` or
   the client's platform is never evidence: a macOS client can drive a remote
   rootful Linux daemon.

2. **Rootful is an owner's explicit choice.** A new runtime on a rootful engine
   needs `--allow-rootful-engine` on `setup` or `init`, recorded in the
   configuration only.
   Existing runtimes keep working, with a warning at setup and serve, and
   doctor's `engine_rootless` fails until the acceptance is recorded. Engines
   in a virtual machine (Docker Desktop, OrbStack, as the daemon reports
   itself) pass. Docker's userns-remap mode is refused.

3. **Two programs, one selection.** `container_engine` (`docker` or `podman`)
   is recorded by setup; the global `--container-engine` option or
   `AGENT_CONNECT_CONTAINER_ENGINE` chooses it for a new runtime or one
   command. Each command's entry point selects once; resolving configuration
   and planning setup are pure. An existing runtime refuses a different engine;
   switching is a configuration edit.

4. **The box user follows the engine.** With the shared home mounted: the
   owner's ids on a rootful or virtual-machine engine; container root, which is
   the owner, on rootless Docker, with `IS_SANDBOX=1` because Claude Code
   otherwise refuses to skip permissions as root; on rootless Podman the
   image's own user mapped onto the owner (`--userns=keep-id:uid=1000,gid=1000`),
   so no box runs as root. Boxes without the shared home keep each engine's
   default mapping.

5. **The egress is judged by typed facts.** Each engine has its own extractor
   for every fact the egress check judges, and a missing field is an error, so
   no document is judged under the other engine's meaning. Podman 4 omits
   devices from its inspection, so a Podman egress must also carry a creation
   record equal to the arguments this gateway runs. That record is an
   attestation written by the creating client, not tamper-proof; it catches
   what inspection omits and stale or hand-made containers. The runtime
   configuration at Podman's `OCIConfigPath` would be ground truth for devices
   if ever needed. `scripts/egress-impostors.sh` keeps the evidence that each
   weakening is refused on each engine.

6. **Podman keeps a keepalive beside the egress.** Podman 4.9 tears down its
   shared rootless network when a container leaves a network and no other
   running container uses it, so the egress leaving the last session's
   network cut the egress off. `egress start` keeps an owned, locked-down
   `sleep` container on that network, readiness requires it, and it follows
   the egress's image. The workaround goes once Podman 5, which counts the
   network's users, is the minimum.

7. **The service starts its own egress.** An engine without a daemon restarts
   nothing at boot, so the systemd unit runs `egress start --config` before
   serving; a failure goes through the unit's restart policy.

## Consequences

Rootless Podman is the recommended Linux engine and the tested baseline is
Podman 4.9. Upgrading an existing rootful runtime changes nothing it does, but
doctor now fails until the owner accepts the risk or moves to a rootless engine.
A Podman egress made by an older gateway is refused with a pointer to
`setup --upgrade`, which recreates it.
