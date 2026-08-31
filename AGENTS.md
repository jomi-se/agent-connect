# Repository guidance

## Product boundary

Agent Connect is an application-to-user-owned-agent bridge. Keep the application-facing API agent- and harness-neutral. Codex, Omnigent, ACP adapters, and transport bridges belong behind internal adapter boundaries.

The public task/tool API is provider-neutral. Omnigent HTTP/SSE is the first
working provider transport. ACP remains the preferred future standardized
adapter; MCP-over-ACP is unstable, so keep draft-specific code and types out of
the default application API.

## Terminology

Use **gateway** for the Agent Connect component that applications reach and
users operate. Public documentation, UI copy, deployment paths, and new APIs
must not call it a connector. Older internal compatibility names may remain
until a dedicated migration, including `ConnectorAuth`, `connectorPublicKey`,
`connector.json`, and `AGENT_CONNECT_REAL_CONNECTOR_ENV`.

## Current scope

The browser-to-Codex spike and gateway-owned provisioning pass. Continue to
assume one online Omnigent host, one active task per application session, one
fixed tool snapshot per logical/downstream session, and one downstream agent
until durability and approval behavior are implemented. Browser APIs must use
opaque Agent Connect sessions, never raw Omnigent ids.

Do not add generalized multi-agent orchestration, arbitrary MCP features, Android automation, or a second proprietary session protocol without recording a decision under `docs/decisions/`.

## Commands

Use npm workspaces from the repository root:

```sh
npm install
npm run format:check
npm run typecheck
npm test
npm run build
npm run verify
npm run analyze
```

`npm run verify` includes the deterministic real-Omnigent compatibility suite
and therefore requires the pinned Omnigent version from
`config/omnigent-test-compat.json` on `PATH`. This is intentional: provider
compatibility is a default gate, not an optional check someone must remember.

`npm run analyze` is initially report-first. Treat its metrics as investigation
inputs, not automatic refactoring instructions; dependency boundary violations
remain hard failures.

Add or update tests for public SDK behavior. Keep browser packages free of Node-only runtime imports.

### Low-output command execution

For routine non-interactive commands whose successful output carries no useful
information beyond the exit code—builds, typechecks, tests, lint, and similar
checks—use `scripts/quiet-run.sh` by default:

```sh
./scripts/quiet-run.sh "gateway tests" npm test --workspace @agent-connect/gateway
./scripts/quiet-run.sh "build" npm run build
```

On success, the wrapper prints one short line. On failure, it prints a bounded
tail and preserves the complete log under `/tmp` for focused follow-up. This
keeps repetitive success logs out of the agent context: they consume tokens
and displace useful evidence without improving a decision, while the full
failure detail remains available when it is actually needed.

Do not use the wrapper when a command needs interactive input, live progress is
operationally important, or its normal output is itself the requested evidence.
During implementation, prefer the narrowest relevant check. Run the formatter
once after the code has stabilized and immediately before final verification,
diff review, and commit; do not interleave repeated formatting passes with
ordinary edit/test iterations.

For anything slow enough to outlast a single tool call—`npm run verify`, the
full test suite, browser end-to-end runs—start it detached and collect the
result later instead of waiting on a blocked call:

```sh
./scripts/quiet-run.sh --detach "full verify" npm run verify
# → STARTED full verify (handle /tmp/agent-connect-command-logs/quiet-run.Ab3xYz)
# do unrelated work here: read a file, plan the next edit
./scripts/quiet-run.sh --status /tmp/agent-connect-command-logs/quiet-run.Ab3xYz
```

`--status` prints `RUNNING` while the command is in flight and the usual
`OK`/`FAILED` result with the bounded failure tail once it has exited. The
wrapper is silent until the command finishes, so a foreground run of a
multi-minute command yields nothing to read and forces a wait-and-retry loop.
Detaching turns that loop into one call to start and one to collect.

### Why these commands are shaped this way

A model request re-sends the whole conversation, so what it costs is set by the
context it carries, not by what it returns. Two consequences are worth reasoning
from, because they are unintuitive and they dominate everything else.

**A request that learns nothing costs what a request that learns something
costs.** A one-line "has it finished yet?" is priced like a deep reasoning turn.
This is why the wrapper grew `--detach`: a multi-minute command run in the
foreground produces no readable output, so the only way to wait is a sequence of
full-price requests that each return "still running." Ten of those buy nothing.
Detaching converts the wait into one request to start and one to collect, and
the interval becomes free time for work that does not depend on the result.

**Anything read into context is re-paid on every later request in that
conversation.** A 40k-character dump is not a one-time charge; it is a tax on
the rest of the session, which is why reading the exact hunk beats paging
through the file and `git diff --stat` before `git diff` beats the whole
changeset. Batching several reads into one call is a real saving when the
alternative is several round trips — trade freely between the two, but notice
when a batch grows big enough to be truncated, because a truncated read costs
full price and then has to be done again anyway. That has happened here.

