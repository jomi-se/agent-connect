# Gateway box and test fixtures

`box/` holds the npm-shipped local build context: slim pinned Node base, curated
OS tools, locked real ACP adapters and harness CLIs, and the session entrypoint.
The release packer adds the egress proxy and mock-provider config; the matching
platform package adds its static Linux session-runner. Setup builds the box on
the owner's Docker architecture. See [ADR 0017](../../docs/decisions/0017-local-box-build.md).

Produce local release artifacts with `node scripts/build-release-local.mjs`, then
run `npm run verify:full`. The packed clean-room setup builds the box from those
artifacts. `box/build-local.sh --runners-only` produces both Linux runner inputs;
it never builds or publishes a multiarch image. Fixtures use isolated homes and
deterministic inference behind real adapters, never owner logins.
