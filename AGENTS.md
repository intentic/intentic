## Documentation

**A package is documented by its own `README.md`, and that README is updated in the same commit as the change
that invalidated it.** There is no second place to remember: the repository-level map lives in
`docs/architecture/` (`repo.json`, `repo.md`, and a generated `index.json`), and nothing else does.

`docs/architecture/` also holds how the system is put together, one subject per page — `topology.md`,
`sandbox.md`, `platform.md`, `app-plane.md`, `extensions.md`, `capabilities.md`, `packages.md`,
`conventions.md`, `testing.md`, `deploy-engine.md`, `languages.md`, `repo.md` — and `ARCHITECTURE.md` at the
root is the index into them, nothing more. The machinery around the code goes in `docs/ops/` (`docs/README.md`
states the line). A decision's reasons go in the README or architecture page that states the rule, as a short
dated note beside it naming the alternative it rejected, if there was one: a landed commit is one line with no
body (`_sandbox/sandbox/src/git/ops/commit-message.ts`), so it cannot carry them. Anything about the WORKSPACE
rather than this repository belongs in `/work/docs/`.

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

Nothing checks your work when your turn ends or after it lands, nothing sends you back to it, and no check refuses a
land, a commit or a push. You decide when the work is done. One reader runs without being asked, after each file you
write, and CI checks what the owner pushes.

**After each file you write**: the `edit` checks in `.intentic/checks.json`: every check that can judge one file
on its own (`node _tools/checks/run.mjs --paths {file}`), and the linter (`node _tools/oxlint/lint-edit.mjs {file}`,
`.oxlintrc.json` plus the anti-slop and complexity rules of `.oxlintrc.plugins.json`, `.astro` included), which fixes
what it can silently and reports only what the edit added over the file at `HEAD`. What they print rides back with the
edit and never stops the turn. Fix it there. A finding that is right where it stands says why with
`// allow(<check>): <reason>` at the site, or an `Allow: <check> — <reason>` commit trailer for a whole change
(`_tools/checks/README.md`); `Test-Note:` and `Breaking-Note:` below are declarations, not check exceptions.

**When the turn ends**: nothing runs. Your conversation's card records what the turn showed of its own work
(`proof`: verified, unproven, failing or no-code, read off the checks you chose to run after your last edit, and how
many rendered interface files you changed without looking at them), and the editor badges it.

**What to run while you work: what you changed, and nothing wider.** The test files you touched or that cover the
code you touched (`pnpm --filter @intentic/<pkg> test <path>`, which runs only the files whose path matches), and that
package's typecheck (`pnpm --filter @intentic/<pkg> typecheck`) when you changed types other packages read. Run them
in the foreground, one at a time. Do not run the whole repository (`pnpm test`, `pnpm typecheck`, `pnpm verify`,
`turbo run` without `--filter`): several conversations share this machine, and one of those runs can take all of its
memory. CI runs all of it on what the owner pushes.

**After the land**: the dependency reconciler installs when the land moved a manifest or the lockfile
(`_sandbox/sandbox/src/workspace/deps/reconcile-deps.ts`), and nothing else runs. The owner commits and pushes, and CI
checks the commit (`.github/workflows/ci.yml`: its `quick` job type-checks the packages a push changed and runs the
push check within minutes, and the verify groups build and test the rest). When main's CI fails, one fix agent takes it
(below). The "Checks after landing" note every conversation gets says so too, and that a failure in code you
did not touch may be main's own: not yours to chase unless your task is about it.

If you weakened a test file on purpose, end your final message with a `Test-Note: <why>` line. The land writes it
into the landed commit, and CI's push check reads it there. If you changed the wire contract (`_shared/sandbox-contract/src`),
its lock changes with it. Before work lands from a worktree, the repository's fixers run there
(`_tools/scripts/verify/fixers.mjs`, from `_sandbox/sandbox/src/conversations/land/worktree-fixers.ts`): they emit the
contract and rewrite `contract.lock.json` when the change reached the contract, and freeze `state-shapes.json` and
`state-registry.ts` when it reached a daemon or contract source, so the land carries them and its drafted commit gets
the `!` and `Breaking-Note:` a removal needs. Work in the main tree gets no fixers: regenerate the lock yourself
(`pnpm --filter @intentic/sandbox-contract lock`, or `tsgo -b && node scripts/write-lock.mjs` in that package where
pnpm cannot link), and the shapes with the generator named under "Stored data". A stale lock fails the contract's own
test in CI.

## Before it leaves the machine

