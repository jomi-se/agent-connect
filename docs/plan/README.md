# Plans

Accepted work. Where the project stands is [current work](current-work.md);
defects are in [issues](../issues/) and unaccepted proposals in
[ideas](../ideas/). See [how work is tracked](../agents/issue-tracker.md).

- [Shorter CI without dropping gates](ci-time/spec.md) (in-progress): two
  steps done; measure the warm cache, then concurrent scenarios and cached box
  layers.
- [Require Podman 5 and remove the egress keepalive](require-podman-5.md)
  (ready-for-agent).
- [Pin the box's harness versions, once updating them is painless](harness-pinning/spec.md)
  (needs-triage): a one-step bump and a test battery come first.
- [Qualify the release beyond what CI can prove](release-qualification/spec.md)
  (ready-for-human): real credentials and the native platform matrix.
- [Bind grants to the browser that paired](browser-bound-grants.md)
  (needs-triage): DPoP instead of origin-checked bearer tokens; transport,
  recovery and migration still open.
- [Owner passkeys instead of TOTP](owner-passkeys.md) (ready-for-human):
  waits on accepting ADR 0019.
- [Harness credentials for boxed sessions](credentials.md): implemented; the
  credential model the gateway follows, kept current.
