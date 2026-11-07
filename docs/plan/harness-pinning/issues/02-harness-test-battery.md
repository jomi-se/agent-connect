# 02 A battery of tests that the bump runs by itself

Status: needs-triage

The bump runs, without anyone asking, the tests that show whether each harness
still behaves the way the gateway relies on:

- permission requests reach the gateway's profiles (the 0.101.0 failure);
- app tools, cancellation and resume;
- the boxed and clean-room gates;
- an opt-in real-model canary. The deterministic model cannot exercise a
  harness's own model calls, such as Claude Code's auto-mode classifier, which
  fails closed against it.

Most of this exists as CI gates. The work is running it against the bumped
versions, per harness, and adding checks for anything the gateway relies on
that no gate asserts yet.
