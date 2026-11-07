# Podman: stale network state breaks joining a session network

Status: needs-triage

On rootless Podman, cancelling a session has more than once left
its session network in a state Podman disagrees with itself about. A later
operation on the egress then fails with `could not find network`, or with
`network inspection mismatch: asked to join 1 network(s) … but have information
on 2 network(s)`.

The second message also appears after Podman 4.9 tears down its rootless
network: it leaves a stale `aardvark.pid` and files for networks that no longer
exist in `$XDG_RUNTIME_DIR/containers/networks/aardvark-dns/`, and the next
network change fails with `aardvark pid not found`. So this may be the same
fault reached another way.

## Podman 5.7

It happens on Podman 5.7 too. A local `test:integration:gateway:boxed` run on
2026-11-07 passed every Codex scenario, then the Claude boxed preflight failed
twice in a row with `network inspection mismatch … internal libpod error`.
The teardown and clean-room gates did not run after it.

Afterwards Podman listed only its default network, while
`$XDG_RUNTIME_DIR/containers/networks/aardvark-dns/` still held files for nine
networks that no longer existed: session networks and test-model networks
from runs two days apart, including that run's. The `aardvark-dns` process
itself was alive. So removing a network does not always remove its
`aardvark-dns` entry, and stale entries may be what later joins trip over.

## Next step

Find what leaves the entry behind: a network removed while a container still
holds it, a cancelled teardown, or a disconnect that fails partway. Then check
whether a join fails only while such an entry exists. Clearing the stale files
before a run is a workaround to test the theory, not the fix.
