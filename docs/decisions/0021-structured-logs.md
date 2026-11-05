# ADR 0021: Structured logs

Status: Accepted (2026-11-05)

## Context

A container engine upgrade left every session unable to reach its model
provider. The logs could not say why: the gateway wrote free-text lines, the
egress folded every failure into one reason, nothing tied a session to its
egress verdicts, and the engine copied each box's whole ACP stream (prompts,
replies, tool payloads) into the host journal. Finding the cause meant
reproducing it by hand, and the journal held content it never should have.

## Decisions

1. **One record shape.** The gateway and the egress write one JSON object per
   line in OpenTelemetry's log data model: `timestamp`, `severity_text`,
   `severity_number`, `body`, `attributes` and `resource` (`service.name`
   `agent-connect-gateway` or `agent-connect-egress`, `service.version`).
   Attribute names follow OTel's semantic conventions where one exists
   (`session.id`, `network.peer.address`, `rpc.method`); the rest are
   namespaced (`acp.*`, `agent_connect.egress.*`). Anything that reads the
   OTel model can collect them without a format of ours; no exporter ships by
   default.
2. **Where they go.** The gateway writes to stderr, which a service manager
   keeps (the journal under systemd). On Podman the egress uses the journald
   log driver, so its lines outlive the container; on Docker it keeps a
   rotated json-file, since Docker has no journald on every host. Both are
   bounded: by journald's limits or the rotation, and by the egress's own
   rate-limited logger.
3. **A session is one filter.** Every record a session causes carries its
   `session.id`, the id its box and network are named after. The gateway logs
   how each box reaches its peers (`session network wired`, with the
   `--add-host` entries on Podman); the egress logs a box's first connection
   with `network.local.address`, its own address on that session's network.
   Joined, they tell "the box never reached the egress" from "the egress
   failed on its behalf".
4. **No session content.** The box runs with `--log-driver none`: its stdout is
   the session, and no engine log may hold it. The gateway logs one record per
   ACP message instead (who sent it, method, request id and a 50-character
   preview of its first text), and of a streamed reply only the first chunk,
   so an error the agent reports as text stays visible. Thought chunks are not
   logged. The egress never logs destinations, paths, headers or bodies.

## Consequences

- `RUST_LOG` still selects what the gateway logs; the default now includes the
  gateway's own info events.
- An egress created by an earlier version has another log configuration and
  is replaced like any egress the gateway did not create in its current form.
- A 50-character preview of a prompt is in the journal by design: enough to
  tell which message failed, too little to carry the conversation.
