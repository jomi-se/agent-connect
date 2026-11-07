# Pin the box's harness versions, once updating them is painless

Status: needs-triage

Today the box takes the latest release of each harness when it is built, as
[ADR 0018](../../decisions/0018-floating-harness-versions.md) decided, and owners
can pin versions in `versions.json`. CI is the early warning when a harness
release breaks something, and that warning depends on timing.

claude-agent-acp 0.101.0 started Claude Code sessions in auto mode. Auto mode's
classifier answered permission requests itself, so the gateway's Claude
profiles stopped applying. CI caught it only because a push happened to build
a box twenty minutes after the release. The box now forces Claude Code's asking
mode with managed settings, but the next upstream change of that kind will
also land unannounced.

Pinning moves that risk to a step we choose. It is only worth it if moving the
pins is quick and painless; until then the versions keep floating and CI keeps
paying the price of finding things. Pinning needs, in order:

- [01 One step that finds and bumps new harness releases](issues/01-one-step-update.md)
- [02 A battery of tests that the bump runs by itself](issues/02-harness-test-battery.md)
- [03 A cheap merge, and a failure that names what changed](issues/03-cheap-merge.md)
- [04 Pin, and supersede ADR 0018](issues/04-pin-and-supersede-adr-0018.md)

Owners keep `versions.json` to move ahead of, or back from, the pins.
