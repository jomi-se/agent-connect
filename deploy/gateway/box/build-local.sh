#!/bin/sh
# Produce static Linux runners. Setup builds the box from the packed npm context.
set -eu
cd "$(dirname "$0")/../../.."
CARGO_ENCODED_RUSTFLAGS=$(node scripts/release-build-env.mjs)
export CARGO_ENCODED_RUSTFLAGS
case "${1:---runners-only}" in --runners-only) ;; *) echo 'Usage: build-local.sh [--runners-only]' >&2; exit 2;; esac
mkdir -p target/distrib
for pair in aarch64-unknown-linux-musl:arm64 x86_64-unknown-linux-musl:amd64; do
  target=${pair%:*}
  arch=${pair#*:}
  cargo zigbuild --locked --release --bin session-runner --target "$target"
  cp "target/$target/release/session-runner" "target/distrib/session-runner-linux-$arch"
done
