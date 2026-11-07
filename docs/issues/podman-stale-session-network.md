# Podman: a cancelled session can leave its network half removed

Status: needs-info

On a rootless Podman 4.9 host, cancelling a session has more than once left
its session network in a state Podman disagrees with itself about. A later
operation on the egress then fails with `could not find network`, or with
`network inspection mismatch: asked to join 1 network(s) … but have information
on 2 network(s)`.

The second message also appears after Podman 4.9 tears down its rootless
network: it leaves a stale `aardvark.pid` and files for networks that no longer
exist in `$XDG_RUNTIME_DIR/containers/networks/aardvark-dns/`, and the next
network change fails with `aardvark pid not found`. So this may be the same
fault reached another way. It has not been reproduced on purpose, and neither
has been checked on Podman 5.

## Next step

Reproduce it: cancel sessions on Podman 4.9 at different points (during box
start, mid-turn, during teardown) and record which one leaves the network
behind. Then check whether Podman 5 does the same. If only Podman 4 does,
[requiring Podman 5](../plan/require-podman-5.md) closes this issue.
