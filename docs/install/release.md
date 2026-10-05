# Release process

Releases are automatic. Every push to `main` runs the
[release workflow](../../.github/workflows/release.yml), which publishes each
package version that is not on npm yet: bump a version in a merged change to
release it. Main only receives commits that passed the required PR checks, so
the workflow does not repeat them. Ordinary CI is read-only. Agents may prepare
and verify artifacts but never push, publish or execute npm deprecation.

## Artifacts and pins

The launcher, platform packages, Rust gateway and box manifest share
version 0.0.1. The SDK is independently versioned at 0.0.10. All packages remain
on 0.0.x until the API shape is final. `node scripts/release.mjs check` verifies versions
and adapter pins before building. Adapter versions come from the launcher
manifest and the box manifest/lockfile; floating adapter installs are
not release inputs.

The build-tool installer pins Rust `1.98.1`, cargo-dist `0.33.0`,
cargo-zigbuild `0.23.4` and Zig `0.14.1`. CI uses Node `24.15.0` and the publishing
job uses npm `11.19.1`. The cargo-dist binaries are downloaded from the pinned
upstream release and checked against recorded SHA-256 values. This installer
requires GitHub runner environment files and does not configure an operator's
personal toolchain.

The explicit native matrix is:

| Runner             | Gateway target               |
| ------------------ | ---------------------------- |
| `macos-14`         | `aarch64-apple-darwin`       |
| `ubuntu-24.04`     | `x86_64-unknown-linux-musl`  |
| `ubuntu-24.04-arm` | `aarch64-unknown-linux-musl` |

The npm launcher exposes the `agent-connect` CLI. Native archives are build inputs.

Cargo-dist produces target archives, SHA-256 checksums and the global shell
installer. npm packaging is owned by `scripts/release.mjs`, avoiding a
second cargo-dist npm installer. Local and CI builds remap Rust source paths
for the checkout, Cargo dependencies and toolchain to neutral build prefixes;
distributed executables must not contain personal builder paths. The collection contains:

- `@open-agent-connect/web`;
- `@open-agent-connect/gateway` and its three platform packages;
- three native gateway archives, checksum sidecars and hash-bound executable
  `release-info` evidence;
- the shell installer and the standalone `acp-chat-sample.tgz`;
- `release.json` with gateway/SDK versions, targets, adapter pins and artifact
  hashes, plus aggregate `SHA256SUMS`.

Before producing any npm package, the packer checks all available gateway
archives against the requested version. On the host target it
executes `agent-connect release-info` freshly and checks its compiled version.
Native CI build runners record the
same checks for foreign targets in `<archive-stem>.release-info.json`, bound to
the target and SHA-256 of the archived executable. The collector rejects
missing, stale or mismatched evidence. These sidecars are included in release metadata and aggregate
checksums. Their trust comes from the selected build workflow artifacts; they
are hash-bound build evidence, not independent cryptographic signatures.

The manually authored workflow uses cargo-dist's local/global artifact split
and SHA-256/archive settings. Its `ci = []` disables generated release automation;
it never calls cargo-dist hosting/publication commands. See the official
[cargo-dist configuration](https://axodotdev.github.io/cargo-dist/book/reference/config.html)
and [CI customization](https://axodotdev.github.io/cargo-dist/book/ci/customizing.html)
references.

## Local candidate and CI verification

On a supported **Linux** developer host with the pinned build tools, Node 24 and Docker,
the credential-free acceptance sequence is:

```sh
npm ci
node scripts/release.mjs check
node scripts/build-release-local.mjs
npm run verify:full
cargo test --locked --workspace
```

The local builder packages the host target; `--all-linux` packages both Linux
targets when supported. A cross-target local build must execute the foreign
Linux binary through QEMU when recording its evidence; no validation is skipped.
Use `AGENT_CONNECT_RELEASE_RUNNER_X86_64` or `AGENT_CONNECT_RELEASE_RUNNER_ARM64` to select an
isolated runner executable, or provide `qemu-x86_64`/`qemu-aarch64` on PATH.
The helper is `node scripts/release-info.mjs record --target <target>
--version <version>`; native targets run directly. Missing
execution support fails the build before packing. It sets `release.json.localOnly = true`. These are acceptance artifacts, not
publishable candidates. The launcher contains the shared box context;
platform packages contain the matching static Linux runner (Linux ARM64 on macOS).
The clean-room gate installs the packed launcher/SDK
and sample into a fresh container and exercises the real adapter using a
deterministic provider. Setup builds the box from the installed files. It uses no subscription login or personal model key.
The native WebMCP/provider gates install their separate compatibility pins.
The extended artifact driver also exercises no-mutation JSON setup planning,
explicit unattended setup/reruns with synthetic owner credentials, doctor JSON,
owned offline service definition lifecycle, owner live-session ending and
revoke-all. It verifies setup/service operations preserve private state and do
not invoke provider login. Disposable Linux containers lack a running desktop
user manager: offline definition checks and actionable unsupported-manager
errors are not native macOS launchd acceptance evidence.
The artifact-only driver currently requires Linux temporary paths and a Linux
platform package. The sequence above is not a macOS verification command:
Apple Silicon native installation and public-artifact composition remain part
of the first real release check, although macOS is in the release build matrix.

CI prepares the release directory before `npm run verify:full`,
then runs Rust tests and lint/dependency-boundary checks. A passing synthetic
acceptance run does not establish live subscription quality or authorize a
release.

Test/dev box builds and owner layers use unique `agent-connect-box-test:*` tags, clean them up on success and failure, and never build, retag or remove `agent-connect-box:*`.
`npm run verify` builds this checkout's shared test box once and passes `ACP_BOX_IMAGE` to its gates; standalone box consumers require that variable.

## Publication

The workflow compares `packages/web-sdk` and `packages/gateway-npm` versions
with npm and runs only what is missing:

- **SDK:** packs `@open-agent-connect/web`, smoke-tests the exact tarball and
  publishes it.
- **Gateway:** builds native binaries for three targets and static Linux
  session-runners for x64/ARM64, packs the launcher and platform packages with
  `release.json`, then publishes platform packages before the launcher. Setup
  builds the box locally from these packages. A package version already on npm
  is skipped, so rerunning a partly failed release resumes it.

npm publication uses trusted publishing (OIDC) with `--provenance` on the
`latest` dist-tag; only the publishing jobs receive `id-token: write`. No
long-lived npm token, git tag or GitHub release is involved. Never replace an
already published npm version; fix forward with a new version.

## One-time setup

1. The GitHub environment **`release`** exists and only accepts deployments
   from `main`.
2. npm can only attach a trusted publisher to an existing package. Reserve each
   new package name (for example a new platform package) by publishing an empty
   `0.0.0` placeholder by hand, then deprecate it after its first real release.
3. Each npm package's trusted publisher names this repository, workflow
   **`release.yml`** and environment **`release`**, with direct publishing
   allowed. Dist-tag management is not needed.

See [npm's trusted-publisher setup](https://docs.npmjs.com/trusted-publishers/).
