# Published packages and fresh Artifex deployment

Date: 2026-09-08. Status: prepared through the owner publication gate; not permission to publish.
Owner: next Sol implementation agent; Jose owns all pushes and account approvals.

## Objective and non-negotiable decisions

Replace the VM's dependency on an archived development checkout with a normal
published-package installation managed by `artifex-box`:

```text
Jose pushes reviewed version bumps to main
  -> CI checks the pushed revision
  -> CI publishes unpublished SDK/plugin versions

artifex-box bootstrap
  -> pinned published OpenClaw + published Agent Connect plugin
  -> fresh operator setup and subscription login
  -> Bookhand uses the published SDK and connects through HTTPS
```

- Plugin npm name: `@open-agent-connect/openclaw-plugin` (owner confirmed).
- SDK npm name remains `@open-agent-connect/web`.
- Keep plugin ID `agent-connect` for this release; its rename was discussed,
  not approved. Display name may be clarified as “Agent Connect for OpenClaw”.
- Fresh installation. **Do not migrate old provider credentials, owner identity,
  grants, conversations, configuration or refresh tokens.** No migration framework.
- Source repositories are not deployment prefixes or runtime state directories.
- Jose pushes. No agent git push, release/tag creation on GitHub, npm publish,
  publication-trigger dispatch, or account/permission changes.
- Implement and locally commit preparation; stop at the owner publication gate.
  Resume deployment after Jose confirms publishing and authorizes execution.
- The obsolete runtime directory must ultimately be deleted, not renamed again.
  Do not delete the currently required runtime before the new installation works.
- No unrelated authentication redesign, plugin-ID migration, UI redesign,
  sandbox feature, schema work, provider upgrade or general deployment framework.

## Starting evidence and source map

Recheck status/AGENTS in each repo before editing; preserve others' work.

Agent Connect: `/home/dev/agent-connect`, main, implementation SDK `e3fa090`,
live migration checkpoint `f94decc`, cleanup `1f5f106`.

- `packages/web-sdk/package.json`: public SDK currently `0.0.3`, repository
  metadata and prepack build already present; CSP-safe initialization matters.
- `packages/openclaw-plugin/package.json`: currently private
  `@agent-connect/openclaw-plugin@0.1.0`; bundled ESM entry, manifest, optional
  exact OpenClaw peer and two pinned OpenClaw runtime dependencies.
- `scripts/build-stock-openclaw-plugin.mjs`: bundles shared gateway code,
  externalizes public OpenClaw imports; generates sourcemap. Inspect published
  map contents for machine paths/source leakage rather than blindly shipping it.
- Root `pack:stock-openclaw-plugin` hardcodes the old workspace name. Find all
  active install/test/docs references and update; historical evidence can retain
  its clearly labeled original name.
- `.github/workflows/publish-web-sdk.yml`: manual SDK-only, environment
  `npm-publish`, OIDC permission, npm `11.19.1`, Node22; republishes workspace
  rather than the exact inspected tarball. Replace/supersede this path.
- `.github/workflows/ci.yml`: push/main and PR checks, pinned Actions, Node24.15,
  `verify:full`, lint and dependency checks. Current `verify:full` does not
  explicitly include `test:openclaw:plugin-host`; do not assume it does.
- `scripts/smoke-web-sdk-package.mjs`, `scripts/openclaw-plugin-host-stock.test.mjs`,
  `scripts/install-ci-test-tools.sh`: reuse actual installed-package evidence.
- `config/openclaw-test-compat.json`: OpenClaw2026.9.1, Node>=24.15 and<25,
  integrity pin. Do not opportunistically bump upstream during this task.
- `deploy/openclaw-gateway/README.md`, `docs/architecture/stock-openclaw-plugin.md`:
  existing plugin setup/doctor, endpoint namespace and operating limitations.

Artifex: `/home/dev/artifex-box`, main at inspection, clean.
Read its AGENTS fully. `setup.sh` is the authoritative idempotent bootstrap;
named steps are supported. `vm` is UbuntuARM64; `container` includes x86/Codespaces
without systemd. Follow existing user-local installs, tmux and privilege model.
Update README and AGENTS for bootstrap changes; run `scripts/smoke-check.sh`.

Bookhand: `/home/dev/bookhand`, main, SDK integration `ea3b18e`.
`origin` is `jomi-se/bookhand-next`; `judged` is original `jomi-se/bookhand`.
Never publish/change the judged repository or deployment. CDX2 owns Bookhand:
coordinate any dependency update rather than concurrent edits. Current SDK is a
provenance-pinned local tarball, with a required AI SDK continuation patch.

