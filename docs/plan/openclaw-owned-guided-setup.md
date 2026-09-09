# OpenClaw-owned guided Agent Connect setup

Date: 2026-09-09. Status: proposed implementation contract; plan only.
Owner: next implementation agent. Jose owns pushes, publication and account actions.

## Problem and desired outcome

We shipped a plugin but exposed its implementation as a long operator checklist:
onboard, log in, choose model, clear fallbacks, configure runtime, install plugin,
preview/apply, save phrase, start a bespoke tmux controller, doctor, configure
three routes. Package installation is not a usable onboarding experience.

Agent Connect must be operated **through OpenClaw**, not as a separately managed
binary/process. The existing Artifex controller already launches OpenClaw rather
than a second proxy, but its commands, state selection and lifecycle still make
users operate a second conceptual product. Remove that unnecessary distinction.

Desired existing-user entry:

```sh
openclaw plugins install @open-agent-connect/openclaw-plugin@<published-version>
openclaw agent-connect setup
```

Desired fresh-Artifex entry, after software bootstrap:

```sh
artifex-openclaw onboard
artifex-openclaw agent-connect setup
```

`artifex-openclaw` may remain a transparent pinned-host/profile launcher. It must
not implement a second setup wizard, agent runtime or process manager. A first
release may require native onboarding once; do not promise a single invocation
if upstream cannot safely provide it. The plugin wizard should offer the native
login/onboarding action when needed, then continue or give exactly one next step.

The user should decide only:

- Which existing AI account/model to use, or complete native login.
- How applications reach this host (Tailscale or an existing HTTPS address).
- Whether to enable the described restricted app access.
- Whether a shared OpenClaw restart/start may proceed.
- Save the owner phrase and approve necessary privileged network changes.

No JSON editing, runtime identifiers, repeated preview/apply invocations, manual
port matching, or hidden extra consent steps. Don't equate fewer prompts with
silently granting privileges.

## Evidence and current code (verify against checkout)

- Plugin `packages/openclaw-plugin/src/index.ts` registers `agent-connect setup`
  and `doctor` via `api.registerCli`. Current setup is noninteractive, prints
  JSON, needs `--origin`, and requires a second `--apply` invocation.
- Existing setup calls `api.runtime.config.current()` and supported config
  mutation; `config.ts` supplies inspection, restricted recipe and readiness.
  Retain these core validations as the underlying implementation.
- Plugin lifecycle is already `registerService(start/stop)` and registered host
  HTTP routes. No separate listener or scheduler is needed.
- `host-api.ts` is our narrow type view, not proof a proposed upstream API exists.
  Verify any added prompt/setup/restart API against actual installed public SDK.
- Artifex `/home/dev/artifex-box/bin/artifex-openclaw` currently sets custom
  `OPENCLAW_HOME`, `OPENCLAW_STATE_DIR`, `OPENCLAW_CONFIG_PATH`.
- `bin/artifex-agent-connect-gateway` starts/stops its own tmux session, supplies
  CLI-only port overrides, and can forcibly kill that session after two seconds.
- Pinned OpenClaw2026.9.1 `docs/cli/gateway.md` explicitly says native service
  management belongs to canonical state or named profiles; relocated custom
  HOME/STATE_DIR/CONFIG_PATH layouts are isolated and skipped by service commands.
  This is a real blocker to simply replacing the Artifex wrapper with
  `openclaw gateway start` without changing the fresh-install layout.
- Pinned `docs/cli/plugins.md` documents plugin install/config/enable and notes
  a newly installed plugin can be disabled if required config is missing. Prove
  first-use CLI discoverability; don't test only an already configured plugin.
- Active cleanup is moving shared scoped-runtime code under the plugin. Follow
  current files; do not resurrect deleted standalone gateway code or deployment.

Read AGENTS in Agent Connect and Artifex. During plan authoring both repositories
may have other work in flight. Coordinate, preserve dirty edits, stage only owned
files, and don't create unnecessary worktrees or subagents.

## 1. Settle native host seams with a bounded spike

Before implementing a wizard, inspect the pinned installed public interfaces:

1. How can plugin CLI obtain native prompt helpers? If none are public, use one
   small maintained terminal-prompt dependency or Node primitives inside this
   command, not imports from private bundled OpenClaw filenames.
2. Is there a supported native setup/onboarding contribution that can offer this
   plugin during onboarding? Use it if practical; otherwise defer that extra
   integration and retain install + setup. Don't patch OpenClaw for convenience.
