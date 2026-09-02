/* MUTATION TESTING: what the suite would notice if the code broke.
 *
 * This file is the opt-in marker for the `test-strength` chore (sandbox-contract/src/chores). The probe behind
 * that chore refuses to run without it, deliberately: this monorepo has 65 packages with their own vitest
 * configs, running the suite once per injected fault across all of them is hours of CPU nobody agreed to spend,
 * and the `mutate` list below is where somebody agrees to spend it.
 *
 * ONE STEP OUTSTANDING, and it is vitest's, not Stryker's. Both Stryker packages are real dependencies (root
 * package.json, pinned to each other in the catalog), the runner plugin is named below so pnpm's isolated layout
 * cannot hide it, and a dry run on 2026-09-02 instrumented the 23 files below into 4,269 mutants and started the
 * initial test run. That run then collected EVERY package's suites out of Stryker's sandbox copy of the repo, not
 * the daemon's alone, and died on the first `.vue` import it met: the shared `projects` every package's
 * vitest.config.ts spreads (@intentic/testing/vitest) are inline, so they resolve their `include` globs against
 * the root vitest is given, which in the sandbox copy is the copy's root, and the runner's `vitest.dir` does
 * not narrow inline projects. Until that is solved (a `root` on each shared project, or a runner that honours
 * `dir` per project), the probe finds no report and the chore renders UNMEASURED rather than claiming a clean
 * repository, which is the failure mode this file was written to keep.
 *
 * A REAL dependency rather than `pnpm dlx`, for the same reason knip is one. Measured, twice: under dlx Stryker
 * resolves its plugins from the working directory and finds nothing, and before that it cannot resolve
 * `typescript` for its own tsconfig preprocessor. Neither is configurable around.
 *
 * WHY THIS EXISTS AT ALL. A green suite is not evidence the code is checked. Coverage says a line RAN; it cannot
 * say an assertion depended on what that line produced, and the gap between the two is exactly where a model's
 * tests live — they execute everything and assert almost nothing, and every other gate in this repo says yes to
 * them. Measured on the chores module: 109 hand-written tests, 16 of 58 injected faults survived, including one
 * that moves the zero boundary in `bucketOf` that digest.ts's own comment argues is load-bearing. And on
 * 2026-08-31 about 180 test files were "relaxed" in an afternoon with every suite green, which is the event the
 * assertion ratchet (agent-tests.ts, assertion-ratchet.mjs) now catches by shape and this catches by effect.
 *
 * WHAT IS MUTATED, and why these. The daemon's steering loop and its rule resolution are where the last
 * fortnight's breakages were written: the hooks that decide what a turn is told (diagnostics, the proof, view,
 * removal and test ledgers, the shell-edit tracker), the moment that sends a turn back (rules/turn-ending.ts),
 * the table that decides whether work lands (rules/rules.ts, agent/turn-checks.ts). A surviving mutant there is
 * a turn steered wrong with nobody noticing. The contract's chores stay as the seed that was measured first.
 * Every `agent-*.ts` file was 6,727 mutants, which is a first run measured in days; this set is the part of it
 * that decides things. Prefer adding the code that would be expensive to get wrong over adding the code that is
 * easy to mutate; the score is per-repo, so every glob added moves one number and the chore speaks about the
 * whole of it.
 *
 * `--incremental` (the probe passes it) keeps this liveable: Stryker holds a result file and re-runs only the
 * mutants whose code or tests changed, so the first run costs a full run and every one after it costs the diff.
 */

/** @type {import('@stryker-mutator/api/core').PartialStrykerOptions} */
export default {
    packageManager: "pnpm",
    testRunner: "vitest",
    /* NAMED, not globbed. Stryker's default `@stryker-mutator/*` is resolved from core's own node_modules, which
     * under pnpm's isolated layout holds core's dependencies and not its siblings, so the runner was "not
     * installed" while sitting in the root node_modules ("no TestRunner plugins were loaded", measured with both
     * packages present). A bare specifier is resolved from this file's directory and finds it. */
    plugins: ["@stryker-mutator/vitest-runner"],
    /* There is no root vitest config in this repo — `pnpm test` runs each package's suite through turbo — so the
     * runner is pointed at one package's config, and vitest takes that file's directory as its root. The daemon's
     * config resolves the contract from SOURCE (its `sourceAlias`), which is what lets the contract's chores be
     * mutated under the daemon's suite as well as the daemon's own files. */
    vitest: {
        configFile: "_sandbox/sandbox/vitest.config.ts",
        // Where the runner LOOKS for tests: without it, vitest collects every package's suites out of the sandbox
        // copy of the whole repo, the daemon's config or not, and dies on the first .vue import it meets.
        dir: "_sandbox/sandbox",
    },
    reporters: ["json"],
    /* Only the tests that could have caught each mutant are re-run, rather than the whole suite per mutant. This
     * is the single biggest lever on how long a run takes, and it is safe here because the unit suite is in-memory
     * work with no shared state between files. A suite that reached for the machine would need "all". */
    coverageAnalysis: "perTest",
    mutate: [
        "_sandbox/sandbox/src/agent/agent-diagnostics.ts",
        "_sandbox/sandbox/src/agent/agent-removals.ts",
        "_sandbox/sandbox/src/agent/agent-shell-edits.ts",
        "_sandbox/sandbox/src/agent/agent-test-strength.ts",
        "_sandbox/sandbox/src/agent/agent-tests.ts",
        "_sandbox/sandbox/src/agent/agent-verification.ts",
        "_sandbox/sandbox/src/agent/agent-viewing.ts",
        "_sandbox/sandbox/src/agent/turn-checks.ts",
        "_sandbox/sandbox/src/rules/*.ts",
        "_sandbox/sandbox-contract/src/chores/*.ts",
        "!**/*.test.ts",
        "!**/*.integration.test.ts",
        "!**/testing.ts",
        "!**/*.testing.ts",
    ],
    /* Thresholds are for the exit code and Stryker's own report colouring, NOT for the chore: the chore's floor
     * lives in chores.ts next to the reasoning for it, and the probe passes `|| true` precisely so that Stryker's
     * opinion of the number never decides whether the measurement counted. `break: null` keeps a low score from
     * failing the command it runs in.
     */
    thresholds: { high: 80, low: 60, break: null },
    // Out of the repo tree: a run writes a full sandbox copy per concurrent worker, and putting that under /work
    // would drag it into the iq index, the docs walker and every agent's file listing.
    tempDirName: "/tmp/intentic-stryker",
    incrementalFile: "/tmp/intentic-stryker/incremental.json",
};
