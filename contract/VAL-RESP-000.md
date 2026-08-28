# VAL-RESP-000: Omnigent can retain a run and fail it deterministically

Surface: provider integration, process lifecycle.
Needs: isolated Omnigent 0.5.1 services and the deterministic ACP agent.
Behavior: one Omnigent run survives a detached public stream, accepts two
sequential application outputs on separate HTTP connections, treats a repeated
resolved output as a no-op, and reaches completion. Explicit cancellation
reaches a parked run. If the real Omnigent server process dies while a run is
parked, the live gateway resolves the chain to `interrupted`, stops offering
its unresolved call, and rejects continuation with `backend_unavailable`
instead of hanging or replacing the provider session.
Evidence: `packages/gateway/test/omnigent-real.integration.test.ts` exercises
the retained-run spike, the gateway cancellation path, and real Omnigent
process death inside an isolated process fixture. Run with
`npm run test:integration:omnigent`.
Fail: a detached stream destroys the run, sequential calls require another
provider session, cancellation remains only local, provider death hangs, or a
dead run is reported as live or silently replaced.
Scope: the provider snapshot does not contain a parked application call. The
gateway ledger remains the sole durable authority for that call.

## Current status

Passed on 2026-08-28 against Omnigent 0.5.1, including real server-process
death while a chain was parked.
