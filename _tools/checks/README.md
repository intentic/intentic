# The checks

Every check that reads the checkout and nothing else, listed once and run everywhere the list is read.

## Responsibilities

- Name each checkout-readable gate exactly once (`manifest.mjs`), with what it needs under it and what it is for.
- Run them side by side, each in its own process, from a clone that has never installed (`run.mjs`).
- Hold the repository's structural promises: the lockfile records the manifests, every test file is in a
  type-check program and under a budget, the workflows keep the fork boundary and the permission ceilings, a
  shrunk wire contract arrives declared, the daemon's module seams stay where they are, no build script removes
  a directory agent turns have mounted over, the UI draws from its design system, a mark beside a run of text is
  placed by the rule that computes it rather than by a hand-tuned offset, no tracked text file carries a control
  byte, and every skill description fits the budget the prompt pays for on every call.

## Key files

- [manifest.mjs](manifest.mjs): the list, and each check's `gate`. A check that is not on it runs nowhere, which
  is the failure this directory exists to end: five gates were red for weeks inside a `pnpm check` chain no hook
  and no job ran.
- [run.mjs](run.mjs): the runner. `--list`, `--only a,b`, `--skip a`, `--gate=code|tidy`, `--tidy=warn`,
  `--json`; exit 1 if any check that may refuse here failed.
- [lib/report.mjs](lib/report.mjs): the one contract every check keeps: problems to stderr and exit 1, or what
  it vouched for to stdout and exit 0.
- [lib/repo.mjs](lib/repo.mjs): the workspace packages, the test files, the export maps a workspace import
  resolves through, read once and without `node_modules`.
- [lib/workspace-graph.mjs](lib/workspace-graph.mjs): the `workspace:` dependency graph and "which packages do
  these changed paths reach", shared by CI's `changes` job and the turn-ending check.

## How it fits

Who reads the list: CI's `preflight` job (before any install) and `nightly.yml`'s `tidy` job, the pre-push
hook's first tier (`_tools/scripts/verify/verify-push.mjs`), the turn-ending check
(`_tools/scripts/verify/verify-turn.mjs`), `pnpm prepass` (the checks, then
`_tools/scripts/build/emit-declarations.mjs`), and `pnpm checks` by hand.

The turn-ending check reads it twice on a red run: once on the working tree, and once on a throwaway worktree
at `HEAD`, so that a check already failing before the turn started is reported and not held against it. That
snapshot is on the red path only, so a green turn pays nothing for it.

Every check works on a bare checkout, which decides how they are written: a relative import of
`@intentic/constants`' hand-written JavaScript rather than a bare specifier, a line scanner over
`pnpm-lock.yaml` and the workflow files rather than a YAML parser, and a `vue/compiler-sfc` that is attempted and
vouched for less when it is absent. The four judgments the daemon also makes (the assertion measure, the
wire-contract shrink, the control-byte table, the overlay mirror roots) live in `@intentic/constants` for the
same reason, one copy each.

## Two gates: what a failure means decides where it may refuse

Each check declares a `gate`, and that is what decides its blast radius:

- **`code`** — the tree does not work, or CI cannot build it: a lockfile that no longer records the manifests, a
  test file no program type-checks, a workflow that opens the fork boundary, an alias pointing at nothing.
  Refused everywhere it is read.
- **`tidy`** — the tree costs its readers more than it should: a directory of 35 files, a dead link in a README,
  a hand-spelled root, a UI element off the design system, a subsystem with no invariant. Every one is a real
  cost with a measurement behind it in `docs/audits/`, and none of them is a reason to stop somebody's push. A
  tidy failure is a **warning** at the push, at the turn and in CI's preflight, and a **refusal** in
  `nightly.yml`'s `tidy` job, which reads one commit on a GitHub-hosted runner and gates nothing at all.

The split was made after a day in which 18 pushes were attempted, 11 were refused, and 9 of those were refused
in under five seconds by a tidy check — for state (a ghost directory a landed rename left, a baseline one count
too high after somebody else's deletion, a link another conversation had broken) that no single actor had
produced, that the commits being pushed could not fix, and that the agent then sent after the failure could not
even see from its worktree.

### A new check enters as `tidy`

That is the on-ramp, and it is a rule about **process**, not about the check:

1. Land it as `tidy`. It runs everywhere at once and says what it would refuse, and nobody's push or turn stops
   for a rule that has not yet met every environment it will run in. The day the `layout` check landed it was
   green on a fresh clone, red on every persistent CI workspace and red in the owner's own tree, all for the
   same commit, because those three trees hold different files.
2. Give it a week of real runs, and prune every environment it turned out to be wrong about.
3. Promote it to `code` in a change of its own — **never in the same push as a large rename**. The directory
   overhaul moved ~20 packages, added this check, its dead-name patterns and its baselines, on the day node and
   pnpm were bumped; every environment was stale relative to it at once, and the fallout took five rounds of
   fixes to clear.

## Ratchets fail on growth, and only on growth

A check that cannot be met today is ratcheted, never switched off: a baseline it may shrink and not grow
(`baselines/layout.json`, `baselines/path-literals.json`, and the `UNAUDITED`, `NARROW_TAKERS` and
`MUTUAL_PAIRS` lists inside the daemon's two structural checks). A new finding fails by name.

A stale entry — one the tree has already beaten — does **not** fail. It is tightened in place by the check
itself, wherever the write can become a commit, and merely reported everywhere else: in an agent's worktree it
would be one more line for the owner's tree to reconcile against every other turn's, and on a CI runner nobody
commits anything at all (`lib/repo.mjs`'s `writesBaselines` is the one place that decides). Failing on a shrink is
what turned every deletion into everybody else's red: one conversation removed a component, and every other
conversation's turn and the owner's next push were refused over a number in a shared file none of them had
touched — and two of them editing that file to unblock themselves was a merge conflict.

Ghost directories follow the same principle one step further: `layout.mjs` **sweeps** them rather than naming
them. Nothing in git can remove a directory git does not track, so a rule that only reported one refused the
same tree on every push until somebody typed the `rm -rf` by hand.

Deliberately not here: anything that needs the suite. Typecheck and tests are `pnpm verify` (the whole
repository, after every land) and `pnpm verify:turn` (the affected closure, when a turn ends).
