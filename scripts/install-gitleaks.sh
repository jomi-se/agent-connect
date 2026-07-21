#!/bin/sh
set -eu

version=8.30.1

case "$(uname -s):$(uname -m)" in
  Linux:x86_64 | Linux:amd64)
    platform=linux_x64
    checksum=551f6fc83ea457d62a0d98237cbad105af8d557003051f41f3e7ca7b3f2470eb
    ;;
  Linux:aarch64 | Linux:arm64)
    platform=linux_arm64
    checksum=e4a487ee7ccd7d3a7f7ec08657610aa3606637dab924210b3aee62570fb4b080
    ;;
  Darwin:x86_64 | Darwin:amd64)
    platform=darwin_x64
    checksum=dfe101a4db2255fc85120ac7f3d25e4342c3c20cf749f2c20a18081af1952709
    ;;
  Darwin:arm64 | Darwin:aarch64)
    platform=darwin_arm64
    checksum=b40ab0ae55c505963e365f271a8d3846efbc170aa17f2607f13df610a9aeb6a5
    ;;
  *)
    echo "Unsupported platform for the pinned Gitleaks installer: $(uname -s) $(uname -m)" >&2
    exit 1
    ;;
esac

repo_root=$(git rev-parse --show-toplevel)
git_dir=$(git -C "$repo_root" rev-parse --absolute-git-dir)
install_dir=${GITLEAKS_INSTALL_DIR:-$git_dir/agent-connect-tools}
target=$install_dir/gitleaks

if test -x "$target" && test "$("$target" version)" = "$version"; then
  echo "Gitleaks $version is already installed at $target"
  exit 0
fi

for command_name in curl tar; do
  if ! command -v "$command_name" >/dev/null 2>&1; then
    echo "$command_name is required to install Gitleaks." >&2
    exit 1
  fi
done

temp_dir=$(mktemp -d "${TMPDIR:-/tmp}/agent-connect-gitleaks.XXXXXX")
cleanup() {
  rm -rf -- "$temp_dir"
}
trap cleanup EXIT HUP INT TERM

archive=$temp_dir/gitleaks.tar.gz
url="https://github.com/gitleaks/gitleaks/releases/download/v$version/gitleaks_${version}_${platform}.tar.gz"
curl --fail --location --silent --show-error --output "$archive" "$url"

if command -v sha256sum >/dev/null 2>&1; then
  printf '%s  %s\n' "$checksum" "$archive" | sha256sum -c -
elif command -v shasum >/dev/null 2>&1; then
  actual_checksum=$(shasum -a 256 "$archive" | awk '{print $1}')
  if test "$actual_checksum" != "$checksum"; then
    echo "Gitleaks archive checksum verification failed." >&2
    exit 1
  fi
else
  echo "sha256sum or shasum is required to verify Gitleaks." >&2
  exit 1
fi

tar -xzf "$archive" -C "$temp_dir" gitleaks
mkdir -p "$install_dir"
cp "$temp_dir/gitleaks" "$target"
chmod 0755 "$target"
echo "Installed Gitleaks $version at $target"