3. How does native provider login work interactively under the same selected
   profile? Can setup delegate safely and resume? Use public APIs or the current
   host executable with an argument array and inherited interactive stdio.
   Never shell-interpolate input, read auth databases or synthesize OAuth itself.
4. What is the supported native service start/restart/status path on this Ubuntu
   VM and in a non-systemd container? Verify named-profile identity, process
   ownership and health; no guessed method names.
5. Can disabling this plugin apply without a full restart? If not, state that
   clearly. A plugin cannot terminate its host and pretend only it stopped.

Record exact public entry points and one disposable, credential-free proof.
Keep this to the APIs above, not a survey of alternative frameworks. If native
service operation is unavailable, use native foreground `gateway run` in an
operator terminal/tmux. Do not quietly rebuild the bespoke controller.

## 2. Interactive setup backed by existing inspection

Refactor CLI presentation from setup decisions and config application. Keep a
small sequence with explicit outcomes, not a generalized workflow engine:

```text
inspect host -> resolve missing choices -> show one proposed change summary
            -> confirm -> apply -> enroll if needed
            -> start/restart if approved -> probe -> ready / exact pending step
```

- No-argument `setup` on a TTY enters the guided flow. Present existing valid
  configuration as defaults; rerun should usually say ready without rewriting it.
- Preserve scriptable preview/apply support. Add explicit noninteractive/JSON
  behavior with useful exit codes. Without a TTY, do not hang or silently apply;
  require complete inputs and explicit consent. Document compatibility for old
  `setup --origin ...` callers rather than changing their preview into a write.
- Inspect supported host version/auth, configured listener port, plugin readiness,
  model availability and native service/profile identity first. Don't dump config.
- Reuse an existing valid model/provider. Show account/provider label without
  tokens; don't perform a paid request as an implicit login check.
- If login is missing, offer native login, with browser/device-code fallback
  suited to a headless VM. Never give a recipe of model JSON commands afterward.
- Choose execution model/runtime through supported policy/config once, applying
  changes only to the app profile where possible. Do not clear personal global
  fallbacks or change the user's default model to accommodate this plugin.
  Existing exact-recipe checks may need a narrow model-selection extension;
  retain server-owned choices and confinement, don't weaken them wholesale.
- Confirm one human-readable summary: app-access profile, denied native tools,
  selected model, address, added settings and whether a host restart is required.
  This setup approval does not authorize an arbitrary future app; per-app OAuth
  consent still exists.
- Apply through supported config mutation. Preserve unrelated agents/plugins,
  native auth and owner settings. Reinspect immediately before writing so stale
  wizard choices don't overwrite changes made during interactive login.
- Generate owner enrollment only when needed. Display the phrase in the private
  interactive terminal once, explicitly ask the owner to save it; don't persist
  plaintext, log it or rotate it on rerun. Losing it remains a deliberate reset
  action, not something the wizard silently fixes.
- On cancellation/error, leave a clearly described recoverable state. Completed
  native login need not be rolled back; don't claim setup is atomic across OAuth,
  filesystem writes and privilege boundaries. Rerun should continue from facts
  on disk, not a custom serialized wizard checkpoint.

## 3. Reachability without Tailscale privileges creep

- Detect Tailscale availability and suggest the device DNS name read-only. Ask
  confirmation; allow ordinary HTTPS input without requiring Tailscale.
- Derive routes from the selected canonical origin and actual configured host
  port. One source for port/config, not a different Artifex CLI-only override.
- Detect conflicting Serve listeners before proposing changes. In particular,
  an existing TLS-terminated TCP443 listener cannot simply coexist with proposed
  HTTPS443 path handlers. Explain exactly which listener changes; preserve all
  unrelated ports/routes. Never use `serve reset` as a shortcut.
- Show one bounded, copyable privileged command block when sudo is needed; offer
  execution only with explicit owner approval and normal interactive sudo.
  No password collection, operator assignment, Funnel, ACL or network-auth changes.
- Ordinary HTTPS means “configure your reverse proxy” guidance and probes, not
  a new certificate/reverse-proxy orchestrator.
- Ensure native owner/API routes are not accidentally exposed without intended
  protection. Reuse the documented reviewed plugin paths and discovery layout.
- Probe local plugin health, public discovery/issuer/resource, and unauthorized
  app rejection without obtaining a grant or calling a model. Distinguish
  “configured locally; ingress pending” from “ready to connect”.

## 4. Lifecycle is OpenClaw's, not Agent Connect's

