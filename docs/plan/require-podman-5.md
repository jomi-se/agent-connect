# Require Podman 5 and remove the egress keepalive

Status: ready-for-agent

The gateway runs a keepalive container beside the egress on Podman
(`keepalive_name` in `crates/gateway/src/sandbox.rs`). It exists only because
Podman 4 tears down the shared rootless network when the last session
disconnects the egress from it ([ADR 0020](../decisions/0020-container-engines.md),
decision 6). Nothing an owner installed is kept compatible before 1.0, so the
workaround should go rather than carry Podman 4 along.

1. On Podman 5, confirm that the network survives the egress leaving the last
   session network without the keepalive. If it does not, stop here and record
   why.
2. Remove the keepalive and its tests.
3. Setup and `doctor` refuse Podman 4, saying which version they found and
   that 5 is required.
4. Remove the Podman 4 notes from the install docs (the 4.9 test floor, the
   layer copy across id mappings) and amend ADR 0020's decision 6.

Check the two Podman defects after this lands:
[stale session network](../issues/podman-stale-session-network.md) and
[box never reaches the egress](../issues/podman-box-never-reaches-egress.md).
Both were seen only on Podman 4.9.
