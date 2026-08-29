# Open Responses re-review: verifying the 2026-08-28 dispositions

- Review date: 2026-08-29
- Target: `main` at `069f1c5`, including `1a051d6` and `069f1c5`
- Method: each prior finding was reproduced independently rather than read off
  the regression test that claims to cover it
- Companion probe:
  [`support/2026-08-29-open-responses-probe.test.ts.txt`](support/2026-08-29-open-responses-probe.test.ts.txt)

## How to reproduce every finding in this document

The probe is written so that **each test asserts the desired behavior**. Tests
that pass confirm a prior finding is genuinely fixed; tests that fail are the
open findings, and the failure message is the reproduction.

```sh
git checkout 069f1c5
npm ci
cp docs/reviews/support/2026-08-29-open-responses-probe.test.ts.txt \
   packages/gateway/test/zz-review-probe.test.ts
npx vitest run --root packages/gateway zz-review-probe --disable-console-intercept
rm packages/gateway/test/zz-review-probe.test.ts   # keep `npm run verify` green
```

Expected on `069f1c5`: **4 failed | 4 passed**, with this console output.

```text
[H-NEW a] drained="TIMEOUT" response=in_progress chain=running
[H-NEW b] next request=response_busy hasLiveChain=true
[M-NEW-1] continuation=rejected/response_cancelled submitted=[{"token":"p1","output":"done"}]
[M-NEW-2] files=["c1.json","c2.json"] outcome=Cannot load response state /tmp/ac-review-corrupt-XXXXXX/c2.json
[B1] firstFailed=true phantomVisible=false second=ok
[B2] drained=["response.in_progress","response.incomplete"] response=cancelled chain=terminal
[B4] pending=[]
[B3] events=response.created,response.in_progress,error,response.failed resource={"status":"failed","error":{"code":"backend_protocol_error","message":"harness exploded"}}
```

The probe deliberately uses no test seam that the fix under review introduced:
the B1 reproduction denies writes with a real `chmod(2)` on the state directory
rather than the injectable `durableWrite` option, and the cancellation
reproductions use a backend that emits nothing on cancel, which is what real
Omnigent is documented not to promise.

Two findings are established by inspection rather than by probe, and each
carries its exact command below.

## Verdict

The 2026-08-28 dispositions hold. B1, B2, B4 and H1 through H6 are genuinely
fixed, not merely made to pass, and B3 was correctly rejected — that finding was
wrong, and this review withdraws it.

One blocker remains, and it is the same defect as H5 surviving on a different
code path: `requestCancellation`, the path taken when a browser disconnects, was
not given the engine-owned cancellation that `cancelChain` received.

## Resolution status

Resolved on 2026-08-29 by the implementation pass following this review:

- the HTTP-disconnect path marks cancellation before interrupting the provider
  and terminalizes the retained run without waiting for an Omnigent event;
- continuation delivery rechecks cancellation after persisting the canonical
  output and before contacting the provider;
- unreadable chain files are preserved under `.corrupt-*`, reported with their
  original and quarantine paths, and no longer prevent healthy state loading;
- the existing route-level failed non-streaming test now says
  `stream: false` explicitly; and
- `npm run verify` now includes the deterministic real-Omnigent suite.

Fresh evidence includes an actual HTTP response-body disconnect against real
Omnigent while the deterministic ACP agent is delayed. The chain becomes
terminal/cancelled and the provider session stops running. The findings below
remain the historical evidence that motivated these changes.

## Confirmed fixed

| Finding                                                 | Evidence                                                                                                                                                                                                                                                                                                                                           |
| ------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| B1: one I/O error poisoned all writes                   | Probe `[B1]`. A real `chmod 0500` on the state directory makes the first `putChain` throw; `getChain` then returns `undefined`, so no phantom state is readable; after restoring the mode the next write succeeds. `file-store.ts:146` stops retaining a rejection as the queue tail, and `this.index(file)` moved after `durableWrite` at `:144`. |
| B2: a later tool call could resurrect a cancelled chain | Probe `[B2]`. A cancel of a busy segment against a backend that emits no cancellation event terminates the stream as `response.incomplete`, the response as `cancelled`, and the chain as `terminal`. `engine.ts:721-725` coerces a non-terminal transition, and `engine.ts:382` checks `cancelRequested` before `next.done`.                      |
| B4: a dead run could redeliver a side effect            | Probe `[B4]`. `pendingFunctionCalls` returns `[]` after `killTransport`, with no priming `describeChain` call — the omission that made the original regression test pass for the wrong reason. `engine.ts:534` is a real liveness check.                                                                                                           |
| H1: capability refresh raced rehydration                | `sed -n '347,355p' packages/gateway/src/gateway.ts` shows `await responseSessionsReady` on the `/v1/app-sessions` branch, matching `:228` and `:423`.                                                                                                                                                                                              |
| H2: snapshot escape laundered as transport failure      | `sed -n '453,463p' packages/gateway/src/responses/engine.ts` shows the catch preserving an engine-raised `backend_protocol_error`.                                                                                                                                                                                                                 |
| H3: stream EOF treated as success                       | `sed -n '388,400p' packages/gateway/src/responses/engine.ts` shows `next.done` producing a failed response.                                                                                                                                                                                                                                        |
| H4: any first event recorded `provider_observed`        | `grep -n 'observeCallResult' packages/gateway/src/responses/engine.ts` shows the transition only under `text.delta`, `tool.call`, and `completed`.                                                                                                                                                                                                 |
| H5: busy cancellation could hang                        | `omnigent-real.integration.test.ts:777` is honest evidence: a 5 s `AGENT_CONNECT_DETERMINISTIC_PROMPT_DELAY_MS`, cancel fired on the first SSE event, asserting `chain_status: terminal`, `response.incomplete`/`cancelled`, and that the provider session left `running`. `FakeBackendRun.cancel()` no longer invents an event.                   |
| H6: Omnigent posts had no deadline                      | `omnigent-response-backend.ts:210` shares an `AbortSignal.any`, with a wedged-transport test at `omnigent-response-backend.test.ts:7`.                                                                                                                                                                                                             |

