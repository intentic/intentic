# The checks

Every check that reads the checkout and nothing else, listed once and run everywhere the list is read.

## Responsibilities

- Name each checkout-readable gate exactly once (`manifest.mjs`), with what it needs under it and what it is for.
- Run them side by side, each in its own process, from a clone that has never installed (`run.mjs`).
- Hold the repository's structural promises: the lockfile records the manifests, every test file is in a
  type-check program and under a budget, the workflows keep the fork boundary and the permission ceilings, a
  shrunk wire contract arrives declared, the daemon's module seams stay where they are, the UI draws from its
  design system, and no tracked text file carries a control byte.

## Key files

- [manifest.mjs](manifest.mjs): the list. A check that is not on it runs nowhere, which is the failure this
  directory exists to end: five gates were red for weeks inside a `pnpm check` chain no hook and no job ran.
- [run.mjs](run.mjs): the runner. `--list`, `--only a,b`, `--skip a`; exit 1 if any check failed.
- [lib/report.mjs](lib/report.mjs): the one contract every check keeps: problems to stderr and exit 1, or what
  it vouched for to stdout and exit 0.
- [lib/repo.mjs](lib/repo.mjs): the workspace packages, the test files, the export maps a workspace import
  resolves through, read once and without `node_modules`.
- [lib/workspace-graph.mjs](lib/workspace-graph.mjs): the `workspace:` dependency graph and "which packages do
  these changed paths reach", shared by CI's `changes` job and the turn-ending check.

## How it fits

Who reads the list: CI's `preflight` job (before any install), the pre-push hook's first tier
(`_tools/scripts/verify-push.mjs`), the turn-ending check (`_tools/scripts/verify-turn.mjs`), `pnpm prepass`
(the checks, then `_tools/scripts/emit-declarations.mjs`), and `pnpm checks` by hand.

Every check works on a bare checkout, which decides how they are written: a relative import of
`@intentic/constants`' hand-written JavaScript rather than a bare specifier, a line scanner over
`pnpm-lock.yaml` and the workflow files rather than a YAML parser, and a `vue/compiler-sfc` that is attempted and
vouched for less when it is absent. The three judgments the daemon also makes (the assertion measure, the
wire-contract shrink, the control-byte table) live in `@intentic/constants` for the same reason, one copy each.

A check that cannot be met today is ratcheted, never switched off: a baseline it may shrink and not grow
(`baselines/path-literals.json`, and the `UNAUDITED`, `NARROW_TAKERS` and `MUTUAL_PAIRS` lists inside the
daemon's two structural checks). A new finding fails by name; a stale entry fails too.

Deliberately not here: anything that needs the suite. Typecheck and tests are `pnpm verify` (the whole
repository, after every land) and `pnpm verify:turn` (the affected closure, when a turn ends).
