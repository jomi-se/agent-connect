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

2026-11-25, reproduced and understood. Only Podman's monitor (`conmon`)
lives in the service's control group; the egress process runs in its own
scope. When `serve` exits on an error, the service manager stops what is
left in the group, the monitor goes, and the egress keeps running
unwatched. The engine reports it running from then on. Its first proxied
request writes a log line into the pipe the monitor used to read, and the
egress dies; the engine still reports it running, `start` does nothing on
it, and `podman ps --sync` does not correct it. Replayed on a throwaway
runtime: 0.0.7's native binary as a transient user unit with
`Restart=on-failure`, owner state marked earlier so `serve` failed after
starting the egress; after three restarts the monitor was gone, and one
proxied request killed the egress.

So checking that the egress answers is not enough at a start: it can still
be alive and die on first use. A starting gateway now replaces its egress
and keepalive every time (they hold no state, and no session exists yet), and
`doctor` fails an egress whose process is gone. Closing waits on the same
replay against the release build.