Private operational context is in `.agent-connect/plugin-cutover/HANDOFF.md`
(ignored). Read only when preparing the live phase, never paste secret files.
The obsolete live tree is `.agent-connect/openclaw-host`; current launcher is
`.agent-connect/plugin-cutover/openclaw.sh`. There is no migration requirement.

## Phase 1 — Release-ready packages

1. Verify npm versions/ownership read-only; distinguish a genuine missing version
   from network/auth/registry failure. Propose SDK `0.0.4` and plugin `0.0.1` if
   those versions are unpublished; otherwise choose the next appropriate version.
2. Rename plugin package to the confirmed scope, remove `private:true`, add public
   publishConfig, license/repository directory/homepage and appropriate Node engine.
   Retain public host imports and explicit compatibility pins.
3. Make packaging reproducible from a clean checkout. Ensure prepack or the shared
   release build produces the plugin bundle, not an accidental stale dist. Avoid
   recursive build/pack lifecycle calls. Update lockfile, workspace commands,
   artifact-name assumptions and installed-package tests.
4. Bump SDK version with its lockfile entries. No provider API changes required.
5. Inspect both packed file lists: bundle/types/manifest/license/docs present;
   no `.env`, live paths, private config, debug credentials or checkout dependency.
   Check that plugin dependencies resolve when installed outside the monorepo.
6. Write brief release/install notes: plugin namespace `/agent-connect`, supported
   host version, fresh setup, SDK helpers, and remaining process-local history.

Exit: two clean packable release candidates, correct names/versions and no npm
publication. Treat package contents—not only source imports—as the release unit.

## Phase 2 — Automatic publication after successful main CI

Prefer a small extension of existing CI, not a release-management framework:

- Add a `publish` job to main CI with `needs: checks`. It runs only on
  `push` to `refs/heads/main` after the exact revision passes required gates.
  PRs and manual CI dispatch must never publish. No tag is required.
- Ensure the installed stock-plugin composition gate is part of those checks,
  once per run. Keep credential-free inference fixtures; no model allowance.
- Publisher uses the same exact SHA, pinned compatible Node/npm and pinned
  Actions. Build and pack candidates from that SHA; smoke-test/inspect and publish
  the **same tarballs**, not a later implicit workspace repack.
- For each explicit package, inspect registry presence of its declared version.
  Published -> skip; unpublished -> publish public with provenance. Registry
  failures must fail, not masquerade as “version absent”. Changed source without
  a version bump does not republish or automatically increment anything.
- Package selection is an explicit two-package list, not all workspaces.
  Use `npm-publish` environment and OIDC (`id-token:write`) only in publisher;
  no static credential fallback. No write permissions for repository contents.
- Serialize publication runs without cancelling an in-progress publish. Support
  reruns after partial success: one existing version must not prevent publishing
  the other. Never unpublish/overwrite a version to repair a release.
- Remove the old manual SDK publication path or convert it to pack-only so it
  cannot bypass main-CI gates. Avoid duplicate publishers triggered by both tags
  and pushes. Do not create release tags automatically in this slice.
- Log package/version/outcome and tarball digest, not tokens or entire envs.

Owner/account gate: inspect current official npm Trusted Publishing guidance and
the actual repository configuration before finalizing. Configure/document the
required repository/workflow/environment binding for **each** package. Changing
workflow filename may invalidate the existing SDK binding. A new package may
require a one-time owner bootstrap before OIDC can be configured; verify this,
do not assume either that automatic first publication works or that it cannot.
If bootstrap is needed, give Jose the exact artifact and minimal commands after
checks pass. This one-time exception is not a permanent manual release workflow.

Do not change branch protection, npm organization access or environment reviewer
policy unasked. Explain any owner setting that prevents fully automatic releases.

Exit: workflow changes committed, deterministic skip/fail/partial-rerun checks,
and a precise owner checklist. **Jose must push; agent stops here for publication.**

## Phase 3 — Artifex installation and operations (prepare before publication)

Add a bounded named bootstrap step and operator runbook, not a second gateway:

1. Use standard user-local paths outside repositories. Prefer a versioned
   install prefix under `~/.local/share/artifex/openclaw/` with a launcher under
   `~/.local/bin`; keep config/state separate using documented OpenClaw locations
   or explicit standard user config/state paths. Document exact chosen paths.
   No working-directory dependency, npm link, file: tarball, cloned upstream,
   archived runtime, or relative import back to Agent Connect.
