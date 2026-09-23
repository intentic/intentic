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
- Comments state what the code cannot – an invariant, a unit, a rule that would tempt a "fix". One line for a
  member or statement, two for a function or type, three for a module header. No history, no restating the
  code, no rhetoric; the reasoning behind a decision goes in `docs/design/`, not in the file.

## Documentation

**A package is documented by its own `README.md`, and that README is updated in the same commit as the change
that invalidated it.** There is no second place to remember: the repository-level map lives in
`docs/architecture/` (`repo.json`, `repo.md`, and a generated `index.json`), and nothing else does.

`docs/architecture/` also holds how the system is put together, one subject per page — `topology.md`,
`sandbox.md`, `platform.md`, `app-plane.md`, `extensions.md`, `capabilities.md`, `packages.md`,
`conventions.md`, `testing.md`, `deploy-engine.md` — and `ARCHITECTURE.md` at the root is the index into them,
nothing more. A decision and its reasons go in `docs/design/`, a measurement in `docs/audits/`, the machinery
around the code in `docs/ops/` (`docs/README.md` states the line). Anything about the WORKSPACE rather than
this repository belongs in `/work/docs/`.

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

## What reads your edit, and when

Every reader below runs without being asked, and each one tells you only about problems your change introduced:
what main already failed, a test that passes when re-run alone, and anything a tool can fix by itself never reaches
you. Do not run `pnpm verify:turn` yourself.

**After each file you write**: the linter (`.intentic/config/hooks/lint-edit.mjs`, `.oxlintrc.agent.json`,
`.astro` included), which fixes what it can silently, and every check that can judge one file on its own
(`node _tools/checks/run.mjs --paths {file}`). What they print rides back with the edit. Fix it there.

**When the turn ends** (`pnpm verify:turn`, `_tools/scripts/verify/verify-turn.mjs`): the branch is first rebased
onto today's main, and you are told if that moved anything under you. Mechanical fixes come next: rustfmt on the
crates you touched, a check's own `fix` (`_tools/checks/manifest.mjs`), and `contract.lock.json` regenerated when
the contract changed. Then the checks run, judged line by line against the main-line commit your branch stands on,
the linter runs on your changed files, and typecheck and tests run on the affected closure. Failures the last land
verdict recorded for your base are listed but never held against you (`failure-units.mjs`), and a test that
passes when re-run alone is logged as a flake (`flakes.mjs`). A turn still red when it ends waits on its branch.
The `verify-tests` rule reads the test files you touched. If you weakened one on purpose, end your final message
with one line `Test-Note: <why>`; the land writes it into the commit, and the push reads it there.

**After the land, off your clock** (`pnpm verify`, `_tools/scripts/verify/verify.mjs`, every land, either door):
the whole repository, plus what the land itself added over the commit it landed on (`land-tiers.mjs`: lint on its
files, tidy lines, rustfmt, weakened tests left undeclared). The verdict is recorded green or red with its
failures, for the next turn's subtraction and the push. Failures that appeared with a land go back to the
conversation that landed it as a follow-up (`agents/land/land-breakage.ts`).

## Before it leaves the machine

The push runs `_tools/scripts/verify/verify-push.mjs` once, from `.githooks/pre-push`, for any branch push from
the checkout, the app's Push button included; a tag push stands down. Cheapest first: every check the manifest
lists, with a `tidy` finding refused only when the pushed range added it; the assertion ratchet over the range's
test files (weaker only with a `test!:` subject or a `Test-Note:` trailer); the manifest/lockfile lockstep; the
linter; `cargo fmt --check` on crates the push touches. Typecheck, build and test are replayed from a verdict
`pnpm verify` or an earlier push recorded for the tree, and otherwise left to CI; `pnpm verify:push --suite`
runs them here. It measures the working tree, and CI measures the commit.

When main's CI goes red, `_sandbox/sandbox/src/ci/repair-gate.ts` acts only on main's newest run: a run that
died on the fleet is re-run once, and the same jobs failing twice running, or main sitting red with nothing newer
for thirty minutes, gets one fix agent. The Agent tab's "Repair what breaks after landing" switch turns this and
the land follow-ups off.

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
  file's setup only installs globals. `mock.module` is not hoisted: a module that must see the mock is imported
  dynamically after it, at module scope, and a singleton the test resets is re-evaluated with `freshImport`
  (`@intentic/testing/bun`).
- A suite that reaches for the machine says so in its NAME – `*.integration.test.ts` (temp trees,
  subprocesses, real git, docker) runs under the integration budget, everything else under a 20s hang detector;
  both come from `suites` (`@intentic/testing`), and the `test-programs` check every gate runs fails a
  machine-touching suite that is misnamed: including one that reaches the machine only through a fixture
  module it imports. Nothing to tune per file: the ceiling follows the kind of suite.
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
- An assertion that cannot fail is worse than no test – `toBeDefined()` says only "not undefined", and the type
  already knows what it is instead: assert that (`expect.any(String)`, `toMatchObject({…})`, or
  `Object.keys(bag)` contains the key, which prints what IS there when it fails). `.oxlintrc.json` rejects that
  family with a reason attached to each and has no backlog; if one is genuinely right somewhere, say why rather
  than reaching past it.
- A test file gets stronger by itself and weaker only on purpose – a failing test is fixed by updating the value
  it expects to the new truth, never by widening the matcher. The push gate measures every test file a range
  changed against its earlier self (`@intentic/constants/assertion-measure`: exact matchers, loose matchers, the
  literal text the assertions pin) and refuses a downgrade (`toEqual` → `toMatchObject`) or a narrowing (the
  asserted text cut past a quarter with no test removed) unless a commit in the range carries a `test!:` subject
  or a `Test-Note:` trailer saying why. The same measure reaches the agent at the Stop (`verify-tests`), where it
  is a report. On 2026-08-31 about 180 test files were widened in an afternoon with every suite green; that is
  what this reads for.
- Mock a workspace package with what the code under test imports, or with the original – the `test-programs`
  check reads every `mock.module("@intentic/…", () => ({…}))` factory against the names the test and the modules it stands
  up import from that package, and refuses a missing one. Spread `await importOriginal()` into the factory rather
  than listing exports: the list is right the day it is written and wrong the day the package grows.
