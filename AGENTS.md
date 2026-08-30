- No legacy support – make clean breaking changes; update all usages.
- No re-exports or aliases – import from the true source; use original names.
- No redundant assignments/coercions – avoid renaming, ?? null, or key renames without purpose.
- Let errors propagate – do not wrap/rethrow unchanged errors.
- No trivial wrappers – call signals, setters, and properties directly.
- Prefer undefined – use it consistently; avoid mixing with null.
- No migration logic – assume fresh state; remove compatibility layers.
- Use early returns – handle edge cases first.
- Fix the pattern, not the instance – trace a bug to its root cause; when the same knowledge lives in N
  places, extract one source of truth and make every consumer import it (or execute what it emits).
- Guard invariants by discovery, not enumeration – a test that recognizes violations by their SHAPE anywhere
  in the repo; a hardcoded file list repeats the miss it exists to prevent.

## Documentation

**A package is documented by its own `README.md`, and that README is updated in the same commit as the change
that invalidated it.** There is no second place to remember: the repository-level map lives in
`docs/architecture/` (`repo.json`, `repo.md`, and a generated `index.json`), and nothing else does.

- The `# H1` and the **one sentence** under it are parsed: that sentence becomes the package's one-liner
  wherever it is named without being opened. `## Key files` is parsed too: three to six package-relative links,
  each with a reason, each of which must resolve. Everything else on the page is free-form.
- **Do not hand-write facts.** Line counts, file counts, test presence and dependency edges are computed by
  `intentic-docs` and drawn by the app above your prose. A figure fence in a README is for something the
  dependency graph cannot say: a request's path, a state machine, an ordering.
- Nothing carries provenance. How far the code has run ahead of its page is the number of commits that touched
  the package since its README last changed, so updating them together is what keeps it at zero.
- `intentic-docs validate --repo intentic --from published` and `intentic-docs check --repo intentic --from
  published --write` are on your PATH; the shipped `documenting` skill has the house style. Neither flag is
  optional. Without `--from published` the tool reads and writes the draft tree a generation run stages, not the
  documents in the repository. And `--repo` is resolved against the workspace root rather than your working
  directory, so it stays `intentic` no matter where you are standing: `--repo .` means the workspace, which
  documents nothing.

What does *not* need a documentation edit: renaming a local, adding a test, fixing a bug the page never
described, changing an implementation detail it deliberately does not mention.

## Before you finish a turn

Run **`pnpm verify`**: `pnpm typecheck` and then every package's suite. Both halves run inside an agent
worktree and together they take well under a minute (45 packages, cold) and they are the whole of what CI
decides main's health on.

Neither half goes through `pnpm build`, which dies EXDEV under worktree isolation: a prepass emits every
package's dist with `tsgo -b` (`_tools/scripts/prepass.mjs`) and the tests then run with `--only`, off turbo's
`^build` edge. Nothing about that is a shortcut: the dist each suite imports was compiled from the tree you
are looking at, seconds ago.

What this catches is almost never an error in the code you changed. It is another package's fixture naming a
shape the interface just stopped having, or a golden anchor pinned to a line you moved: change
`_search/iq-engine`, break `_sandbox/sandbox` and `_search/iq-bench`, and the suite you ran next to your edit says
nothing about it. Verifying only the package you touched is exactly how main spent 1h48m red across ten landed
commits, then went green for four minutes before the next one: and how, across three days, 67 of 100 main
pipelines failed with the `test` job.

The fleet lands in parallel, so this is also the only moment the check means anything: main moves under you
while you work, and a red main is a red main for whoever lands next, whatever they changed.

## Tests

Tests are type-checked source, held to the rules above. `pnpm typecheck` compiles every one of them
(`tsconfig.test.json` in each emitting package). Suites here churn far
more over their SETUP than their assertions (half of every test-file edit is fixture rebuilding) so these
rules are about what a test stands the code up with, not about how it asserts.

- One fake per seam, not one per suite – a copy cannot be updated when the interface grows, so it quietly
  starts describing a system that no longer exists. Shared fixtures live in the package's `src/testing.ts`
  (excluded from the build, included in the type check).
- Stub what the test relies on; let the rest name itself – `unstubbed("git", { … })` from `@intentic/testing`
  returns a seam whose unstubbed members throw with their own name, to any depth. A route that reaches past the
  fake says which method it wanted, instead of answering 500. One definition for the monorepo: the two copies
  that existed before had already drifted, and the shallower one turned a nested miss into "x is not a
  function". Import it from there, never re-export it through a package's own `testing.ts`.
- Never spread a bare `Partial<T>` into a `T`-annotated literal – it tells the compiler every key might be
  supplied, so a fake missing REQUIRED members still type-checks. Split the wide seams out of the override
  type and complete them yourself (`app.test.ts`, `ServiceOverrides`).
- Derive fixture facts, don't transcribe them – schema defaults come from `Schema.parse({})`, a golden `def`
  anchor's line comes from the tree (`iq-bench/src/anchors.ts`). A transcribed copy decays silently and reads
  as a hard case rather than a broken label.
- Assert on fields that exist – an assertion against a field the type does not have passes forever and proves
  nothing. This is what type-checking the tests buys; don't cast it away.
- State the mode a test means – no-CAP_SYS_ADMIN vs namespace, image vs host checkout. A suite that reads the
  ambient machine asserts different things on CI and on a developer's sandbox.
- Keep module loading off the assertion clock – an `await import()` inside a test or hook is charged to that
  test's timeout, and it costs ~10× more on a busy runner than on an idle one. Import statically wherever the
  file's hoisted setup only installs globals; `vi.hoisted`/`vi.mock` still run first. Reach for the dynamic
  form only when a `vi.mock` factory closes over module-scope state, or when the module is a singleton the
  test resets (`vi.resetModules`).
- A suite that reaches for the machine says so in its NAME – `*.integration.test.ts` (temp trees,
  subprocesses, real git, docker) runs under the integration budget, everything else under a 5s hang detector;
  both come from `@intentic/testing/vitest`, and the prepass both gates run fails a machine-touching suite that
  is misnamed: including one that reaches the machine only through a fixture module it imports. Nothing to
  tune per file: the ceiling follows the kind of suite.
- A timeout is a hang bound, never a latency measurement – if a suite needs more than its budget, set it far
  above the slow case and say so in a comment. A budget tuned close to observed timings fails on contention
  instead of on regressions, and a timed-out test keeps running: its in-flight work lands on the next test's
  mocks, so one slow import reports as two failures with the second blaming innocent code.
- Assert the SHAPE of a concurrent outcome, not the winner – with two racing requests, "they never overlapped"
  is the contract and "a went first" is the arrival order of two round trips. Pinning the winner passes idle
  and inverts under load (`app.test.ts`, git write serialization).
- Assert the BOUNDARY, by value – the rule above is about a genuinely unordered outcome, and it is the one place
  a relational assertion is right. Everywhere else it is how a test goes blind: `bucketOf` in
  `sandbox-contract/src/chores/digest.ts` argues in its own comment that zero is a distinct bucket, and
  `expect(bucketOf(0)).not.toBe(bucketOf(1))` cannot see that boundary move, because with it moved the two values
  still differ. `expect(bucketOf(0)).toBe(-1)` catches it. Measured: 16 of 58 injected faults survive that
  module's 109 tests. An exact value at the edge is not brittleness, it is the assertion.
- An assertion that cannot fail is worse than no test – `toBeDefined()` passes for `0`, `""`, `false` and every
  object ever constructed. `.oxlintrc.agent.json` rejects that family with a reason attached to each; if one is
  genuinely right somewhere, say why rather than reaching past it.
