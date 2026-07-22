# Local code-quality analysis

Agent Connect uses a small set of local analyzers instead of a hosted quality
service. Their first job is to identify review candidates, not to make
architectural decisions or force the existing repository through arbitrary
scores.

Run the complete analysis from the repository root:

```sh
npm run analyze
```

The command runs four complementary checks:

| Command                        | Tool                         | What it reports                                                                                                 |
| ------------------------------ | ---------------------------- | --------------------------------------------------------------------------------------------------------------- |
| `npm run lint`                 | ESLint and typescript-eslint | Correctness rules plus complexity, nesting, function size, file size, statement count, and cognitive complexity |
| `npm run analyze:dependencies` | dependency-cruiser           | Dependency cycles, unresolved imports, and accepted package/application boundaries                              |
| `npm run analyze:dead-code`    | Knip                         | Unused files, dependencies, exports, and types across npm workspaces                                            |
| `npm run analyze:duplicates`   | jscpd                        | Repeated production blocks in application and package source                                                    |

## Baseline policy

The initial configuration is deliberately report-first:

- Existing ESLint correctness and complexity findings are warnings.
- Knip reports findings without failing the command.
- jscpd has no duplication percentage gate.
- dependency-cruiser fails only for boundaries that the repository already
  promises to preserve.

This lets a maintainer inspect the evidence before choosing a refactor. Do not
split a function or introduce an abstraction only to improve a number. A
finding becomes work after someone confirms the problem, describes the desired
boundary, and defines the behavior that must remain unchanged.

Once a category has been reviewed and its baseline cleaned up, its rule can be
ratcheted from a warning into an error so new regressions fail CI.

## Current dependency rules

The rules in [`.dependency-cruiser.js`](../../.dependency-cruiser.js) enforce
only current, documented ownership boundaries:

- imports must resolve and production code must not import tests;
- packages must not import deployable applications;
- one application must not import another application;
- the web SDK must not import the gateway implementation;
- the web SDK must not import Node.js built-ins;
- circular dependencies are reported as warnings.

dependency-cruiser cannot infer the intended architecture. When a new package
or adapter boundary is accepted, update these rules explicitly rather than
assuming a folder convention captures it.

## Scope and expected noise

- ESLint correctness rules cover repository-owned JavaScript and TypeScript.
  Complexity metrics cover production source and operational scripts, not test
  bodies. Copied agent-skill directories and generated build output are
  excluded.
- Knip has explicit workspace entry points. CSS-only font packages and the
  externally installed `omnigent` executable are documented exceptions.
- jscpd scans production JavaScript and TypeScript under `apps/` and
  `packages/`. Tests and end-to-end fixtures are excluded because repeated test
  setup is usually a different refactoring decision.

When adding an application or package, add its entry points to `knip.json` and
decide whether it introduces an actual dependency boundary worth enforcing.
