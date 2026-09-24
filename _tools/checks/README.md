# The checks

Every check that reads the checkout and nothing else, listed once and run everywhere the list is read.

## Responsibilities

- Name each checkout-readable gate exactly once (`manifest.mjs`), with what it needs under it and what it is for.
- Run them side by side, each in its own process, from a clone that has never installed (`run.mjs`).
- Hold the repository's structural promises: the lockfile records the manifests, every test file is in a
  type-check program and under a budget, the workflows keep the fork boundary and the permission ceilings, a
  shrunk wire contract arrives declared, no new handler throws an error away without narrowing it or saying why,
  the daemon's module seams stay where they are and no value import closes
  a new cycle between its subsystems, nothing in `_shared/` reaches back into another part, every third-party
  package something intentic ships carries may be handed on under its licence, no build script removes
  a directory agent turns have mounted over, the UI draws from its design system, a mark beside a run of text is
  placed by the rule that computes it rather than by a hand-tuned offset, no tracked text file carries a control
  byte, every skill description fits the budget the prompt pays for on every call, no `.astro` frontmatter holds a
  script tag for vite's dependency scan to lift out and parse, the words a reader sees live in a message catalog
  rather than in a template and every key one asks for is in one, no model label falls back to its raw id, and the
  one picture that defines the site's four product nouns is read from a docs page and never from the home page.

## Key files

- [manifest.mjs](manifest.mjs): the list, each check's `gate`, and whether it is `scoped`. A check that is not on
  it runs nowhere, which is the failure this directory exists to end: five gates were red for weeks inside a
  `pnpm check` chain no hook and no job ran.
- [run.mjs](run.mjs): the runner. `--list`, `--only a,b`, `--skip a`, `--gate=code|tidy`, `--tidy=warn`,
  `--paths a,b`, `--json`; exit 1 if any check that may refuse here failed.
- [lib/report.mjs](lib/report.mjs): the one contract every check keeps: problems to stderr and exit 1, what it
  vouched for to stdout and exit 0, or `cannotMeasure` and exit 2.
- [lib/repo.mjs](lib/repo.mjs): the workspace packages, the test files, the export maps a workspace import
  resolves through, read once and without `node_modules`; and `subjectFiles`, the files a run is asked to JUDGE,
  which `--paths` narrows and nothing else does.
- [lib/workspace-graph.mjs](lib/workspace-graph.mjs): the `workspace:` dependency graph and "which packages do
  these changed paths reach", shared by CI's `changes` job and the turn-ending check. It reads
  `pnpm-workspace.yaml`'s globs first, because a `package.json` is not the same thing as a workspace member: a seed
  template, a test fixture and a store shell each carry one, and a change inside any of them belongs to the member
  that contains it rather than to a name turbo would refuse.

## How it fits

Who reads the list: CI's `preflight` job (before any install) and `nightly.yml`'s `tidy` job, the pre-push
hook's first tier (`_tools/scripts/verify/verify-push.mjs`), the turn-ending check
(`_tools/scripts/verify/verify-turn.mjs`), the per-edit run (`run.mjs --paths {file}`), `pnpm prepass` (the
checks, then `_tools/scripts/build/emit-declarations.mjs`), and `pnpm checks` by hand. The middle two are the
two moments this repository declares for itself in `.intentic/checks.json`, and the only two: the push is the
checkout's own git hook, which needs nobody's permission to run and is told its range by git.

The turn-ending check reads it twice on a red run: once on the working tree, and once on a throwaway worktree
at `HEAD`, so that a problem already standing before the turn started is reported and not held against it. That
snapshot is on the red path only (~1.2s: the `git worktree add` is most of it), so a green turn pays nothing
for it, and only the checks that failed are re-run inside it. A `node_modules` check is never asked — the
snapshot has none, so every line it printed would read as newly introduced.