Nothing runs on the way out. The `commit-msg` hook prints what commitlint finds and lets the commit through, and there
is no pre-push hook: CI measures what the owner pushes. Its `quick` job runs the push check on every push
(`_tools/scripts/verify/verify-push.mjs --base <sha>`, the commit the push is measured against), cheapest first: every
check the manifest lists, with a `tidy` finding counted only when the pushed range added it; the assertion ratchet
over the range's test files (weaker only with a `test!:` subject or a `Test-Note:` trailer); and the linter over the
files the range changed. `pnpm verify:push` runs the same check by hand, the branch against its upstream, and adds
the manifest/lockfile lockstep and `cargo fmt --check` on the crates the range touched. It exits non-zero on a finding
and never runs typecheck, build or test (`pnpm verify` does, by hand).

When main's CI fails, one fix agent takes it (`_sandbox/sandbox/src/ci/main-fixer.ts`). The sandbox watches `main`
and `master` of every workspace repository mapped to a connected GitHub or GitLab account, and acts on the first job
that fails rather than on the finished run: a failure streak begins there and ends once a later run of every workflow
that failed on it passes. The
agent, `ci-fix-<repo>-<runId>`, starts with that job's log tail, and every later failed job on the branch goes to the
same conversation, each job once. It gets at most three turns the sandbox starts per streak. Once they are spent, or
it finished without changing anything, failed or was stopped, the failure waits for the owner. A failure in the runners
rather than the code never reaches it, and a run whose every failure is the fleet's is re-run once. With the Agent
tab's Repair switch (`autoRepair`) off, main's failure is only reported. `docs/architecture/sandbox.md` has the rest.

## Stored data

Anything a store writes and reads back (`.intentic/`, the daemon's `/history` files, `conversations.db`, a
`sandbox.toml`, a bundle) is read by every later release, from sandboxes that skipped any number of them. A change to
its shape ships with its conversion, in the `history` of the document's `defineDocument`
(`_sandbox/sandbox/src/store/evolution/conversions.ts` has the vocabulary). The daemon's typecheck finds most missing
ones for you: before it runs, `src/store/generated/state-shapes.ts` is generated from the released shapes in
`state-shapes.json`, and it fails at the document when a released shape no longer fits today's schema after the
document's conversions (a property of the wrong type, a new required one), when a key a released shape held is gone
from today's schema at any depth with no `drop` or `rename` for it (named by its dotted path), and when a retired name
is reused. It does not see a key read a new way under the same name and type, a field a released shape spelled `any`,
a refinement (a length, a pattern), or a store with no `defineDocument`. Define a document or a boot step as
`export const name = defineDocument(…)` (or `defineStep`) at the top of its module, open it with `openDocument(spec,
path, …)` (or `openEntries`, `openIdList`, `openDirectory`; `_sandbox/sandbox/src/store/open-document.ts`), which
parses with the spec's own schema, never with a second one, and list it by running the shape
generator (`node --import tsx src/store/shapes/write-state-shapes.ts --freeze` in `_sandbox/sandbox`): the boot step
and the update pre-flight read only `src/bootstrap/state-registry.ts`, and its test fails on a definition missing from
it. Never read an existing key a new way (rename it), and never reuse a retired name. [COMPATIBILITY.md](COMPATIBILITY.md#stored-data)
has the rest and the reasons.

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
  file's setup only installs globals. `jest.mock` is not hoisted: a module that must see the mock is imported
  dynamically after it, at module scope, and a singleton the test resets is re-evaluated with `freshImport`
  (`@intentic/testing/bun`).
- A suite that reaches for the machine says so in its NAME – `*.integration.test.ts` (temp trees,
  subprocesses, real git, docker) runs under the integration budget, everything else under a 20s hang detector;
  both come from `suites` (`@intentic/testing`), and the `test-programs` check every gate runs fails a
  machine-touching suite that is misnamed: including one that reaches the machine only through a fixture
  module it imports. Nothing to tune per file: the ceiling follows the kind of suite.
- A test that needs something of the machine (a binary, a kernel setting, a built `dist`) asks with
  `requires(condition, why)` from `@intentic/testing/requires`, never a bare `skipIf`: it stands down locally with
  the reason in its title, `suites` counts it, and CI fails it, since CI provides the condition on purpose.
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
  it expects to the new truth, never by widening the matcher. The assertion ratchet measures every test file a
  change touched against its earlier self (`@intentic/constants/assertion-measure`: exact matchers, loose matchers,
  the literal text the assertions pin) and flags a downgrade (`toEqual` → `toMatchObject`) or a narrowing (the
  asserted text cut past a quarter with no test removed) unless a commit in the range carries a `test!:` subject
  or a `Test-Note:` trailer saying why. CI's push check fails an undeclared one in its range. On 2026-08-31 about 180
  test files were widened in an afternoon with every suite passing, which is what this reads for.
- Mock a workspace package with every name the code under test imports from it – the `test-programs` check reads
  every `jest.mock("@intentic/…", () => ({…}))` factory against the names the test and the modules it stands up
  import from that package, and refuses a missing one.
