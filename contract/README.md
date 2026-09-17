# Validation contracts

The `VAL-*.md` files retain historical assertions and evidence from the retired
Omnigent and replacement-gateway implementations. References there to removed
scripts, provider fixtures, runtime cards, and deployment paths describe those
dated baselines, not executable instructions or current OpenClaw-plugin
guarantees.

The vendored `open-responses/` specification records the protocol pin used by
that historical validation. Current stock-plugin behavior is defined by the
[mission](../docs/mission.md), [scope inventory](../docs/scope-inventory.md),
and its package and installed-host tests. Do not mark a historical provider or
durability assertion passed merely because current plugin tests are green.
