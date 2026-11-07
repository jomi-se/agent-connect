# 03 A cheap merge, and a failure that names what changed

Status: needs-triage
Blocked by: 01, 02

A bump that passes should take one action to land. A bump that fails should
say which harness and which behaviour changed, for example "claude-agent-acp
0.101.0: permission request never reached the profile", not only a red gate
with a log to dig through.
