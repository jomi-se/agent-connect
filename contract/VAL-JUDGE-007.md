# VAL-JUDGE-007: Operators can observe, restart, and destroy the judge profile

Surface: operator.
Needs: VAL-JUDGE-001 through VAL-JUDGE-006 and documented Compose/Funnel
commands.
Behavior: health checks distinguish gateway, OmniGENT server, and host status;
security-relevant logs omit passphrases, bearer tokens, prompt bodies, and
private key material; Compose restart/recreate preserves connector identity and
revocation while replacing disposable runner state; an operator can stop
Funnel and the stack, revoke grants, and run a rehearsed teardown against
disposable test state. The final runbook schedules destruction of judge
credentials/state after judging ends at 2026-08-06 00:00 UTC.
Evidence: exact start/status/log/restart/stop/teardown commands and outputs,
pre/post runtime-id and revocation comparison, tmpfs replacement canary,
redacted log scan, Funnel disabled probe, a disposable teardown drill with
volume/secret absence, and the separately documented final teardown command.

Fail: restart silently changes connector identity, logs expose a secret,
disposable workspace survives its declared lifecycle, or public ingress remains
after the kill/teardown command.
Scope: backup/key recovery beyond the judging window is not required for this
disposable profile.
