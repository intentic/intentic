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

## Before you finish a turn

Run **`pnpm typecheck`**. It is the whole of what CI decides main's health on, it runs inside an agent
worktree, and it takes seconds. Then run the affected packages' own suites (`pnpm -C <pkg> test`) — `pnpm test`
at the root does not work here, because turbo's `test` depends on `^build` and a pnpm `build` dies EXDEV under
worktree isolation.

What this catches is almost never an error in the code you changed. It is another package's fixture naming a
shape the interface just stopped having: change `_libs/iq-engine`, break `_apps/sandbox` and `_tools/iq-bench`,
and the tests you ran next to your edit say nothing about it. A branch cut from current main and verified only
in its own package is exactly how main spent 1h48m red across ten landed commits, then went green for four
minutes before the next one.

## Tests

Tests are type-checked source, held to the rules above. `pnpm typecheck` compiles every one of them
(`tsconfig.test.json` in each emitting package). Suites here churn far
more over their SETUP than their assertions — half of every test-file edit is fixture rebuilding — so these
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
  both come from `@intentic/testing/vitest`, and `pnpm typecheck` fails a machine-touching suite that is
  misnamed. Nothing to tune per file: the ceiling follows the kind of suite.
- A timeout is a hang bound, never a latency measurement – if a suite needs more than its budget, set it far
  above the slow case and say so in a comment. A budget tuned close to observed timings fails on contention
  instead of on regressions, and a timed-out test keeps running: its in-flight work lands on the next test's
  mocks, so one slow import reports as two failures with the second blaming innocent code.
- Assert the SHAPE of a concurrent outcome, not the winner – with two racing requests, "they never overlapped"
  is the contract and "a went first" is the arrival order of two round trips. Pinning the winner passes idle
  and inverts under load (`app.test.ts`, git write serialization).