- Starting/stopping the **whole host** uses native `openclaw gateway ...`
  commands when supported. Stopping only delegation uses native plugin disable
  and its required reload/restart. Explain impact on other host users/tasks.
- Setup may offer one native start/restart after explicit approval. If the host
  is externally supervised, report the supported action for that supervisor;
  don't start a second gateway because a port is busy or native service absent.
- Use native graceful drain/restart semantics, not a two-second forced tmux kill.
  Never print “started/ready” merely because a process or tmux session exists.
  Bound readiness probes and surface the actual sanitized failure.
- Recheck plugin health after restart; config doctor alone is not live readiness.
  Preserve first error causes internally, and don't expose secrets in diagnostics.
- No new `agent-connect start/stop` executable or parallel lifecycle service.
  `agent-connect doctor` remains useful for plugin-specific troubleshooting.

## 5. Artifex becomes a thin installation integration

1. Keep pinned published npm installs and standard bootstrap checks. Don't import
   plugin source, bundle unpublished artifacts or invoke live onboarding during
   noninteractive install/prebuild.
2. Select a native-compatible fresh OpenClaw profile/layout (prefer an explicit
   named Artifex profile if isolation is needed), with compatible native service
   identity. Confirm against upstream before settling the exact name/flags.
   The launcher may select executable/profile; don't export isolated paths that
   make native service commands unusable. Preserve default personal OpenClaw.
3. No old-state migration machinery. Existing custom Artifex state must be
   detected and reported; never silently erase it or log the user into a different
   empty profile without explanation. Jose can approve a fresh reset separately.
4. Remove `artifex-agent-connect-gateway` from the supported workflow. On existing
   installs, only remove its launcher if it is verifiably Artifex-owned. Stop any
   running old instance only during an owner-approved live transition.
5. VM: prefer OpenClaw's own service install/management when owner approves and
   the host supports it. Verify reboot/session persistence prerequisites; don't
   grant sudo rights or enable linger invisibly. Container: no systemd assumption;
   document native foreground execution under the existing terminal environment.
6. Update setup help, README, AGENTS, launchers and runbook together. Fresh setup
   should have one native onboarding entry and one plugin setup entry, not the
   current fifteen-line implementation recipe.

## 6. Focused proof and release gates

Deterministic tests for decisions/output may use prompt adapters. Host behavior
must use real disposable pinned OpenClaw, no modeled CLI/API compatibility:

- Existing configured host: install package, discover setup with missing plugin
  config, complete guided setup, leave personal settings untouched.
- Fresh profile: login-required path hands off to native login; deterministic
  tests don't require a real account or claim live OAuth success.
- Repeat setup, cancel before apply, non-TTY missing input, incomplete reachability,
  model unavailable, stale config before apply and actual startup failure.
- Wrong/busy port and externally managed host don't launch a duplicate process.
- No plaintext passphrase in normal logs, JSON status, fixtures or persisted state.
- Real service/plugin lifecycle proof where supported; no personal host mutation.
- Artifex shell syntax and existing vm/container smoke checks, not full bootstrap
  on the development VM. One owner-driven fresh install after npm publication.

Use quiet-run, narrow checks and no paid automatic smoke. Owner final proof:
complete the guided flow without JSON edits, then connect Bookhand, make one
useful tool call and reload/follow up. Do not auto-approve consent or replay work.

## Ownership, sequencing and stopping points

Implement in bounded commits: native seam evidence; plugin guided setup/tests;
Artifex simplification; operator docs/release metadata. Keep provider-neutral SDK
and Bookhand unchanged unless a concrete contract defect is found.

Do not wait for a perfect graphical wizard, native UI plugin, or every OS. CLI
first, current host version, clear supported fallback. If upstream can't provide
an API, state the limitation and offer one native command—not a silent core patch.

Jose pushes/publishes. Live service, profile reset, sudo/ingress and real login
are explicit owner gates. Planning/implementation doesn't authorize those actions.
Existing release plan remains authoritative for publication and fresh-deployment
deletion gates; this plan supersedes its custom tmux-controller UX only.

Ledger:

- [x] Current pain and native service/custom-state mismatch documented.
- [ ] Public setup/login/lifecycle seams proved against installed host.
- [ ] Interactive plugin setup and script compatibility implemented.
- [ ] Artifex native-compatible fresh layout/lifecycle implemented.
- [ ] Focused package/host/Artifex checks and concise runbook complete.
- [ ] Owner release and fresh end-to-end onboarding acceptance.
