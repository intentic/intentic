/* The two kinds of suite a package runs, as vitest project options. Config data, not a helper: a package's
 * vitest.config.ts spreads these into its own `projects` and overrides what it must.
 *
 * The split exists because a single budget cannot serve both kinds. Vitest's 5s default is a HANG DETECTOR —
 * right for a test that composes objects in memory, where 5s can only mean something is stuck. It is nonsense
 * for a suite that indexes a workspace, clones a repo or boots a container: that work takes seconds by design,
 * its duration depends on how loaded the machine is, and nothing in the suite asserts on speed. Run under the
 * hang detector those suites went red on busy CI runners and green on a developer's box — iq-engine's warm
 * pass, the chat-tabs mount, the daemon's fire routes — each repaired by hand with its own constant, after it
 * had already broken main.
 *
 * So the ceiling follows the KIND of suite, and the kind is in the file name: `*.integration.test.ts` reaches
 * for the machine (subprocesses, real git, docker, temp trees), everything else does not. A suite that needs
 * more than the budget below still says so at the test; what changes is that it no longer has to say it just
 * to be allowed to do real work.
 */

/* What an integration suite is called. The name is the whole convention: it is what the projects select on and
 * what `_tools/scripts/typecheck.mjs` holds a machine-touching suite to. `*.e2e.test.ts` is in the set because
 * it already says the same thing more strongly — those suites drive the shipped image against real services,
 * and renaming them would have spelled "integration" twice. */
const INTEGRATION_TESTS = ["./**/*.integration.test.{ts,mjs}", "./**/*.e2e.test.{ts,mjs}"];

// Every suite in the package, integration or not. Package-wide rather than `./src/**`: a package's tests are
// wherever its code is (`bin/` filters, `bench/` harnesses), and a glob that names one directory silently
// stops running the ones that aren't in it.
const ALL_TESTS = ["./**/*.test.{ts,mjs}"];

// Not test files, whatever they are named. Stating `exclude` at all replaces vitest's defaults, so the
// build outputs and the package store have to be named here or a project walks into them.
const NOT_TESTS = ["**/node_modules/**", "**/dist/**", "**/.cache/**", "**/.turbo/**", "**/out-tsc/**"];

// In-memory work only, under vitest's own default budget — stated rather than inherited, because the point of
// this pair is that the two ceilings are read side by side.
export const UNIT_SUITE = {
    name: "unit",
    include: ALL_TESTS,
    exclude: [...NOT_TESTS, ...INTEGRATION_TESTS],
    environment: "node",
    testTimeout: 5_000,
    hookTimeout: 10_000,
} as const;

// Real work on a shared machine. Well clear of what the work takes rather than near it, so the number bounds a
// hang and never measures latency — and still small enough that a genuine hang reports within a minute.
export const INTEGRATION_SUITE = {
    name: "integration",
    include: INTEGRATION_TESTS,
    exclude: NOT_TESTS,
    environment: "node",
    testTimeout: 60_000,
    hookTimeout: 60_000,
} as const;
