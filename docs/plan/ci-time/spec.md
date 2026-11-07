# Shorter CI without dropping gates

Status: in-progress

CI runs every gate on every push to main. It used to take 17 minutes, and that
is too long to wait on before a release. Two steps are done:

- Static, Rust, web and gateway checks run as parallel jobs, and a job whose
  inputs were already verified green is reused instead of rerun
  ([repository maintenance](../../guides/repository-maintenance.md)).
- The gateway builds once, with cached Rust dependencies, and uploads the
  release directory with its receipt; four gate jobs download it and run in
  parallel (scenarios, boxed scenarios, the clean room, the owner UI with
  teardown).

The first run with both took 14 minutes on a cold cache: about 8 to build, and
3 to 5 for the gate jobs. The scenarios job is the slowest gate.

What is left, cheapest first:

- [01 Measure a warm-cache run](issues/01-measure-warm-cache.md)
- [02 Run the gateway scenarios concurrently](issues/02-concurrent-scenarios.md)
- [03 Cache the box image layers](issues/03-cache-box-layers.md)
- [04 Shorten the test-only waits](issues/04-shorter-test-waits.md)

No step may drop a gate or weaken what one proves.
