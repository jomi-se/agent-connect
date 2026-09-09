# Archived plan: stock OpenClaw vertical-slice closeout

Date: 2026-09-08. Branch: `work/openclaw-scoped-proxy`.

## Outcome

Close the implemented stock OpenClaw scoped-proxy slice with source review,
truthful packaging and a final owner-run Bookhand acceptance smoke. This is a
proof-and-handoff pass, not another architecture campaign. The supported path is
the separately built scoped proxy in front of an integrity-pinned, unmodified
OpenClaw gateway. The parent native patch and older replacement engine remain
historical experiment/rollback material and are not dependencies of that build.

No step grants host shell, broadens the policy, replays a possibly mutating
application call, changes Tailscale Serve, captures credentials, or performs a
model request automatically. Restart-durable conversation ownership, faithful
human-chat attribution, owner-login polish and sandbox improvements remain
deferred.

## Closeout sequence

1. Review the bounded grant-scoped conversation list/history/reopen code and its
   tests. Fix only demonstrated correctness or security defects.
2. Reconcile current sources of truth and deployment/build guidance: distinguish
   the supported stock scoped proxy from the preserved native-patch and custom
   replacement experiments; record that current history is in-memory and its
   projection labels every native user entry as prompt-or-application-output.
3. Run `verify:scoped-proxy` with the pinned Node/OpenClaw runtime plus relevant
   package/type checks. Record exact evidence and packaging blockers without
   mass-deleting historical material.
4. Report the reviewed commit and build readiness before touching the live
   proxy. After explicit authorization, restart only the scoped proxy with its
   existing private launcher, then verify public metadata/health and that the
   new history route is authenticated. Do not restart stock OpenClaw or change
   ingress/authentication.
5. Hand off the owner-run phone smoke and record each result in the acceptance
   ledger below. Only owner evidence can close the live model/UI gates.
6. Commit the clean scoped changes. The owner's later decision below authorizes
   a local fast-forward merge after the main CI checks and documentation review.
   Coordinate Bookhand with its owning agent. Do not push, publish, retire live
   services or rewrite shared history as part of this local merge.

## Review and verification ledger

- [x] History ownership, head fencing, refresh/revocation and bounded projection
      reviewed.
- [x] No automatic replay and no cross-grant/private-session disclosure found.
- [x] Canonical documentation and default packaging guidance reconciled.
- [x] `npm run verify:scoped-proxy` passed with the repository pins.
- [x] Relevant typecheck/package checks passed.
- [x] Reviewed commit/build readiness reported before live restart.
- [x] Authorized proxy-only restart completed; stock OpenClaw and Serve unchanged.
- [x] Metadata/health passed and unauthenticated history route failed with an
      authorization response rather than `404`.

## Final owner phone smoke

Preconditions: use the already served Bookhand build recorded in its private
project evidence; obtain fresh consent because tool descriptions changed. A
proxy restart intentionally loses the current in-memory conversation registry,
so create a new conversation after restart.

1. Open the same book, authorize the displayed origin and freshly reviewed tool
   descriptions, then ask for one explicit, minimal, useful read-only browser
   action and finish the agent turn. Observe the requested action and do not
   repeat a possibly completed action after an interruption; grant consent is the
   approval boundary, so there is no per-call approval prompt.
2. Reload Bookhand. Confirm the same-book conversation is restored automatically
   (there is no list or picker UI) and verify the history is shown as an execution
   history. Native inputs must be labelled **Input (prompt or application
   output)**, never **You**.
3. Ask a contextual follow-up whose answer depends on the completed first turn.
   Confirm it continues using the restored completed head and does not replay the
   earlier browser tool action.
4. Choose **New conversation**, reload, and confirm the Tutor remains blank. Do
   not spend another model turn merely to re-prove the deterministic fresh-head
   behavior.

## Owner acceptance ledger

### Owner decision: accepted prototype for main, 2026-09-08

José reported that the connection/conversation-follow-up flow works and explicitly
authorized cleanup and local merge to main, accepting remaining rough edges.
This is product acceptance of the bounded vertical slice, not a claim that every
individual phone check below was separately observed. Unconfirmed checks remain
recorded for follow-up rather than being silently marked passed. No push,
publication, live service retirement or shared-history rewrite is implied.

Known open defects from this same live session:

- Bookhand search indexing stopped with an unstable anchor in Section 2 of the
  deliberately difficult EPUB. The generic tool message incorrectly implied
  indexing was still preparing.
- Navigation repeatedly supplied mutually exclusive fields despite improved
  descriptions. The installed OpenClaw outbound conversion removes the schema's
  top-level `oneOf`; descriptions alone have not demonstrated a fix.
- That run hit the configured 90-second timeout, while Bookhand displayed an
  unhelpful unknown-error diagnosis. No failed navigation was replayed.

These remain Bookhand/provider follow-ups, not evidence that search, navigation,
or error reporting passed. The user accepted proceeding with the integration
despite them.

| Gate                   | Required evidence                                                      | Status        |
| ---------------------- | ---------------------------------------------------------------------- | ------------- |
| Fresh consent          | Current origin and revised tool descriptions were shown and accepted   | Pending owner |
| New completed turn     | One turn completed on the post-restart Bookhand/proxy composition      | Pending owner |
| Reload restore         | Same-book reload automatically restored the recent execution history   | Pending owner |
| Contextual follow-up   | Follow-up used prior context without application-tool replay           | Pending owner |
| Fresh conversation     | Explicit New conversation omitted prior context                        | Pending owner |
| Minimal browser action | One useful read-only requested action was observed; no replay occurred | Pending owner |

Passing automated tests, health checks, or a historical live chat do not satisfy
these owner-observed gates. The owner decision above authorizes the local merge
despite incomplete fine-grained smoke evidence. Live Omnigent retirement and
external publication remain separate actions.

## Progress

- 2026-09-08: closeout plan created. Source review, verification, documentation
  reconciliation and live readiness report completed. Reviewed source commit
  `97c69d6`; no history authority/replay defect was found. Fixed one test-only
  tuple inference typecheck blocker from the preceding request-size change.
- 2026-09-08: pinned Node 24.15.0/OpenClaw 2026.9.1
  `verify:scoped-proxy` passed: scoped build, 23 focused tests, four published
  stock fixture tests, one stock OAuth/tool/history continuation integration and
  one AI SDK composition. Focused gateway typecheck also passed.
- 2026-09-08T10:52:10Z: after the reviewed readiness report and explicit
  authorization, restarted only the existing scoped-proxy process. External and
  loopback health returned `200`, protected-resource metadata returned `200`,
  and the unauthenticated conversations route returned `401`, not `404`. No model
  request, credential change, OpenClaw restart or ingress change was performed.
- 2026-09-08: owner accepted the prototype and authorized local mainline merge;
  individual phone checks above remain unconfirmed. Push, publication and live
  service retirement remain separate decisions.
- Mainline verification passed the root verification stages (including pinned
  stock OpenClaw), packaged SDK consumer, all 14 WebMCP cases, Canvas browser
  tests, lint and dependency boundaries. The initial full run exposed a Zod
  dynamic-code probe under strict CSP; the corrected SDK uses its public
  `jitless` configuration before dependency initialization. Focused SDK tests,
  typecheck, package consumption and the complete WebMCP suite passed afterward.
  Local verification used ARM Chromium at the pinned version, not hosted x86 CI.
