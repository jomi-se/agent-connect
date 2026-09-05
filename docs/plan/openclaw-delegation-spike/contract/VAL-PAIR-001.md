# VAL-PAIR-001: Device-style app authorization

Surface: api.
Needs: isolated real OpenClaw with owner-installed prototype plugin.
Behavior: an originless caller requests access as an unverified installation;
pending/denied callers cannot execute; only authenticated owner approval permits
its credential to execute; revocation blocks later requests. Publisher verification
is optional and never inferred from a submitted name or metadata URL.
Evidence: real HTTP owner/client traces, no owner credential in client replies;
pending, unauthorized approval, denial, approval and revocation outcomes.
Scope: feasibility API ceremony, not shipped mobile/browser UI or persistence.
