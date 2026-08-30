/* MUTATION TESTING: what the suite would notice if the code broke.
 *
 * NOT YET RUNNABLE — one step outstanding. Stryker is not a dependency of this repo, so the probe's
 * `available` check fails on its second half (`pnpm exec stryker --version`) and the chore renders unmeasured
 * rather than claiming a clean repository. To turn it on:
 *   1. pnpm-workspace.yaml catalog:  "@stryker-mutator/core": 10.0.0  and  "@stryker-mutator/vitest-runner": 10.0.0
 *   2. root package.json devDependencies: both of the above, as "catalog:"
 *   3. pnpm install
 * Both packages together, and pinned to each other: the runner has to agree with the vitest this repo runs.
 *
 * A REAL dependency rather than `pnpm dlx`, for the same reason knip is one. Measured, twice: under dlx Stryker
 * resolves its plugins from the working directory and finds nothing — "Cannot find TestRunner plugin \"vitest\".
 * In fact, no TestRunner plugins were loaded" — and before that it cannot resolve `typescript` for its own
 * tsconfig preprocessor. Neither is configurable around.
 *
 * This file is the opt-in marker for the `test-strength` chore (sandbox-contract/src/chores). The probe behind
 * that chore refuses to run without it, deliberately: this monorepo has 65 packages with their own vitest
 * configs, running the suite once per injected fault across all of them is hours of CPU nobody agreed to spend,
 * and the `mutate` list below is where somebody agrees to spend it.
 *
 * WHY THIS EXISTS AT ALL. A green suite is not evidence the code is checked. Coverage says a line RAN; it cannot
 * say an assertion depended on what that line produced, and the gap between the two is exactly where a model's
 * tests live — they execute everything and assert almost nothing, and every other gate in this repo says yes to
 * them. Measured on the module named below: 109 hand-written tests, 16 of 58 injected faults survived, including
 * one that moves the zero boundary in `bucketOf` that digest.ts's own comment argues is load-bearing.
 *
 * THE SEED IS ONE MODULE, and widening it is the point rather than an afterthought. Add a glob when a package's
 * tests are worth this much scrutiny; the score is per-repo, so every glob added moves one number and the chore
 * speaks about the whole of it. Prefer adding the code that would be expensive to get wrong over adding the code
 * that is easy to mutate.
 *
 * `--incremental` (the probe passes it) keeps this liveable: Stryker holds a result file and re-runs only the
 * mutants whose code or tests changed, so the first run costs a full run and every one after it costs the diff.
 */

/** @type {import('@stryker-mutator/api/core').PartialStrykerOptions} */
export default {
    packageManager: "pnpm",
    testRunner: "vitest",
    // There is no root vitest config in this repo — `pnpm test` runs each package's suite through turbo — so the
    // runner is pointed at one package's config, and vitest takes that file's directory as its root.
    vitest: { configFile: "_sandbox/sandbox-contract/vitest.config.ts" },
    reporters: ["json"],
    /* Only the tests that could have caught each mutant are re-run, rather than the whole suite per mutant. This
     * is the single biggest lever on how long a run takes, and it is safe here because the suite is in-memory
     * work with no shared state between files. A suite that reached for the machine would need "all". */
    coverageAnalysis: "perTest",
    mutate: ["_sandbox/sandbox-contract/src/chores/*.ts", "!**/*.test.ts", "!**/testing.ts"],
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
