# CSP-safe SDK validation

Status: SDK fix verified locally; Bookhand application integration remains separate.
No push/publication authorized.

Bookhand reproduced AgentSession construction failing under a real Chromium
policy without unsafe-eval. Both snapshotTools and WebMCP discovery compile Ajv
schemas today. Replace those browser-side calls with one shared interpreting
validator; do not bypass validation or relax application CSP. No gateway/auth
redesign. The gateway may retain its existing validator.

Candidate: @cfworker/json-schema 4.1.1, subject to preflight compatibility checks.
Its constructor alone is insufficient: schema validity, unresolved references,
and bad regular expressions must still fail before tool execution/consent.

## Contract and scope

### VAL-CSP-001 — immutable, validated schema snapshots

Surface: SDK library and native WebMCP discovery.
Needs: a CSP-safe interpreter and draft-7 schema validation.
Behavior: both entry points share validation; malformed schemas, unsupported
dialects, unresolved refs and invalid patterns fail before invocation. Preserve
fixed cloned snapshots, local refs and existing supported draft-7 constraints.
Never mutate caller schema or silently drop supported constraints. Target draft-7
or absent $schema, retaining existing nullable semantics and ignoring annotation
formats not enforced by old Ajv. Ignore later-draft keywords the old validator
ignored rather than silently adding constraints. This is not universal Ajv parity.
`multipleOf` is explicitly unsupported: independent review reproduced the
interpreter accepting 1e-8 as a multiple of 1. Reject this keyword before consent
rather than silently weaken it or add a custom constraint evaluator.
Do not coerce arguments, insert defaults or remove properties. Preserve WebMCP's
object-schema boundary and pre-consent rejection timing.
Evidence: existing SDK suite plus a small table for actual measured differences
(nullable, formats, newer keywords), references and malformed definitions.

### VAL-CSP-002 — arguments remain checked before side effects

Surface: AgentSession public tool loop.
Needs: VAL-CSP-001.
Behavior: invalid arguments return invalid_tool_arguments without executing the
handler; valid calls execute and return their result. Preserve error recovery,
unknown tool rejection and subsequent completion/continuation behavior.
Evidence: public SDK tests and browser invalid-call -> valid-call -> completion.

### VAL-CSP-003 — no runtime code generation under real CSP

Surface: real Chromium, existing native WebMCP suite in verify:full.
Needs: pinned native browser executable and page with script-src 'self', no
unsafe-eval. Browser must demonstrably reject new Function as a control.
Behavior: SDK import, native discovery, AgentSession construction and tool loop
succeed under CSP; invalid input cannot reach page handler. No CSP violations
from SDK activity. No JS disabling, no mocked browser CSP.
Evidence: actual browser E2E, negative control separated from SDK violation count;
existing native suite and installed-package smoke. Bookhand independently
reproduces against its app policy after local tarball handoff.

## Execution

Pass 1 review completed: explicit compatibility scope replaces broad parity
claims. User requests lightweight validation: no exhaustive corpus, repeated
full suites or speculative test expansion. Contract review precedes implementation;
implementation owns shared validator,
schema preflight, dependencies and SDK unit regression tests. Parent owns browser
CSP regression, docs and local artifact handoff. Independent review and focused
checks before final formatting/verification. Runtime planning tools are absent;
this file is the persistent contract and progress record.

## Evidence and handoff

- Two bounded contract review passes completed; independent implementation review
  found the multipleOf issue, and confirmed its fail-closed correction.
- Final focused run: typecheck, 98 SDK tests, 14 native WebMCP tests and installed
  package smoke passed. Log: /tmp/agent-connect-command-logs/quiet-run.CMDJY9.log.
  No full gateway/Omnigent/Canvas rerun: their implementations did not change.
- CSP test serves ordinary page JavaScript under script-src 'self'; it proves
  new Function is blocked, then imports SDK, discovers a native tool, rejects an
  invalid call, executes a valid one and completes without CSP violations.
  CDP evaluation alone was insufficient because it can bypass unsafe-eval checks.
- Local candidate tarball: /tmp/bookhand-csp-sdk.mDAkoZ/open-agent-connect-web-0.0.3.tgz.
  This is a local patched artifact, not the published 0.0.3 release. A new release
  version and explicit user permission are required before pushing/publishing.
- Public runtime card: /tmp/bookhand-agent-connect-runtime-card.json, fetched
  through the existing HTTPS runtime challenge. Exact Bookhand origin :8445
  succeeds against gateway :8443 through Tailscale Serve; direct-loopback results
  are not a substitute for that path. No gateway configuration or credentials
  changed. Human authorization and actual Bookhand tutoring flow remain owned
  by the Bookhand integration session.
