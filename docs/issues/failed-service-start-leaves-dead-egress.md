# A failed service start leaves a dead egress that the gateway reuses

Status: in-progress

When `serve` runs as the user service, it starts the owned egress from inside
the service, so the egress's container monitor lives in the service's
control group. If `serve` then exits with an error, the service manager
kills the whole group, egress included, before the engine records that it
stopped. On rootless Podman the engine keeps reporting the egress as running.

On the next start the gateway inspects the egress, sees it running and
matching, and reuses it. Nothing listens behind it: every session's box
resolves `egress` but its connections are refused, so the harness reports it
cannot reach its provider (Codex: "can't reach chatgpt.com"). `doctor`'s
`network_proxy` check passes on the same stale answer. The egress logs no
connections, which is the tell.

Seen on 2026-11-25, upgrading a real gateway to 0.0.7: `serve` refused the
earlier owner state, the service restarted 72 times, and after setup fixed
the owner state the service came up healthy with a dead egress. Removing the
egress and its keepalive and restarting the service recovered it.

## Reproduce

Run setup with the user service, make `serve` fail after it has started the
egress (any startup error after the egress step), let the service manager
restart it, then remove the cause. A new session cannot reach the network,
while the engine lists the egress as up and `doctor` passes.

## Fix

- The gateway's egress check, and `doctor`'s, prove the proxy is alive rather
  than trusting the engine's state: the container's process exists and the
  proxy accepts a connection. A dead one is replaced like a mismatched one.
- A failed `serve` does not leave the egress to die with the service: either
  the egress runs outside the service's control group, or every exit path
  stops it cleanly so the engine's state stays true.
- A test with a service-manager fixture that fails a start and recovers, then
  checks that a session reaches the network.

Related: [a box sometimes never reaches the egress](podman-box-never-reaches-egress.md)
had a different signature (a retry worked), but a dead egress is one more
cause to rule out when it recurs.

## Comments

2026-11-25: `podman ps --sync` does not correct the state, and `start` on
such a container does nothing; `podman exec <id> true` fails on it, also
where the engine runs in a VM. A starting gateway now replaces an egress or
keepalive that does not answer, and doctor fails it. Stale state needs the
service's control group killed, which always means the gateway restarts, so
repairing at start covers it without moving the egress out of the service.
Closing waits on reproducing it under systemd with the release build.
