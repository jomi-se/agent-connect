# npm publication gate

Agent Connect has two explicit public release candidates:

- `@open-agent-connect/web@0.0.4`
- `@open-agent-connect/openclaw-plugin@0.0.1`

`npm run release:prepare` builds, packs, inspects, and records SHA-256 digests in
`dist/npm-release/manifest.json`. `npm run release:smoke` installs and exercises
those exact tarballs. Neither command publishes. The successful main-branch CI
job independently queries each declared package version, skips an existing
version, and publishes only an absent version from the same inspected tarball.
Any registry failure other than a real 404 fails the job.

The packages require Node 24 for release preparation. The plugin supports stock
OpenClaw 2026.9.1 and retains its public `/agent-connect` namespace and plugin ID
`agent-connect`. It is a fresh setup path, not a credential or state migration.
The web SDK exposes the OAuth/PKCE, Open Responses, continuation, application
tool, saved-connection, and bounded conversation helpers described in the
[web integration guide](web-app-integration.md).

## Owner checklist

No agent performs these steps. Jose reviews the commits, owns the npm account and
GitHub environment, pushes, and handles interactive 2FA or approval.

1. Reconfirm the GitHub `npm-publish` environment. Read-only inspection on
   2026-09-08 found that it exists with no protection rules, required reviewers,
   or deployment-branch policy, so it does not currently add a manual approval
   gate. Do not weaken a later policy just to make a run pass.
2. In the SDK's npm settings now, and in the plugin's settings after its
   one-time bootstrap, configure GitHub Actions trusted publishing with these
   exact claims:
   - organization/user: `jomi-se`
   - repository: `agent-connect`
   - workflow filename: `ci.yml` (filename only)
   - environment: `npm-publish`
   - allowed action: direct `npm publish`
3. For the existing SDK, inspect the current binding before changing it. The old
   manual workflow was `publish-web-sdk.yml`; a binding to that filename will not
   authorize `ci.yml`. Add the new binding if npm permits it, or deliberately
   replace the old one. Do not guess or revoke an unknown binding.
4. The plugin package does not yet exist in the public registry. npm's current
   trust CLI requires a package to exist, so the first CI run may publish the SDK
   and then fail at the plugin. After that exact pushed revision passes checks,
   prepare the candidates from that revision and bootstrap only the plugin with
   interactive npm authority:

   ```sh
   npm ci
   npm run release:prepare
   npm run release:smoke
   npm publish dist/npm-release/open-agent-connect-openclaw-plugin-0.0.1.tgz --access public
   ```

   Compare the printed/recorded digest before publishing. This one-time bootstrap
   is not a permanent manual release path. Never unpublish or overwrite it.

5. Configure the plugin's `ci.yml` trusted publisher after it exists. With npm
   CLI 11.19.1 or newer, the equivalent interactive command is:

   ```sh
   npm trust github @open-agent-connect/openclaw-plugin --repo jomi-se/agent-connect --file ci.yml --env npm-publish --allow-publish
   ```

   `npm trust list @open-agent-connect/openclaw-plugin` can confirm the binding.
   Trust configuration requires interactive authentication/2FA.

6. Rerun the failed main workflow. It must skip the existing plugin and publish
   only any still-missing SDK version; a later rerun must skip both. Verify npm
   versions, integrity, and provenance before authorizing the Artifex live phase.

This checklist follows npm's current
[trusted publishing](https://docs.npmjs.com/trusted-publishers/) and
[`npm trust`](https://docs.npmjs.com/cli/v11/commands/npm-trust/) guidance. It
uses GitHub-hosted runners, Node 24.15.0, npm 11.19.1, `id-token: write` only in
the publish job, no static npm token, and exact repository metadata. The local
npm CLI at preparation time was 11.9.0 and did not yet expose `npm trust`; the CI
pin and checklist therefore use 11.19.1.

Read-only GitHub inspection also confirmed that `jomi-se/agent-connect` is a
public, unarchived repository whose default branch is `main`, so npm provenance
is eligible. `npm owner ls @open-agent-connect/web` reports `jomi-se` as the SDK
owner. The npm trusted-publisher settings themselves require authenticated npm
access and remain an explicit owner check.
