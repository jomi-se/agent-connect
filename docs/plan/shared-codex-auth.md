# Shared machine login, isolated runtime home

Status: implementation complete; live migration and Bookhand retry pending.
No live credential mutation/restart or push.

User requirement: bring the machine's existing subscription into third-party apps.
Keep the externally triggered Codex home separate, but share authentication. Do
not require a second login or copy a refresh token into a permanently stale home.

Evidence: agc runs deploy/real-gateway/run.sh. Its CODEX_HOME points at
.omnigent-spike/live-e2e-codex-home with an old standalone auth.json. Installed
Omnigent 0.5.1 native codex_executor.py uses an auth.json symlink and copies config
separately. Our custom ACP wrapper bypasses that native setup. Adopt the same
file-sharing pattern, without claiming new cross-process refresh guarantees.

Contract:

- VAL-AUTH-001: launcher resolves an explicit AGENT_CONNECT_CODEX_AUTH_HOME
  (default machine ~/.codex before HOME isolation), links only auth.json into a
  distinct runtime CODEX_HOME, leaves source config/history unchanged. Reject
  missing source, canonically identical homes (including aliases), or unexpected
  destination credentials clearly.
- VAL-AUTH-002: no silent overwrite/copy fallback. Existing regular auth requires
  explicit operator migration; any replacement must be recoverable and secret
  values never printed. Stop runtime writers before explicit migration; refuse
  directories/unexpected links, back up without collisions and restore on link
  failure. Existing correct link is idempotent. Tests use dummy files
  to prove source refresh/replacement visible through link and write-through.
- VAL-AUTH-003: reference docs/config stop directing users to a second login.
  Small helper tests and shell syntax/launcher wiring check suffice; no model run.
  Live migration/restart waits for explicit approval.

Integration detail: this ACP adapter applies CODEX_CONFIG at thread creation,
not app-server startup. Enforce file credential storage at the actual Codex CLI
boundary as well; a thread-only override cannot establish the startup guarantee.

Implemented in scripts/link-codex-auth.mjs and scripts/codex-file-auth.sh, wired
through deploy/real-gateway/run.sh. Five dummy-file/CLI tests cover sharing,
refusals, recoverable migration and startup arguments; test:codex-auth is included
in verify. Bounded independent code review found no remaining actionable defect.
No full suite or model run was needed for these launcher/helper changes.

Live handoff: after approval, stop the personal agc runtime and its children,
migrate its existing standalone auth file explicitly, then restart the same
launcher. Preserve gateway identity, grants, public card and private routes.
Bookhand then retries its normal tutor flow. Until that succeeds, dummy-file
tests prove the wiring only, not a repaired live provider session.

Judging cleanup completed: obsolete profile/container/service absent, no public
Funnel configured. Closed the empty agc-demo tmux shell after confirming it had
no children. Preserved personal agc, .agent-connect/real-connector, its
grants/identity, all private Serve routes and currently referenced spike paths.
No data files were deleted. Historical docs are not running deployments.
