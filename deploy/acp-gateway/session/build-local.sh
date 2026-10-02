#!/bin/sh
# Builds local OCI archives; never pushes to a registry.
set -eu
cd "$(dirname "$0")/../../.."
for pair in aarch64-unknown-linux-musl:arm64 x86_64-unknown-linux-musl:amd64; do
  target=${pair%:*}
  arch=${pair#*:}
  cargo zigbuild --locked --release --bin session-runner --target "$target"
  mkdir -p "dist/session-runners/$arch"
  cp "target/$target/release/session-runner" "dist/session-runners/$arch/session-runner"
done
docker buildx build --platform linux/amd64,linux/arm64 \
  --output type=oci,dest=dist/agent-connect-session-0.1.0.oci.tar \
  -f deploy/acp-gateway/session/Dockerfile .

case "$(uname -m)" in aarch64|arm64) local_platform=linux/arm64;; x86_64) local_platform=linux/amd64;; *) exit 1;; esac
docker buildx build --platform "$local_platform" --load \
  -t agent-connect-session:0.1.0 -f deploy/acp-gateway/session/Dockerfile .
