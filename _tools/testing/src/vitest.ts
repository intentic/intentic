/* The two kinds of suite a package runs, as vitest project options. Config data, not a helper: a package's
 * vitest.config.ts spreads these into its own `projects` and overrides what it must.
 *
 * The split exists because a single budget cannot serve both kinds. Vitest's 5s default is a HANG DETECTOR,
 * right for a test that composes objects in memory, where 5s can only mean something is stuck. It is nonsense
 * for a suite that indexes a workspace, clones a repo or boots a container: that work takes seconds by design,
 * its duration depends on how loaded the machine is, and nothing in the suite asserts on speed. Run under the
 * hang detector those suites went red on busy CI runners and green on a developer's box, iq-engine's warm
 * pass, the chat-tabs mount, the daemon's fire routes, each repaired by hand with its own constant, after it
 * had already broken main.
 *
 * So the ceiling follows the KIND of suite, and the kind is in the file name: `*.integration.test.ts` reaches
 * for the machine (subprocesses, real git, docker, temp trees), everything else does not. A suite that needs
 * more than the budget below still says so at the test; what changes is that it no longer has to say it just
 * to be allowed to do real work.
 */

/* What an integration suite is called. The name is the whole convention: it is what the projects select on and
 * what the `test-programs` check (`_tools/checks/`) holds a machine-touching suite to. `*.e2e.test.ts` is in the set because
 * it already says the same thing more strongly, those suites drive the shipped image against real services,
 * and renaming them would have spelled "integration" twice. */
const INTEGRATION_TESTS = ["./**/*.integration.test.{ts,mjs}", "./**/*.e2e.test.{ts,mjs}"];

// Every suite in the package, integration or not. Package-wide rather than `./src/**`: a package's tests are
// wherever its code is (`bin/` filters, `bench/` harnesses), and a glob that names one directory silently
// stops running the ones that aren't in it.
const ALL_TESTS = ["./**/*.test.{ts,mjs}"];

/* Not test files, whatever they are named. Stating `exclude` at all replaces vitest's defaults, so the build
 * outputs and the package store have to be named here or a project walks into them.
 *
 * `deploy/` is the one that is not obviously an output: `pnpm deploy --prod ./deploy` (docker-release.sh)
 * stages a flat, symlink-free copy of a package there, tests and all, with its OWN node_modules. Vitest
 * therefore collected every suite twice, and the copy failed where the original could not: a `--prod` tree
 * ships no `src/`, so the `@intentic-app/src` / `@intentic/src` conditions these projects resolve under (see
 * _platform/api/vitest.config.ts) find nothing, and three suites died at import with a missing module naming
 * a path inside the artifact. It is gitignored, so it exists only where somebody has built an image, which is
 * exactly the CI runner that then reported the red — a failure in a directory nobody edited, on a shared
 * self-hosted workspace where the artifact outlives the job that made it. */
const NOT_TESTS = ["**/node_modules/**", "**/dist/**", "**/deploy/**", "**/.cache/**", "**/.turbo/**", "**/out-tsc/**"];

/* In-memory work only, and therefore the suite whose ceiling is PURELY a hang detector: nothing here waits on
 * anything, so whatever a test spends it spends on a core.
 *
 * VITEST'S OWN 5s WAS THAT CEILING AND IT MEASURED THE MACHINE INSTEAD. It is the default for a package run by
 * itself; `pnpm test` runs every package's suite through turbo on a box that is also running the agents that
 * produced the change (bounded since 2026-08 by turbo's `concurrency: 4` and the root script's
 * VITEST_MAX_WORKERS=4 — the measurement below predates those bounds and is why they exist). Measured on this
 * workspace, under the then-unbounded fan-out (turbo at 200%, each vitest forking per core), at load ~35 on
 * 16 cores: _platform/api's unit suite spends 1283s importing against 53s asserting, and a route test costing
 * 4ms with the package to itself took over 5000ms in the full run. Two of them died on the ceiling and blocked
 * a push, and they were the FIRST test in their file both times, which is the tell: a file's own imports land
 * during collection, so the first assertion in it runs at the exact moment every other fork is still loading.
 * The code under it was correct and the same tests were green on the re-run, which is what makes this the
 * expensive kind of red, the kind that teaches people to re-run rather than to read.
 *
 * 20s is the number the one package that had already met this settled on by measurement (_editor/web, whose
 * config records what else was tried: worker caps 2.5x SLOWER, threads no wall-clock win, isolate:false unsafe
 * on singletons). It is ~4x the worst inflation observed here and still reports a genuine hang inside half a
 * minute. Stated here rather than in each package, because the per-package constant is how this was answered
 * three times before: every one of them invented after that file had already broken main. */
export const UNIT_SUITE = {
    name: "unit",
    include: ALL_TESTS,
    exclude: [...NOT_TESTS, ...INTEGRATION_TESTS],
    environment: "node",
    testTimeout: 20_000,
    hookTimeout: 30_000,
} as const;

/* Real work on a shared machine. Well clear of what the work takes rather than near it, so the number bounds a
 * hang and never measures latency.
 *
 * IT ALSO HAS TO CONTAIN THE WAITS INSIDE IT, which 60s did not: `SETTLES` below is 30s, a test that reads a
 * surface back twice therefore holds two of them, and 60 is not "a fraction of the test's own budget" for the
 * second one, it is the whole of it. localmodel's held-open download is exactly that shape (drain, wait for the
 * card's progress, release, wait for the start) and it died on the suite ceiling rather than on either wait, so
 * the report named the test instead of the read-back that was slow. 120s keeps SETTLES a quarter of the budget
 * where a test uses two, and a hang still reports well inside a suite that runs for minutes. */
export const INTEGRATION_SUITE = {
    name: "integration",
    include: INTEGRATION_TESTS,
    exclude: NOT_TESTS,
    environment: "node",
    testTimeout: 120_000,
    hookTimeout: 120_000,
} as const;

/* THE SAME CEILING, ONE LAYER IN: what `vi.waitFor` is allowed inside an integration suite.
 *
 * It has to be said separately because vitest does not derive it from the budgets above. A wait gets ONE
 * SECOND unless the call site says otherwise, whatever the test around it was allowed, so a suite given sixty
 * seconds to clone a repo, boot a daemon or land a turn was still bounding every read-back at one, and the
 * same latency-as-hang-detector mistake the split above exists to end came back at each call.
 *
 * It came back the expensive way, too: as a constant per file, invented after that file had already broken
 * main. app.integration's TURN_SETTLES, turn-resume's READ_BACK and prepush's inline 5s were three answers to
 * one question, and the newest of them had already been raised once, from 4s, when three verify jobs building
 * at once outran it. The chore backlog in workspace-events drains in ~400ms with the package to itself and
 * lost the second on a runner running every package's vitest at once, which is where this landed: two tests
 * red on the push, green on every re-run, pointing at queue code that was working.
 *
 * 30s for the same reason the suite gets 120: well clear of what real work takes, still a fraction of the
 * test's own budget EVEN WHERE A TEST HOLDS TWO OF THEM, so an overrun reports as the assertion that never came
 * true rather than as a dead test. That relationship is the point and it is why the suite ceiling moved with
 * this one rather than being read as a separate number: a wait longer than the budget around it can only ever
 * report as the wrong failure. It buys PATIENCE, not leniency, the assertion is untouched and a real regression
 * fails exactly as before. */
export const SETTLES = { timeout: 30_000 } as const;
