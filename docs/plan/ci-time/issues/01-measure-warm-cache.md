# 01 Measure a warm-cache run

Status: needs-info

The first run with the Rust cache had nothing cached. The next push that
changes the gateway's inputs, without changing the toolchain, lockfile or mise
tools, should rebuild only this repository's crates. Expected: about 9 to 10
minutes in total.

Record the build job's time and each cargo build's. If the whole run is still
over 10 minutes, look at what compiling our own crates in release mode costs
(profile settings, LTO, codegen units) before the other tickets.

Also check one docs-only push: every job should be reused and the run should
finish in about a minute.
