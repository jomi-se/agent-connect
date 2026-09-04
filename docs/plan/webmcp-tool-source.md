# WebMCP tool source

Status: implemented, independently reviewed and validated, 2026-09-04.
Owner: browser SDK. Next milestone: Bookhand composition.

## Scope

Expose `createWebMcpToolSnapshot()` in the browser SDK. Discover native
`document.modelContext` tools owned by the current document, optionally select
names, and return ordinary `ApplicationTool` objects usable by existing
authorization, connection, and task APIs. Keep gateway/auth/Open Responses
unchanged and explicit tools supported. No extension or Bookhand edits.

Clone/freeze definitions before consent. Keep execution local through native
`executeTool(registeredTool, JSON.stringify(inputObject), { signal })`. Return the native string
unchanged; invocation rejection follows the existing application error path.
Do not interpret a tool's JSON payload as a new protocol envelope.

Observe `toolchange` before discovery begins. Any observed change invalidates
the whole snapshot, including during discovery. Page exit and explicit disposal
also invalidate it and abort pending native calls. Applications dispose the
snapshot when disconnecting. Abort is cooperative; it cannot undo side effects.
An invalid snapshot requires rediscovery and a new authorized connection.
No iframe aggregation, cross-origin discovery, or testing-API fallback.

## External boundary and accepted limitation

Primary reference: [WebMCP draft](https://webmachinelearning.github.io/webmcp/),
read 2026-09-04, sections 3.1 and 4.2. Native validation uses installed Chrome
for Testing 153.0.8010.12 with experimental web platform features enabled.
Browser availability remains experimental; unsupported contexts fail clearly.

Native Chrome 153 differs from the draft: schema and invocation arguments are
JSON strings, not objects. Implement only this measured experimental binding;
never retry an execution in a second format. An absent schema defaults to an
object schema; a present schema must parse to an object. A future draft binding
needs its own evidence before support is claimed.

The draft explicitly resolves execution by document/name, not registration ID.
Fast unregister/re-register can race execution before `toolchange` delivery.
This adapter prevents observed drift and never changes approved definitions;
it cannot attest immutable handler identity or sandbox a malicious page. The
page already owns its application tool implementations. Do not claim otherwise.

## Validation targets

### VAL-WEBMCP-001: native discovery and fixed consent definitions

Surface: browser and public SDK import.
Needs: Chrome with native `document.modelContext` and SDK built/importable.
Behavior: native tools become ApplicationTools with cloned immutable schemas;
only current-document tools are selected. Missing API, no tools, duplicate or
unknown requested names fail clearly. No implicit navigator/testing fallback.
Evidence: native browser tests for discovery, explicit selection, empty tools,
iframe exclusion and unsupported surface; focused library fault tests as needed.
Include absent and malformed schemas and require both matching window and
origin. Registration must settle before discovery; queued toolchange may require
retrying discovery. Do not silently retry within the adapter.

### VAL-WEBMCP-002: execution through the existing task loop

Surface: browser public SDK / AgentSession.
Needs: native registered handlers plus a controlled provider emitting application
calls (an Agent Connect contract fixture, not an Omnigent emulator).
Behavior: calls reach native handlers with arguments; native result strings are
returned intact. Native rejection becomes a tool failure. Existing explicit tools
still work. Arguments are validated by the existing AgentSession boundary.
Evidence: native browser task with state mutation, captured provider output,
rejection and malformed-argument cases; existing SDK regression suite.

### VAL-WEBMCP-003: lifecycle stops future dispatch

Surface: browser public SDK.
Needs: native tools, registration AbortController, pending tool handler.
Behavior: observed toolchange, pagehide or dispose invalidates snapshot;
subsequent calls never dispatch; outstanding calls receive abort. A change
during discovery fails rather than returning a snapshot. No automatic refresh
or permission expansion. Disposal removes listeners and is idempotent.
Evidence: native replacement/removal/disposal and pending-abort tests; focused
event/discovery race fixture for the exact await boundary; documented native
replacement-race limitation.
Invalidation remains latched even if registrations later return to the same
definitions. Disposal during a pending execution must reject/abort it.

## Delivery

1. Review these targets, implement SDK adapter and focused tests.
2. Validate native browser and public task loop; run SDK/package/regression checks.
3. Independent code review, fix findings, update status and consumer docs, commit.

Real Codex and Bookhand composition are the next integration milestone; they
are not required to change this browser-side tool source or gateway backend.

## Evidence ledger (2026-09-04)

- VAL-WEBMCP-001–003: 12 native browser tests passed against Chrome for Testing
  153.0.8010.12, including real frame exclusion, inactive documents, the
  AgentSession loop, handler errors, permanent invalidation and pending abort.
- Focused unit fixtures cover malformed schemas, metadata mutation, failed
  discovery and the exact discovery/invalidation race; these do not serve as
  evidence of native browser compatibility.
- Independent implementation review found no blocker. Its README cleanup
  finding was fixed: failed connections also dispose their snapshot.
- `npm run verify:full` stopped at formatting of the unrelated, user-owned,
  untracked `sqlitewasmvsindexeddbreport.md`. It was not modified. Task-scoped
  formatting passed; the remaining full regression commands passed separately.
  This is not a green unmodified `verify:full` claim.
- Passing regression evidence: gateway 173 passed / 12 skipped (opt-in
  integration files are exercised by their dedicated commands), SDK 49 passed,
  real Omnigent 8 passed, process-crash 4 passed, native WebMCP 12 passed,
  Canvas 14 passed. Typecheck, policy checks, build and installed-package smoke
  passed. Scoped ESLint had zero errors and two advisory complexity warnings.
- Canvas initially reused port 4174, which was serving Bookhand, and timed out
  on the wrong application. Its own run was stopped; Bookhand was untouched.
  All 14 tests passed with a temporary config importing the original settings
  and selecting isolated port 4177, explicit Canvas cwd/test directory and a
  temporary output directory. No Canvas application changes were needed.

Run the native gate with a compatible browser:

```sh
WEBMCP_CHROMIUM_EXECUTABLE=/path/to/compatible/chrome npm run test:webmcp
# For a detached run, env must be inside the command passed to the wrapper:
./scripts/quiet-run.sh --detach "WebMCP" env WEBMCP_CHROMIUM_EXECUTABLE=/path/to/compatible/chrome npm run test:webmcp
```

Playwright's bundled browser is the default; missing native support fails the
suite. The explicit override used for this run was the installed Chromium 153
executable, not a mock or shim.
