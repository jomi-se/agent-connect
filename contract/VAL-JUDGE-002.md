# VAL-JUDGE-002: The disposable judge appliance is isolated from personal state

Surface: operator and data.
Needs: VAL-JUDGE-001 and the existing private Serve connector as the comparison
baseline.
Behavior: the judge profile has a distinct connector key/runtime card,
enrollment verifier, devices, grants, OmniGENT database/artifacts, logs, and
workspace lifecycle. No Codex/model credential, personal connector state, host
home or repository bind mount, `.git` history, unrelated source, SSH material,
or Docker socket is present in the judge appliance. Only required built runtime
artifacts are copied into image layers. The appliance runs as non-root with a
read-only root filesystem, dropped capabilities, `no-new-privileges`, resource
bounds, disposable tmpfs workspaces, and only its gateway port published on
host loopback.
Evidence: redacted runtime-id/public-key comparison, named-volume and mount
inspection, container environment inspection by variable name only, Compose
configuration, and `docker inspect`. A concise manual pre-exposure checklist is
acceptable for image/mount/environment review; an exhaustive hostile runtime
probe suite is deferred.

Fail: the judge and personal runtime ids match, or a private state path or model
credential is mounted or inherited.
Scope: host administrators and the Docker daemon remain trusted; this is not
remote attestation. Processes inside the disposable appliance are not isolated
from one another, so compromise of one may compromise all judge-profile state.
Because cookies are hostname-scoped rather than port-scoped, public testing
uses a clean browser profile until the public appliance receives a distinct
hostname.
