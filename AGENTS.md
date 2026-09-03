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

## What reads your edit, and when

Four moments, each the cheapest one that can see the defect it is for. Every one of them is a rule in
`.intentic/config/settings.json` (the Rules screen lists them), so none is a convention.

**After every file you write** (`file.edited` rules, every runtime, edit tools and shell commands alike: the
daemon reads the edit off the tree, so `sed`, a heredoc and a script count like Edit): the linter with
`.oxlintrc.agent.json` (`.intentic/config/hooks/lint-edit.mjs`, autofixes silently and reports only what the
edit introduced) and the byte scan (`bytes-edit.mjs`). On Claude Code turns the same moment also type-checks
the file. What a failing one prints rides back with the edit's own result. Fix it there: that is one edit,
and nothing has been built on it yet.

**When the turn tries to end** (`Verify before you finish`, `cd intentic && pnpm verify:turn`, after edits
under `intentic/**`): the checkout gates (`_tools/checks/run.mjs`, ~1s), the linter, the declarations emit,
and `turbo run typecheck test --only` over the AFFECTED CLOSURE, the packages holding a changed file plus
every package that depends on one. That is exactly the set whose fixtures can name a shape you just changed;
nothing outside it can have been broken by this turn, and nothing inside it is somebody else's red. Do not
run or announce that gate yourself; failures return to the turn, and the check's last run decides whether
the work lands: a red first run with a green second is a turn that passed, a turn still red when it ends is
held on its branch as "Ready to land".

Neither this nor the land check goes through `pnpm build`, which dies EXDEV under worktree isolation: the
emit (`_tools/scripts/emit-declarations.mjs`, `tsgo -b`) writes every package's dist, and the tests run with
`--only`, off turbo's `^build` edge. The dist each suite imports was compiled from the tree you are looking
at, seconds ago.

**After the land, on the main tree, off your clock:** the whole repository (`pnpm verify`, one prepass, one
typecheck, one test run), serialized through the heavy-command pool, for every landed repo and every runtime.
This is the one moment that legitimately needs the whole suite against a tree nobody else is moving: it
answers for another package's fixture, for main having moved under you, and for a runtime with no Stop hook.
A red verdict wakes the fix chore with your land as the named cause; a green one is recorded against the
tree so the push gate replays it.

The test files a turn touched get one more reader at the Stop, the `verify-tests` rule: each is compared with
the same file at HEAD for assertions that got weaker, and a new test is re-run against the pre-turn source for
one that passes without the change. Both findings are reports, not refusals; the push is where a weakening is
refused.

## Before it leaves the machine

The push is the one gate nothing routes around, and it runs `_tools/scripts/verify-push.mjs`: from the app's
"Check before you push" rule (`pnpm verify:push`), in a terminal the owner can watch, and again from
`.githooks/pre-push` for any BRANCH push git makes from the checkout — a tag push is a pointer move onto
commits a branch push already measured (the release tag, `stable`), so it stands down. Cheapest first: every check the manifest lists
(`_tools/checks/run.mjs`, under two seconds, needing nothing installed), the assertion ratchet over the
range's test files (`_tools/scripts/assertion-ratchet.mjs`: a test file may get stronger by itself and weaker
only with a `test!:` subject or a `Test-Note:` trailer saying why), the manifest/lockfile lockstep, the
linter; then `cargo fmt --check` on any Rust crate the push touches; then the three steps CI's verify groups
run. A tree that `pnpm verify` already measured, which after a land is the ordinary case, replays that verdict
and runs only the build it could not (`_tools/scripts/lib/tree-verdict.mjs`).

It measures the working tree; CI measures the commit. The land now regenerates `pnpm-lock.yaml` in the
worktree whenever the delta changed a manifest without it (`agents/lockfile-reconcile.ts`), so the pair
arrives in one patch; the push still refuses by name a push that commits any of `package.json`,
`pnpm-workspace.yaml` or `pnpm-lock.yaml` while another of them is changed and uncommitted.

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
  both come from `@intentic/testing/vitest`, and the `test-programs` check every gate runs fails a
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
  check reads every `vi.mock("@intentic/…", () => ({…}))` factory against the names the test and the modules it stands
  up import from that package, and refuses a missing one. Spread `await importOriginal()` into the factory rather
  than listing exports: the list is right the day it is written and wrong the day the package grows.
