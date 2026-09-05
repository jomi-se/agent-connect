# OC-SCR-004: terminal publication after cancellation

Targets: VAL-OC-002, VAL-OC-003. Source finding in `responses/engine.ts` mediate.

After the final held function event is yielded, pause the consumer, revoke its
grant or cancel the chain, then call `next()` again. The terminal event containing
the function call is yielded without another authorize check. Recheck authority
after that yield boundary and add a focused generator-pause regression. This is
an Agent Connect-owned race, not a provider compatibility assertion.

Resolved during review: W1 added authorize immediately before terminal yield.
Fresh build plus `node /tmp/openclaw-scrutiny-terminal-probe.mjs` exits 0 and
observes `response_cancelled` after revocation during the last held-event pause.