### B3 is withdrawn

The original finding claimed a non-streaming failed response should not be HTTP 200. The rejection is correct and the finding was wrong.

```sh
python3 -c "import json;d=json.load(open('contract/open-responses/openapi.json'));print(list(d['paths']['/responses']['post']['responses'].keys()))"
# ['200']
```

The pinned contract declares no error responses for `POST /responses` at all,
and `ResponseResource.status` includes `failed`. Probe `[B3]` confirms the
drained resource carries `{"status":"failed","error":{...}}`. Returning non-2xx
would have been the deviation from the standard, not conformance to it.

## Blocker

### H-NEW: the disconnect cancellation path still waits for a provider event

`packages/gateway/src/responses/engine.ts:582-588`, called from
`packages/gateway/src/response-routes.ts:154`.

```ts
async requestCancellation(responseId: string): Promise<void> {
  const response = await this.store.getResponse(responseId);
  if (!response) return;
  const state = this.active.get(response.chainId);
  if (!state || !state.busy) return;
  await state.run.cancel().catch(() => {});   // and nothing else
}
```

It never sets `cancelRequested` and never terminalizes, so it does exactly what
`cancelChain` was fixed to stop doing. The comment justifying that fix, at
`engine.ts:566`, applies verbatim to this function:

> Cancellation is an engine-owned decision. Omnigent does not promise a
> follow-up cancellation event, so waiting for one can hang the open segment.

**Reproduction.** Probe tests `H-NEW a` and `H-NEW b`.

```text
[H-NEW a] drained="TIMEOUT" response=in_progress chain=running
[H-NEW b] next request=response_busy hasLiveChain=true
```

`H-NEW a` starts a response against a backend that emits nothing after start —
a harness still thinking — and calls `requestCancellation`, which is what the
route's socket-`close` handler does. The generator never terminates, the
response stays `in_progress`, and the chain stays `running`. In the real route
this leaks the handler, the generator, the retained Omnigent run, and the
`close` listener, because `response-routes.ts:165` never returns.

`H-NEW b` shows the user-visible consequence. `state.busy` and `liveRun` both
stay true, so `requireNoLiveChain` rejects every subsequent request from that
application session with `response_busy`. Reloading the page does not clear it.
The chain is not terminal, so recovery reports nothing wrong. Only a gateway
restart recovers.

Two things make this a blocker rather than a footnote.

It is the common path. Closing a tab or navigating away reaches
`requestCancellation`; only the explicit cancel button reaches `cancelChain`.
The well-tested path is the rarer one.

It has no test coverage at all:

```sh
grep -rn requestCancellation packages/gateway/src packages/gateway/test
# packages/gateway/src/response-routes.ts:154   (call site)
# packages/gateway/src/responses/engine.ts:582  (definition)
```

The real-Omnigent cancellation scenario exercises `POST .../cancel`, not
disconnect.

The fix is the shape already proven correct: set `state.cancelRequested = true`
and let the existing terminalization run.

## Medium

### M-NEW-1: cancelling during a continuation still posts the output

`packages/gateway/src/responses/engine.ts:174-181` checks `cancelRequested`
only after `deliverOutput` has already returned.

**Reproduction.** Probe test `M-NEW-1`.

```text
[M-NEW-1] continuation=rejected/response_cancelled submitted=[{"token":"p1","output":"done"}]
```

The client is told the chain was cancelled, the ledger records
`delivery_attempted`, and the harness received the output anyway. In the
opposite interleaving the run is already closed and `submitOutput` throws, so
the same race surfaces as `backend_unavailable` — one race, two public error
codes. Checking `cancelRequested` before the post narrows this to the genuinely
ambiguous window where the post is already in flight.

