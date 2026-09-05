# Deferred: reuse existing gateway components

Status: potential idea, not an accepted migration. Finish proving the Bookhand
tutor experience first. Recorded 2026-09-05 at the user's request.

Agent Connect exists to bring the user's existing AI subscription into third-party
applications. It need not own authentication, provisioning or credential lifecycle
machinery where existing components can do the job with less operational burden.

OpenClaw is a candidate to investigate, not a selected replacement. Its
[gateway protocol](https://docs.openclaw.ai/gateway/protocol) already includes
authentication, device pairing, scoped tokens and trusted-proxy/Tailscale access.
Other established components may be smaller fits. Chat-channel access alone is
not equivalent to authorization for an arbitrary website: identifying the owner
and allowing a particular application to use that owner's agent are different.

Preserve the product boundary: harness-neutral app SDK, approved page tool
snapshot, bounded Open Responses interface and application-session separation.
Question ownership of custom enrollment, runtime provisioning, credential
management and recovery mechanisms. Existing code is not a reason to retain them.

Later investigation should be bounded and answer: what code and operational
responsibility could we actually delete? Compare app-specific authorization,
subscription reuse, deployment burden and adapter costs. Do not add a second
gateway stack merely to rename the same complexity. Do not assume the candidate
already supports our browser-tool direction or exact session semantics.

Concrete lesson: Omnigent's native Codex integration links machine auth into an
isolated home, while our custom ACP launch path used a stale credential copy.
Reuse existing mechanisms before inventing another lifecycle.

Success means fewer maintained components and fewer user setup steps, not a
larger abstraction layer. No replacement work is authorized by this note.
