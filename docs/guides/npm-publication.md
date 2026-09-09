# npm publication gate

Agent Connect prepares two exact package tarballs together:

- `@open-agent-connect/web@0.0.4` (already published; CI skips it)
- `@open-agent-connect/openclaw-plugin@0.0.2` (current candidate)

`npm run release:prepare` builds, packs, inspects, and records SHA-256 digests in
`dist/npm-release/manifest.json`. `npm run release:smoke` installs and exercises
those exact tarballs. Neither command publishes. The successful main-branch CI
job independently queries each declared package version, skips an existing
version, and publishes only an absent version from the same inspected tarball.
Any registry failure other than a real 404 fails the job.

The packages require Node 24 for release preparation. The plugin uses stock
OpenClaw 2026.9.1 as its exact tested build while allowing newer hosts, and
retains its public `/agent-connect` namespace and plugin ID `agent-connect`. It
is a fresh setup path, not a credential or state migration.
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
2. In each package's npm settings, confirm GitHub Actions trusted publishing
   has these exact claims:
   - organization/user: `jomi-se`
   - repository: `agent-connect`
   - workflow filename: `ci.yml` (filename only)
   - environment: `npm-publish`
   - allowed action: direct `npm publish`
3. The packages now exist publicly: the registry returned SDK `0.0.4` and plugin
   `0.0.1` on 2026-09-09. The earlier first-plugin manual bootstrap is complete
   and must not be repeated for `0.0.2`.
4. Inspect the current bindings before changing them. A binding to the retired
   `publish-web-sdk.yml` workflow does not authorize `ci.yml`; do not guess or
   revoke an unknown binding. With npm CLI 11.19.1 or newer, the equivalent
   plugin command is:

   ```sh
   npm trust github @open-agent-connect/openclaw-plugin --repo jomi-se/agent-connect --file ci.yml --env npm-publish --allow-publish
   ```

   `npm trust list @open-agent-connect/openclaw-plugin` can confirm the binding.
   Trust configuration requires interactive authentication/2FA.

5. Push the reviewed commits. Successful main CI must skip the already-published
   SDK `0.0.4` and publish only the absent plugin `0.0.2`; a later rerun must skip
   both. Verify npm version, integrity and provenance before authorizing the
   Artifex config/pin/ingress commit and live phase.

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
