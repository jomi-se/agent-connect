# 03 Cache the box image layers

Status: ready-for-agent

Every gate job that needs a box builds it from scratch: the base image, the
curated apt tools and the harnesses. Cache the layers between runs (for
example a registry or exported layer cache keyed on the box's build context),
so a run rebuilds only what changed.

The harness layer must keep floating as
[ADR 0018](../../../decisions/0018-floating-harness-versions.md) decided: a
cache must not hide a new harness release from CI, since CI is how a breaking
harness release gets noticed. Key or expire that layer accordingly.
