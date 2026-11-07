# 02 Native platform matrix

Status: ready-for-human

Releases publish automatically from `main` ([release process](../../../install/release.md)).
Verify on real hosts:

- every native platform package installs and runs from the public npm
  artifacts, following the [install guide](../../../install/README.md);
- native service operation on macOS (launchd), not only the contract tests;
- Codex's filesystem policy on a host whose sandbox can create namespaces.