2. Pin published OpenClaw and plugin versions in tracked Artifex configuration.
   Resolve packages from npm, enforce the Node compatibility range, and use
   OpenClaw's supported plugin installation/explicit capability-consent flow.
   If the new plugin version is not published, fail actionably—never fall back
   to the local development tarball in the operational installer.
3. Keep install distinct from enrollment/login/start. Installing packages must
   not silently start a service, spend subscription tokens, create a Tailscale
   endpoint, or write provider credentials. Ordinary users should follow the
   same documented fresh setup path as Jose.
4. Use the supported OpenClaw owner/provider authentication flow interactively.
   No copying from prior OpenClaw or Codex homes. Owner sees the one-time plugin
   passphrase directly; don't pipe it into quiet-run logs, source files or chat.
5. Preview then apply plugin setup; run doctor. Preserve default denial of native
   tools for the app profile. Select the intended subscription model explicitly
   so an upstream default cannot silently select an unconfigured paid provider.
6. Prefer Artifex's existing tmux operational pattern for this first version:
   documented start/status/stop/restart, foreground gateway under tmux, stable
   launcher path. No unrelated systemd/linger/autostart project. Document that
   reboot requires restart unless a separately approved existing mechanism owns it.
7. Bind loopback and expose through explicit owner-reviewed Tailscale Serve,
   using the existing TLS-terminated ingress approach if still appropriate.
   Keep OpenClaw-managed Tailscale off; do not grant operator rights, change ACLs,
   enable Funnel, or reset unrelated routes. Owner handles required sudo.
8. Re-runs are safe: don't overwrite existing accounts/config or re-enroll on
   every bootstrap. This deployment starts fresh, but the installer must not
   erase an ordinary user's pre-existing installation. Refuse conflicts with a
   clear next step rather than improvising backup/migration code.
9. Preserve ARM64/x86 and vm/container separation. Add smoke coverage for step
   selection and shell syntax; no real auth/install/network mutations in smoke.
   Installation may be explicitly opt-in; authentication and service startup
   must be. Record that choice clearly in bootstrap help and README.

Exit: committed Artifex bootstrap and runbook, runnable from fresh state using
published packages after publication. No hidden dependency on this VM's archive.

## Phase 4 — Post-publication fresh VM installation (owner-gated)

After Jose pushes and confirms npm releases, verify exact versions/integrities
from registry. Obtain owner go-ahead to execute live installation; do not infer
that a successful local pack satisfies this gate.

- Install through Artifex's committed path, from npm, into fresh operational state.
- Jose performs provider login and owner enrollment/consent normally. Stop for
  owner input rather than read passwords, copy tokens or approve on their behalf.
- Verify exact package/host versions, plugin doctor, HTTPS discovery, protected
  scoped endpoint, and native endpoint authentication. Test configuration doesn't
  accidentally turn the user endpoint into an unauthenticated operator endpoint.
- Coordinate CDX2 to replace Bookhand's vendored SDK dependency with the exact
  published SDK version; preserve the continuation patch and update provenance/
  packaging assertions. A published package alone doesn't remove that patch.
- Owner starts a fresh Bookhand connection. Old browser credentials are expected
  to fail; disconnect/reconnect normally, not a credential migration feature.
- Ask for one useful tool result and follow-up/reload confirmation. Don't replay
  an old mutation. Separate owner-reported evidence from deterministic tests.

## Phase 5 — Delete the obsolete runtime, genuinely

After the new deployment works, re-resolve exact paths and process dependencies.
Stop any obsolete process. Check launchers, service definitions, symlinks, config,
environment path references and package install provenance for old checkout roots.
Use checks that report matching filenames/keys, not secret values. Also remove
obsolete test Serve routes only if explicitly included in the reviewed cleanup.

Delete `/home/dev/agent-connect/.agent-connect/openclaw-host` once nothing uses
it. Owner has explicitly said its old credentials/grants are not needed. Do not
create another private runtime archive or copy its secrets into the new deployment.
Remove obsolete local cutover launchers and secret-bearing rollback backups once
their exact scope is reviewed; keep only a sanitized final operational record.
Don't delete other `.agent-connect` data, Bookhand books, the judged repo, or the
independent EPUB project. Report exact removed paths and recovery implications;
erasing the old state is intentional and may be irreversible.

## Verification budget, commits and handoff

- Use quiet-run; detach slow checks. No new agent fan-out needed. Read focused
  hunks, not credential files or entire logs. Format once at stabilization.
- Package changes: external SDK consumer + real installed plugin fixture with
  deterministic inference, relevant build/typecheck. Reuse those as CI gates.
- Workflow logic: bounded published/unpublished/registry-failure/partial-success
  fixtures; PR cannot publish. Real npm authorization remains owner/CI evidence.
