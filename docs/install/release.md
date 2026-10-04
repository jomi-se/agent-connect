# Release process

Gateway **0.0.1** and browser SDK **0.0.10** are unpublished candidates.
[ADR 0016](../decisions/0016-acp-application-boundary.md) was accepted on
2026-10-04; publication still requires explicit owner authorization.
The [manual workflow](../../.github/workflows/release.yml) is the only
approved automated publication path. Ordinary CI is read-only. Agents may
prepare and verify artifacts but never push, publish, run this workflow or
execute npm deprecation.

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

## Manual dry run

After the operator has pushed the reviewable workflow to GitHub, dispatch
**Release candidate** with `dry_run=true`, `publish=false`. Leave `tag` empty
to inspect the selected commit, or provide the matching version tag. Dispatch
does not create a Git ref.

The workflow first verifies the product, then cross-builds both static session
runners and exports the `linux/amd64,linux/arm64` session image as an OCI archive.
It performs no registry login or image push. Each gateway binary embeds the
local image tag through `AGENT_CONNECT_SESSION_IMAGE`; collected metadata is
marked `localOnly`. Install/publish previews use the exact tarballs and
`npm publish --dry-run`.

Download the `session-image-oci-<version>` and `release-<version>` Actions
artifacts, inspect `release.json`, verify `SHA256SUMS`, and review the package
contents and shell installer. The local tag is not available on other machines
until the exported image is imported/tagged there; its presence in a dry-run
binary is intentional. No dry-run artifact is silently promoted to publication.

## First-release setup and publication

The operator must complete these external setup steps separately:

1. Verify that the reviewed source records ADR 0016 as accepted on 2026-10-04.
   The workflow enforces accepted status; the decision does not authorize
   publication by itself.
2. Keep the external GitHub environment name `acp-first-release` unchanged.
   Create it if needed, add the operator as a required reviewer,
   choose the desired self-review policy, and restrict deployment refs to the
   approved version tags. Protect tag creation/movement through repository
   rules. The workflow reads the environment configuration and refuses
   publication if reviewer protection is missing.
3. Configure each npm package's trusted publisher with the actual repository
   owner/name, workflow filename **`release.yml`**, and environment
   **`acp-first-release`**. Allow direct `npm publish`. Arrange package ownership
   and any initial package/bootstrap setup before this run; this workflow does
   not create accounts, alter publisher settings or fall back to an npm token.
4. Ensure the repository's ephemeral `GITHUB_TOKEN` can create the intended
   GHCR package and that the resulting session image is publicly readable for
   installation. Initial GHCR package visibility is an operator-owned setting;
   a successful push alone does not prove anonymous pulls work.
5. Commit and push the approved source and exact `v0.0.1` tag yourself.
   The workflow never pushes commits or creates tags.

Trusted publishing binds OIDC credentials to the specified repository,
workflow and environment; it requires supported GitHub-hosted runners and a
compatible npm CLI. The public packages' repository metadata must match.
See [npm's trusted-publisher setup](https://docs.npmjs.com/trusted-publishers/)
and [GitHub deployment environment protection](https://docs.github.com/en/actions/how-tos/deploy/configure-and-manage-deployments/manage-environments).

Dispatch from that **exact tag**, set `tag=v0.0.1`, `dry_run=false`, and
`publish=true`. The workflow confirms that the tag already exists remotely and
resolves to the dispatched checkout. Conflicting inputs fail before any write.
Review the `verified-local-<version>` candidate before approving the image job.

The protected image job uses only its ephemeral `GITHUB_TOKEN` with
`packages: write` to push the multiarch session image. Its resulting immutable
`ghcr.io/<owner>/agent-connect-session@sha256:<digest>` reference is injected into
**every** native cargo-dist binary build and recorded in `release.json`.
There is no mutable registry tag fallback in a publishable candidate. See
[GHCR authentication with GITHUB_TOKEN](https://docs.github.com/en/packages/working-with-a-github-packages-registry/working-with-the-container-registry).

Review the resulting `release-<version>` artifacts before approving the final
publication job. It repeats the decision/tag checks, verifies artifact hashes,
and invokes `scripts/release.mjs publish` on those exact npm tarballs with
OIDC, `--provenance` and `--tag next`. Only this job receives `id-token: write` and
`contents: write`. No long-lived npm token or model credential is required.

Finally it creates a GitHub **prerelease** with `gh release create --verify-tag`,
attaching the reviewed files. `--verify-tag` prevents the CLI from creating a
missing tag; the workflow additionally verifies the remote tag's commit.
See the [official GitHub CLI command reference](https://cli.github.com/manual/gh_release_create).

Image push, npm publication and GitHub release creation are separate external
writes. If one fails after another succeeds, stop and inspect the published
state before deciding how to resume. Do not automatically reissue an uncertain
publication, move a tag, or replace an already published npm version. After a
successful release, verify anonymous image pulls, platform installations,
package provenance and the `next` dist-tag from the published artifacts.
