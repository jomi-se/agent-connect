# VAL-JUDGE-002: Judge state and credentials are isolated from personal state

Surface: operator and data.
Needs: VAL-JUDGE-001 and the existing private Serve connector as the comparison
baseline.
Behavior: the judge profile has a distinct connector key/runtime card,
enrollment verifier, devices, grants, OmniGENT database/artifacts, logs, and
workspace lifecycle. No Codex/model credential, personal connector state, host
home or repository bind mount, `.git` history, unrelated source, SSH material,
or Docker socket is present in the judge containers. Only required built
runtime artifacts are copied into image layers.
Evidence: redacted runtime-id/public-key comparison, named-volume and mount
inspection, container environment inspection by variable name only, image
history/layer and build-context inspection, sentinel probes, and absence checks
for known host/private paths without printing secret contents.

Fail: the judge and personal runtime ids match, a private state path or model
credential is mounted/inherited, or the runner can read any named host canary.
Scope: host administrators and the Docker daemon remain trusted; this is not
remote attestation.
