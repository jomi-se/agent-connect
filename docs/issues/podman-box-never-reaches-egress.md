# Podman: a box sometimes never reaches the egress

Status: needs-info

Intermittently on rootless Podman, a new session's box started but never got
a working connection through the egress, so the session failed before the
harness could make a model call. Retrying the session usually worked.

Gateway 0.0.6 fixed one cause: a session's network put its own DNS first in
the egress's resolver, and on Podman 5 that answered every outside lookup with
NXDOMAIN while a session was open. It is not known whether every occurrence
was that.

The gateway now logs how each session's box reaches its peers, and the egress
logs each box's first connection and every failed lookup, so the next
occurrence should show which hop failed: the box's network attachment, name
resolution, or the egress itself.

## Next step

Watch for it on 0.0.6 and later. If it happens again, capture one failure
with those logs and decide whether it is ours or Podman's. If nothing recurs
after a few weeks of sessions on Podman 5, close it as fixed by 0.0.6.

## Comments

2026-11-25: a different cause of a box that cannot reach the egress turned up:
[a failed service start leaves a dead egress](../archive/issues/failed-service-start-leaves-dead-egress.md).
Its signature differs (no connection in the egress log, and a retry does not
help), so it does not explain these occurrences on its own.
