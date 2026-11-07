# 04 Shorten the test-only waits

Status: needs-triage

The `*-cut`, `expire` and `overflow` scenarios wait 8 to 17 seconds each for
timeouts to pass. Shorter test-only timeouts would save time, but each
scenario exists to prove timeout behaviour, so a shorter wait must still
exercise the same code path and the same ordering. Decide per scenario whether
the time can shrink without making the proof weaker or the test flaky.