- Artifex: bash syntax and existing smoke-check; fresh-prefix installer proof
  after packages exist. One real owner flow at the end, not repeated paid runs.
- Commit coherent code+docs per repo: release/package+CI; Artifex bootstrap;
  Bookhand published dependency later; final sanitized deployment evidence.
- Keep this ledger current at each gate. Finish with commit IDs, test evidence,
  exact next owner action, and what is intentionally not done. Never push.

## Execution ledger

- [x] Fresh-state approach and package name approved; Jose owns pushes.
- [x] Current publication, package and Artifex entry points inspected for this plan.
- [x] Release metadata/versions and package evidence. Registry check: SDK
      versions `0.0.1` and `0.0.3` exist; SDK `0.0.4` is absent. The confirmed
      plugin URL returns public HTTP 404, so `0.0.1` is available. Exact-tarball SDK
      and plugin external-install smoke tests pass. Two consecutive clean packs
      produced identical SHA-256 digests: SDK
      `ec4bd3711f5003fd6db78a43c4e4a28a3b50f29c9a8fa4d0c34499676d0d58b7` and
      plugin `6d1299865dbaa12f82c03f6ce80fa0196c6f39a51f2c0c1d4ff13525707e10cf`.
      The owner-selected initial public plugin version is `0.0.1`.
      Release-logic tests pass; real plugin composition remains in the repository
      verification gate.
- [x] Automatic gated dual publication and npm owner setup checklist. Main
      `ci.yml` now publishes only after `checks` on a main push, uses exact inspected
      tarballs and independent version skip logic, and cannot publish from PR or
      manual dispatch. The obsolete manual SDK publisher is removed. See
      `docs/guides/npm-publication.md` for the first-plugin bootstrap and exact OIDC
      claims. Read-only GitHub API evidence confirms the public `main` repository
      and an existing `npm-publish` environment with no protection rules. npm trust
      settings require authenticated npm access and remain an owner verification.
- [x] Artifex fresh-install bootstrap/runbook and smoke evidence. The adjacent
      repository includes a default binaries-only bootstrap step, pinned public
      dependencies, isolated config/state, stable launchers, tmux operations and
      route-limited owner-reviewed Tailscale instructions. Its shell/profile smoke
      passes. Before publication the installer fails actionably at the plugin
      registry check and creates no fallback installation.
- [ ] Jose pushes / npm publication verified (external gate).
- [ ] Fresh installation / owner login / Bookhand published SDK and live smoke.
- [ ] Obsolete runtime deleted; final docs/commits/clean worktrees.

### Owner publication gate reached

Preparation commits: Agent Connect `2bb6003`; Artifex `e36f4b2`.
Owner-requested corrections: initial plugin version `0.0.1` in Agent Connect
`3b922b2`; default Artifex bootstrap installation and matching pin in `2f852f3`.
After the first main push, CI exposed an overly specific stock-package provenance
assertion: the integrity-checked installer intentionally gives npm a local copy of
the canonical tarball, so npm records a `file:` resolution. The gate now accepts
that deterministic filename or the canonical URL while still requiring the exact
version and pinned integrity.
The following main run exposed a separate startup race in the installed-plugin
composition gate: health became ready immediately before a brief service
reinitialization, so the first OAuth metadata request received transient
`503 initializing`. Initial metadata discovery now waits through that explicit
startup state; steady-state status and response assertions remain strict.
That rerun then found the legacy scoped-proxy verifier had independently encoded
the same canonical-URL-only assumption. The compatibility pin now owns the local
archive filename used by the integrity-checking installer, and both provenance
gates accept exactly the canonical URL or that verified local resolution.

Final local evidence: `npm run verify`, `npm run analyze`, the Canvas Playwright
suite, release-logic tests, exact-tarball SDK/plugin smokes, dynamic plugin
artifact resolution, formatting and diff checks all pass under the pinned Node
24.15/OpenClaw 2026.9.1 tools. Artifex shell/profile smoke passes. The WebMCP
pinned native-Chrome gate was not rerun on this ARM64 VM because its installer
deliberately requires Linux x64; `verify:full` remains mandatory in main CI
before the publish job can run.

No push, tag, GitHub release, npm publication, workflow dispatch, account change,
provider login, service start, Tailscale mutation, Bookhand change, or old-runtime
deletion was performed. Jose's next action is to review the local commits and
follow `docs/guides/npm-publication.md`. Phase 4 must not begin until the exact
npm versions/integrities are verified and Jose separately authorizes the live
Artifex installation.