Every check works on a bare checkout, which decides how they are written: a relative import of
`@intentic/constants`' hand-written JavaScript rather than a bare specifier, a line scanner over
`pnpm-lock.yaml` and the workflow files rather than a YAML parser, one pattern scanner for the modules a file
imports (`lib/imports.mjs`, read by the daemon's cycle rule and the `_shared/` rule alike) rather than a
TypeScript parser, and a `vue/compiler-sfc` or an installed `node_modules` that is attempted and vouched for less
when it is absent: `licences.mjs` reads each shipped package's licence from its installed `package.json`, so
before the install it names the units it could not read and passes. The four judgments the daemon also makes (the
assertion measure, the wire-contract shrink, the control-byte table, the overlay mirror roots) live in
`@intentic/constants` for the same reason, one copy each.

## Two gates: what a failure means decides where it may refuse

Each check declares a `gate`, and that is what decides its blast radius:

- **`code`** — the tree does not work, or CI cannot build it: a lockfile that no longer records the manifests, a
  test file no program type-checks, a workflow that opens the fork boundary, an alias pointing at nothing.
  Refused everywhere it is read.
- **`tidy`** — the tree costs its readers more than it should: a directory of 35 files, a dead link in a README,
  a hand-spelled root, a UI element off the design system, a subsystem with no invariant. Every one is a real
  cost with a measurement behind it in `docs/audits/`, and none of them is a reason to stop somebody's push. A
  tidy failure is a **warning** at the push and in CI's preflight, a **refusal** for the lines one turn added
  (see below), and a **refusal** in `nightly.yml`'s `tidy` job, which reads one commit on a GitHub-hosted runner
  and gates nothing at all.

The split was made after a day in which 18 pushes were attempted, 11 were refused, and 9 of those were refused
in under five seconds by a tidy check — for state (a ghost directory a landed rename left, a baseline one count
too high after somebody else's deletion, a link another conversation had broken) that no single actor had
produced, that the commits being pushed could not fix, and that the agent then sent after the failure could not
even see from its worktree.

### The question is who wrote the line, not how bad the rule is

A tidy rule cannot refuse a push, and for the first three weeks of the split that left it refusing in exactly
one place: the nightly, at 03:00, against a commit that is the sum of everyone's day, in a job holding
`contents: read` and no actor at all. It was red on 7 of its first 10 scheduled runs. Every anchor it printed
came from a single feature commit one or two days old — one line, in one file, that one turn wrote and nobody
was ever told about, because the turn's whole report of it was `layout, paths: tidy rules, worth fixing and not
what holds a turn`, and the push said the same.

So the refusal moved to the two moments that can name an author, and the shared cost stayed where it was:

- **The edit** (`.intentic/checks.json`'s `edit` moment → `run.mjs --paths {file}`): every `scoped` check, on
  the one file just written, in about 100ms, folded into that edit's own response. Silent when the file is
  clean. This is the only moment at which the model that wrote the line is still holding it.
- **The turn** (`verify-turn.mjs`): every check, diffed against a `HEAD` worktree **line by line**. A problem
  line that was already there is named and not held against the turn; one that was not is refused, whatever the
  check's gate. Line numbers are flattened for the comparison, so inserting a line above a standing finding
  moves it and does not accuse anyone.
- **The nightly**: unchanged, and still the only place a standing cost nobody caused is refused.

That is what the `gate` split was always reaching for and could not express: the difference between a directory
another conversation filled and a line this one wrote.

### A check that could not measure is not a finding

`lib/report.mjs`'s `cannotMeasure` exits 2, and the runner counts that as neither a pass nor a tidy failure. The
distinction is not pedantic — `pnpm peers check`'s output shape moved, and the nightly went red with nothing
wrong in the tree and nothing anybody could commit to fix it. An unmeasured check refuses where a tidy one does
(so somebody finds out), is dropped at the edit moment (one edit is the wrong occasion to learn a tool broke),
and never holds a turn (no diff can answer for it).

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
(`baselines/layout.json`, `baselines/path-literals.json`, `baselines/daemon-cycles.json`, and the `UNAUDITED` and
`NARROW_TAKERS` lists inside the daemon's two structural checks). A new finding fails by name.

`baselines/daemon-cycles.json` holds every value import between two daemon subsystems whose target already
reaches back to its source, a cycle of any length, keyed `from -> to`; a value beside an edge is the reason it
stands, where one was ever written down. A new edge that closes a cycle fails with the cycle it closes, the files
that import across it, and one import for each step of the way back, which is where to cut: a type-only port, an
event, or a module above both. Two subsystems importing each other are a cycle of two, and the reason they do
sits on both edges.

An exception list is not a ratchet. `EXCEPTIONS` in `shared-boundary.mjs` and `REVIEWED` in `licences.mjs` hold
the owner's decisions, one entry per break that stands, and every entry carries its reason; `REVIEWED` also
carries the licence the package was read at, so a package that changes its terms is read again instead of riding
an old yes. An entry the tree no longer needs is reported beside the verdict, never refused.

A stale entry — one the tree has already beaten — does **not** fail. It is tightened in place by the check
itself, wherever the write can become a commit, and merely reported everywhere else: in an agent's worktree it
would be one more line for the owner's tree to reconcile against every other turn's, and on a CI runner nobody
commits anything at all (`lib/repo.mjs`'s `writesBaselines` is the one place that decides). Failing on a shrink is
what turned every deletion into everybody else's red: one conversation removed a component, and every other
conversation's turn and the owner's next push were refused over a number in a shared file none of them had
touched — and two of them editing that file to unblock themselves was a merge conflict.

Growth in the other direction needs a way to be *deliberate*, or the ratchet only ever produces reshuffling.
`layout.mjs --allow <dir|package>` records one entry at what the tree now has and writes nothing else; the
failure message names it beside the answer it still prefers (split the directory). The instrument that existed
before it was `--write-baseline`, which adopts every finding in the tree — run from a worktree, that launders
every other conversation's drift into your commit, so growing one directory on purpose meant hand-editing a
shared JSON file and usually meant a reshuffle instead.

A scoped run (`--paths`) may **never** write a baseline, and no check may report a waiver as stale under one: it
read a handful of files, so every entry it did not look at would read as beaten. `subjectScope()` is what each
of those rules asks.

Ghost directories follow the same principle one step further: `layout.mjs` **sweeps** them rather than naming
them. Nothing in git can remove a directory git does not track, so a rule that only reported one refused the
same tree on every push until somebody typed the `rm -rf` by hand.

Deliberately not here: anything that needs the suite. Typecheck and tests are `pnpm verify` (the whole
repository, after every land) and `pnpm verify:turn` (the affected closure, when a turn ends).
