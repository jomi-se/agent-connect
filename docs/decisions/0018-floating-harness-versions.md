# 0018: Boxes take the latest harnesses; owners can pin

Status: Accepted (2026-10-24). Supersedes the pinned-adapter part of
[0017](0017-local-box-build.md); the local build itself is unchanged.

The box no longer ships with harness versions fixed at release. Setup asks npm
for the latest `@agentclientprotocol/codex-acp`,
`@agentclientprotocol/claude-agent-acp` and `@anthropic-ai/claude-code`, and
for the newest `@openai/codex` that the chosen codex-acp accepts, since that
adapter runs it. Owners can pin any of the four to an exact version or a
dist-tag in `versions.json` in the owner box directory.

Why: harnesses release far more often than the gateway, and they carry security
and model fixes owners want the same day. A pin per gateway release made every
Claude Code or Codex update wait on a gateway release (CVE-2026-111497 shipped
in Claude Code's bundled Bun), and gave an owner no way to move ahead of, or back
from, the maintainer's choice.

How:

- The package Dockerfile's `base` stage carries no harness. Setup builds it
  once per gateway version as `agent-connect-box:<version>`, then builds one
  layer that runs `install-harnesses.sh` with the exact resolved versions and
  appends the owner Dockerfile, if any.
- The layer tag is `agent-connect-box:<version>-<hash>`, hashing the resolved
  versions and the owner directory. A new harness release changes the tag, so
  the next `agent-connect setup` rebuilds; an unchanged selection is reused.
  `agent-connect doctor` warns when a newer release is waiting.
- Setup resolves once per run. If npm is unreachable, setup keeps the
  configured box; a first setup without npm fails.
- Releases no longer record adapter pins. Checkout verification builds the
  Dockerfile's final stage, which installs the latest harnesses, so CI is the
  early warning for a breaking upstream release. The unboxed compatibility
  fixtures keep their own pins.

Trade-off accepted: two owners installing the same gateway on different days
can run different harnesses, and an upstream release can break a box without
any change here. The recovery is a pin in `versions.json`, not a gateway
release.