### M-NEW-2: the M1 fix turned silent chain loss into a total gateway outage

`file-store.ts:150-164` now throws from the constructor. `gateway.ts:128`
constructs the store inside `createGateway`, and `main.ts:15` does not catch.

**Reproduction.** Probe test `M-NEW-2`.

```text
[M-NEW-2] files=["c1.json","c2.json"] outcome=Cannot load response state /tmp/ac-review-corrupt-XXXXXX/c2.json
```

One truncated chain file beside a healthy one prevents construction. In
production that is an unhandled exception at startup: the whole gateway — OAuth,
grants, every route — refuses to boot because a single response chain is
unreadable, with no quarantine path and no documented operator remedy.

Failing loudly was the right correction to M1. Failing fatally and globally, on
a single-user personal gateway with no operator, is the over-correction.
Renaming the file to `.corrupt`, logging the path, and continuing to serve
achieves the loudness without the outage.

### M-NEW-3: `stream: false` still has no end-to-end coverage

```sh
grep -rn 'stream: false' packages/gateway/test
# packages/gateway/test/responses-profile.test.ts:50
# packages/gateway/test/responses-profile.test.ts:77
# packages/gateway/test/responses-profile.test.ts:138
```

All three are request parsing. Probe `[B3]` exercises the drain loop by hand and
the behavior is correct, but nothing in the suite asserts it, and the
`if (!resource) throw` branch at `response-routes.ts:128` is never reached.

Because B3 was rejected on the grounds that the non-streaming resource contract
is the standard's contract, that contract is now load-bearing and needs a test
that would fail if the drain, the resource `status`, or the resource `error`
regressed.

### M-NEW-4: neither integration suite runs in `verify`

```sh
grep -n '"verify"' package.json
# "verify": "npm run format:check && npm run typecheck && npm test && npm run test:codex-acp-policy && npm run build"

grep -n 'test:integration' packages/gateway/package.json
# "test:integration:response-crash": "... RUN_RESPONSE_CRASH_INTEGRATION=1 ..."
# "test:integration:omnigent":       "RUN_OMNIGENT_INTEGRATION=1 ..."
```

`npm test` runs neither, because both are gated on an environment variable that
`verify` does not set. The testing strategy calls the Omnigent suite "the normal
gate", but nothing makes it one.

That document's own thesis is that a fixture silently drifted from real Omnigent
until two layers of tests agreed on a fiction. A gate that has to be remembered
is how that drift returns. This is the distance between the strategy as written
and the strategy as enforced.

## Low

- `engine.ts:400`, `:415`, `:424` — the H4 fix duplicated the `observeCallResult`
  transition into three branches. A fifth backend event type added later will
  silently miss it.
- `engine.ts:721-725` — `finishChain` reassigns its own `status` and
  `terminalError` parameters.
- `engine.ts:445-451` — `recordCall` runs before the cancel check, leaving an
  unpublished `recorded` call on a chain that then terminalizes as cancelled.
  Harmless for delivery, but it is permanent ledger litter.
- `file-store.ts:146` — `this.writes` accumulates one `.catch` closure per write
  for the process lifetime, which compounds with the deferred M2.

## Security

Retiring the `public-demo` profile in `0fe04a4` is a real reduction in attack
surface rather than cleanup. Every `!publicDemo` conditional bypass is gone,
`allowedTailscaleUsers` is now unconditionally required at `gateway.ts:86`, and
the non-browser response-route admission no longer carries a demo exemption.
`enrollmentPassphrase` survives only as a programmatic test seam:
`configFromEnv` no longer reads it, and `connector-auth.ts:178` generates one
when it is absent. No regression found.

## On the testing strategy

`docs/architecture/testing-strategy.md` is the most valuable artifact in this
batch. "If changing Omnigent could invalidate the assertion, exercise real
Omnigent" is the correct rule, the three evidence layers are drawn in the right
places, and "delete the false assumption from the fixture rather than teaching
both sides a new shared fiction" names precisely the failure that produced H5.
The fake backend's new docstring at `test/support/fake-backend.ts:9-14` backs it
up rather than restating it.

Its one weakness is M-NEW-4: the rule is stated but not wired to a command
anyone runs by default.

## Gate on making Open Responses the default

1. **H-NEW** — a hang plus a permanent per-session lockout on the most common
   cancellation path, with no test coverage. One line of an already-proven fix.
2. **M-NEW-2** — a corrupt chain file must not be able to prevent the gateway
   from booting.
3. **M-NEW-4** — the real-Omnigent suite should be part of the default gate,
   since it is the main defense against this class of defect recurring.

M-NEW-1 and M-NEW-3 are worth doing in the same pass but do not gate the switch.

## Fresh verification

`npm run verify` passes on `069f1c5`: prettier, gateway and web typecheck,
gateway and web unit suites, the codex-acp policy check, and all workspace
builds. The probe file was removed after use and the working tree is clean.
