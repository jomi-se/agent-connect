#!/bin/sh
# Builds local OCI archives; never pushes to a registry.
set -eu
cd "$(dirname "$0")/../../.."
build_mode=${1:-all}
case "$build_mode" in all|--runners-only|--native-only|--oci-only) ;; *) echo 'Usage: build-local.sh [--runners-only|--native-only|--oci-only]' >&2; exit 2;; esac
session_version=$(node -p 'JSON.parse(require("fs").readFileSync("deploy/acp-gateway/session/package.json", "utf8")).version')
for pair in aarch64-unknown-linux-musl:arm64 x86_64-unknown-linux-musl:amd64; do
  target=${pair%:*}
  arch=${pair#*:}
  cargo zigbuild --locked --release --bin session-runner --target "$target"
  mkdir -p "dist/session-runners/$arch"
  cp "target/$target/release/session-runner" "dist/session-runners/$arch/session-runner"
done
if [ "$build_mode" = --runners-only ]; then exit 0; fi
if [ "$build_mode" != --native-only ]; then
docker buildx build --platform linux/amd64,linux/arm64 \
  --output "type=oci,dest=dist/agent-connect-session-$session_version.oci.tar" \
  -f deploy/acp-gateway/session/Dockerfile .
fi
if [ "$build_mode" = --oci-only ]; then exit 0; fi

case "$(uname -m)" in aarch64|arm64) local_platform=linux/arm64;; x86_64) local_platform=linux/amd64;; *) exit 1;; esac
docker buildx build --platform "$local_platform" --load \
  -t "agent-connect-session:$session_version" -f deploy/acp-gateway/session/Dockerfile .
