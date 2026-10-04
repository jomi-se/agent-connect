# Release process

Releases are automatic. Every push to `main` runs the
[release workflow](../../.github/workflows/release.yml), which publishes each
package version that is not on npm yet: bump a version in a merged change to
release it. Main only receives commits that passed the required PR checks, so
the workflow does not repeat them. Ordinary CI is read-only. Agents may prepare
and verify artifacts but never push, publish or execute npm deprecation.

## Artifacts and pins

The launcher, platform packages, Rust gateway and session-image manifest share
version 0.0.1. The SDK is independently versioned at 0.0.10. All packages remain
on 0.0.x until the API shape is final. `node scripts/release.mjs check` verifies versions
and adapter pins before building. Adapter versions come from the launcher
manifest and the session-image manifest/lockfile; floating adapter installs are
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

Each archive, shell installation and npm launcher exposes the `agent-connect` CLI.

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
- `release.json` with gateway/SDK versions, targets, adapter pins, image reference and artifact
  hashes, plus aggregate `SHA256SUMS`.

Before producing any npm package, the packer checks all available gateway
archives against the requested version and `--image`. On the host target it
executes `agent-connect release-info` freshly and checks its compiled defaults.
Native CI build runners record the
same checks for foreign targets in `<archive-stem>.release-info.json`, bound to
the target and SHA-256 of the archived executable. The collector rejects
missing, stale or mismatched evidence; copying an image label into `release.json`
is not sufficient. These sidecars are included in release metadata and aggregate
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
./deploy/gateway/session/build-local.sh --native-only
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
--version <version> --image <image-ref>`; native targets run directly. Missing
execution support fails the build before packing. It embeds the explicitly local session-image tag and
sets `release.json.localOnly = true`. These are acceptance artifacts, not
publishable candidates. The clean-room gate installs the packed launcher/SDK
and sample into a fresh container and exercises the real adapter using a
deterministic provider. It uses no subscription login or personal model key.
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

CI prepares this local image and release directory before `npm run verify:full`,
then runs Rust tests and lint/dependency-boundary checks. A passing synthetic
acceptance run does not establish live subscription quality or authorize a
release.

## Publication

The workflow compares `packages/web-sdk` and `packages/gateway-npm` versions
with npm and runs only what is missing:

- **SDK:** packs `@open-agent-connect/web`, smoke-tests the exact tarball and
  publishes it.
- **Gateway:** pushes the multiarch session image with the job's ephemeral
  `GITHUB_TOKEN`, injects its immutable
  `ghcr.io/<owner>/agent-connect-session@sha256:<digest>` reference into every
  native cargo-dist build, packs the launcher and platform packages with
  `release.json`, then publishes platform packages before the launcher. A
  package version already on npm is skipped, so rerunning a partly failed
  release resumes it.

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
4. The session image package on GHCR is public. A new GHCR package starts
   private, so after the first image push change its visibility and confirm an
   anonymous `docker pull` works.

See [npm's trusted-publisher setup](https://docs.npmjs.com/trusted-publishers/)
and [GHCR authentication with GITHUB_TOKEN](https://docs.github.com/en/packages/working-with-a-github-packages-registry/working-with-the-container-registry).
