# The teardown gate runs only on Docker

Status: ready-for-agent

`scripts/gateway-teardown.mjs` finds `docker` on the PATH, fakes engine
failures through a `bin/docker` wrapper and tells the gateway to use Docker.
Every other box-backed gate chooses its engine through
`scripts/container-engine.mjs` and runs on Podman too. On a Podman-only
machine the teardown gate cannot run at all, so a change to egress or session
cleanup is checked there only by CI.

That is how 0.0.8's change (a starting gateway replaces its egress instead of
restarting it by ID) reached CI with this gate still asserting the old
behaviour.

## Fix

- Drive the engine through `scripts/container-engine.mjs`, with the fault
  wrapper named after the engine, and cover Podman's keepalive container in
  the cleanup checks.
- Fail `npm run lint` when a script under `scripts/` that drives containers
  looks up `docker` itself instead of using `container-engine.mjs`.
