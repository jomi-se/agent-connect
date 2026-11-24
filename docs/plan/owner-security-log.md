# Owner security log

Status: needs-triage

The owner can see what happened to their gateway's security, not only what
failed. Today Activity on the Security page lists the last 20 failed sign-ins
from the past 24 hours, kept in memory and lost on restart. Successful owner
actions reach only the service log, as `owner_audit` events (see
[configuration](../install/configuration.md)), which the owner has to read
from a terminal.

## Proposal

- Keep the `owner_audit` events as the single source: the same allowlisted
  fields, no secrets.
- Append each one to a bounded file in the private state directory, so the
  history survives restarts and upgrades. Keep a fixed number of entries or a
  fixed age, whichever is reached first.
- Activity shows that history: sign-ins and their factor, factors set up or
  removed, apps approved, denied and revoked, sessions ended, failed sign-ins.
  Newest first, each with its address.

## Open

- Retention: how many entries or how long.
- Whether an app's own revocation, grant expiry and connections refused for an
  expired grant belong in it.
- Whether host-side `remove-factor` and `reset-passphrase` write to it. They
  run with the state directory locked, so they could.
- What Activity shows at a glance and what sits behind a "more" link.
