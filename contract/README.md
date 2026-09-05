# Validation contracts

For the OpenClaw replacement branch, the current acceptance contract is
[VAL-OC-001 through VAL-OC-004](../docs/plan/openclaw-replacement.md).
Its final subscription-runtime and browser gates remain open.

The older `VAL-*.md` files retain historical assertions and evidence from the
Omnigent implementation. References there to removed scripts, provider fixtures
and deployment paths describe that baseline, not executable instructions for
this branch. They do not establish OpenClaw compatibility. The vendored
`open-responses/` specification remains the active public wire reference.

See the [current test mapping](../packages/gateway/test/README.md) for preserved
behavior, replacement evidence and remaining limits. Do not mark a historical
provider assertion passed merely because the replacement's tests are green.
