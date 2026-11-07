# Podman: a box sometimes never reaches the egress

Status: needs-info

Intermittently on rootless Podman 4.9, a new session's box starts but its
first connection never arrives at the egress, so the session fails before the
harness can make a model call. Retrying the session usually works.

The gateway now logs how each session's box reaches its peers, and the egress
logs each box's first connection and every failed lookup, so the next
occurrence should show which hop failed: the box's network attachment, name
resolution, or the egress itself.

## Next step

Capture one failure with those logs, then decide whether it is ours or
Podman's. Check Podman 5 too: if only Podman 4 does it,
[requiring Podman 5](../plan/require-podman-5.md) closes this issue.
