# VAL-AUTHORITY-001: App authority reaches native enforcement

Surface: api and data.
Needs: isolated proxy-identity configuration and native scoped session provisioning.
Behavior: app A can continue its session; app B cannot access it; application
requests cannot select a different agent or gain admin through body/headers.
Native session stores the intended app creator and any configured required-sandbox
stamp. A failed or unavailable sandbox does not silently execute host tools.
Public ingress exposes only plugin app/approval paths; forged proxy identity
headers cannot reach native Responses or private provisioning through it. The
private provisioner must not be nested under the exposed public prefix.
Evidence: real cross-app/routing/scope denial traces, persisted creator/policy
before and after Responses, execution or fail-closed sandbox evidence. Report
source-only findings separately; plugin checks alone do not prove native checks.
Also prove route-limited external ingress rejects native/private paths, including
requests carrying forged identity headers. A disposable allowlisting proxy can
stand in for deployment ingress; that does not prove actual Tailscale settings.
