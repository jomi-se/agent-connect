# VAL-SESSION-001: Gateway provisions and heals opaque application sessions

Surface: api.
Needs: one online OmniGENT host configured for Codex ACP and a valid fixed
application tool snapshot.
Behavior: an authenticated application creates a logical session without
supplying an OmniGENT id; the gateway provisions and binds the provider runner,
reuses a healthy match for the same origin/app/tool hash, creates a separate
session for a changed snapshot, and transparently replaces an unhealthy runner
behind the same logical id.
Evidence: gateway integration tests with an instrumented provider plus a live
local request showing an opaque public id, a distinct internal OmniGENT id, and
`runner_online: true` without running the manual provision script.
Fail: provider ids appear in the public response, tool changes reuse a fixed ACP
session, an offline runner requires an OmniGENT UI/CLI restart, or two concurrent
creates provision duplicate matching sessions.
Scope: in-process recovery is required; persistence across connector restarts is
deferred and must not be described as implemented.

## Current status

Passed for the implemented in-process boundary on 2026-07-13. A live request to
the new gateway created opaque session `acs_549bf231-…`; OmniGENT independently
recorded internal conversation `conv_e93e3ce6…` with `runner_online: true`. The
opaque session then completed one real Codex `set_page_message` request and
same-turn response. Instrumented provider tests cover healthy reuse, offline
replacement, and provider-id non-disclosure.