Neither of these is a prohibition. Read widely when you genuinely do not know
where the answer lives; the cost of guessing wrong is higher. The point is to
spend context on things that change what you do next.

### Subagents

The question worth asking is what the subagent would otherwise have to rebuild.
A lane that inherits a finished piece of reconnaissance — the files that matter,
the shape of the bug, the constraints already established — is usually cheaper
than several lanes that each rediscover it, because that exploration gets paid
for once instead of once per lane. Forking is the right call there, and
splitting genuinely independent work across lanes that share a hard-won context
is what it is for.

It goes wrong when the fork happens before that context exists. Forking early
copies the system prompt and playbook text the lane would have received anyway,
adds it to every request the lane makes for its whole life, and still leaves each
lane to explore the codebase separately. This repository has done exactly that:
a mission forked three explorer lanes twenty seconds into a session, after two
file reads, and the three then re-derived the same code map independently. It
paid the inheritance cost with none of the benefit.

So the useful judgment is about timing and content, not count. Fork when there is
something expensive to inherit and the lanes will do substantial independent work
from it. Otherwise brief the lane in writing — target ids, file paths, the
question it must answer, the expected output shape — which is cheaper and, when
the parent's context is mostly irrelevant to the lane, clearer as well.

### Running the checks

Verification is the cheapest work in a mission and routinely the most expensive
to run, because the expense has nothing to do with the work. Running
`npm run format:check` is not a hard problem, but run from a mature
conversation it costs whatever that conversation weighs — in one session here,
about 135k tokens per formatting check, eight times over. Prettier did not need
any of that context. The request paid for it because the request carried it.

So the lever is not which model runs the checks; it is how much conversation the
check drags behind it. A hard model running a check from a small, purpose-built
context is far cheaper than a cheap model running the same check from a full
implementation transcript. Choosing a lighter model for mechanical work is
reasonable on top of that, but it is the smaller effect and it is not the reason
to separate the work.

When verification is more than a quick targeted test, prefer to run it from a
lane that holds only what running it requires: the repository, the commands, and
where to report. Such a lane needs no design rationale, no diff review, and no
history of what has already been tried.

Give that lane a narrow contract: **run the named commands, report exit codes and
the bounded failure output, change nothing else.** Two reasons it must not
diagnose. First, a lane briefed only to run commands does not have the context to
diagnose well, so whatever it concludes has to be re-derived by whoever does hold
that context — the analysis is paid for twice and the second one is the only one
that counts. Second, diagnosis is open-ended: it reads files, forms theories, and
accumulates exactly the context the lane was created not to have. A runner that
starts investigating stops being cheap within a few requests.

Escalation is deliberately inexpensive. `quiet-run.sh` already reports
`FAILED <label> (exit N)` with a bounded log tail and the full log path, so a
failure comes back as a small payload that the conversation holding the
implementation context can act on directly. Running `npm run format` to fix
formatting is a fair exception, since the fix is deterministic and needs no
judgment. Anything requiring a decision goes back up.

### Test the dependency you actually ship

If a test's expected result would become meaningless when Omnigent changes,
run it against real Omnigent. Do not encode assumed Omnigent HTTP/SSE,
cancellation, session, or event behavior in a fake backend or a recording and
then treat the passing test as compatibility evidence.

Use the deterministic ACP agent behind a disposable real Omnigent service for
routine compatibility tests. This exercises the real provider boundary without
spending model allowance or depending on nondeterministic model choices. Keep a
small real-Codex smoke test only for final composition evidence.

In-process doubles remain appropriate for Agent Connect-owned state-machine
invariants and deliberate faults that are impractical to create through a real
service, such as a failed disk write, an abruptly ended iterator, a wedged HTTP
request, or an exact race schedule. Such doubles must be controllable contract
fixtures: they must not synthesize events merely because Omnigent happens to
emit—or was once believed to emit—them. See
[`docs/architecture/testing-strategy.md`](docs/architecture/testing-strategy.md).

## Protocol and reliability rules

- Persist an application tool request before notifying the application.
- Do not claim generic exactly-once execution. Use stable action IDs and require idempotent application operations or application-owned deduplication.
- Conversation resumption and delivery of unresolved tool requests are separate concerns.
- Clearly label unstable ACP and MCP-over-ACP behavior in public APIs and documentation.
- Do not describe a custom bridge as a stable ACP or MCP standard implementation.

## Documentation

- Current mission and boundaries: `docs/mission.md`
- System architecture: `docs/architecture/`
- Accepted decisions: `docs/decisions/`
- Execution plans: `docs/plan/`
- Time-stamped external research: `docs/research/`

Update the earliest source of truth that changed; do not leave contradictory plans in different documents.
