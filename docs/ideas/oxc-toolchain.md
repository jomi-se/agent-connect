# Lint and format with the Oxc toolchain

Status: needs-triage

TypeScript code is linted by ESLint with typescript-eslint and formatted by
Prettier. typescript-eslint is built on the TypeScript 6 compiler API, which
TypeScript 7 removed, so it holds the repository on TypeScript 6 until
typescript-eslint supports TypeScript 7 in a stable release (its canary
builds target TypeScript 7.1). TypeScript 7 already typechecks the web SDK
cleanly, about eight times faster.

## Proposal

- Replace ESLint and typescript-eslint with oxlint, and Prettier with oxfmt.
  Both are part of [Oxc](https://oxc.rs/), written in Rust, and much faster
  than the tools they replace.
- Keep `tsc` as the compiler and typechecker, on TypeScript 7.
- Carry over what `eslint.config.js` checks today: the recommended JavaScript
  and TypeScript rule sets and the size rules (`complexity`, `max-depth`,
  `max-lines`, `max-lines-per-function`, `max-params`, `max-statements`), all
  warnings now.

Until then, move TypeScript to 7 once a stable typescript-eslint supports it,
without a side-by-side TypeScript 6 install.

## Open

- Which of today's rules oxlint lacks, and whether its type-aware rules
  (which run on TypeScript 7) cover the typescript-eslint ones we use.
- How far oxfmt's output differs from Prettier's: one reformatting commit, or
  settings that keep the current style.
- Whether knip, dependency-cruiser and jscpd stay as they are; they don't use
  the TypeScript compiler API.
