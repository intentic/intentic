// The two suite kinds a package runs, as vitest project options a config spreads into its own `projects`. A single
// timeout can't serve both: vitest's 5s default is a hang detector, wrong for a suite that clones a repo or boots a
// container. The kind is in the file name: `*.integration.test.ts` reaches for the machine, everything else doesn't.

// Both the projects split and the test-programs check key on this name; `*.e2e.test.ts` means the same thing.
const INTEGRATION_TESTS = ["./**/*.integration.test.{ts,mjs}", "./**/*.e2e.test.{ts,mjs}"];

// Every suite in the package; package-wide, not `./src/**`, since tests can live in `bin/`, `bench/`, anywhere code
// does.
const ALL_TESTS = ["./**/*.test.{ts,mjs}"];

// Stating `exclude` replaces vitest's defaults; `deploy/` matters since a `--prod` copy has no `src/`.
const NOT_TESTS = ["**/node_modules/**", "**/dist/**", "**/deploy/**", "**/.cache/**", "**/.turbo/**", "**/out-tsc/**"];

// Purely a hang detector: nothing here waits on anything, so 20s bounds a hang, not real latency.
export const UNIT_SUITE = {
    name: "unit",
    include: ALL_TESTS,
    exclude: [...NOT_TESTS, ...INTEGRATION_TESTS],
    environment: "node",
    testTimeout: 20_000,
    hookTimeout: 30_000,
} as const;

// Real work on a shared machine: 120s bounds a hang well clear of latency, room for two 30s SETTLES waits.
export const INTEGRATION_SUITE = {
    name: "integration",
    include: INTEGRATION_TESTS,
    exclude: NOT_TESTS,
    environment: "node",
    testTimeout: 120_000,
    hookTimeout: 120_000,
} as const;

/* A SUITE, RUN IN A DOM. For the packages that ship browser code and want ONE environment for the whole
 * package rather than a `@vitest-environment` annotation per file: the widget and the issue SDK, both of which
 * are mostly DOM with a few environment-agnostic parsers that do not mind being run in one.
 *
 * Only `environment` moves. The ceilings above are the point of the shared suites and they come across
 * untouched, which is the whole reason this is a wrapper rather than a second pair of suite constants.
 *
 * `exclude` is REBUILT rather than spread through: the suites are `as const`, so it arrives readonly, and
 * vitest's ProjectConfig wants a mutable array. Every package that overrode a suite used to make this copy for
 * itself, and getting it wrong is a type error at the config, which is a confusing place to meet one. */
export const inJsdom = (suite: typeof UNIT_SUITE | typeof INTEGRATION_SUITE) => ({
    ...suite,
    exclude: [...suite.exclude],
    environment: "jsdom" as const,
});

// vi.waitFor defaults to 1s regardless of the suite's timeout; 30s matches 120s so a wait isn't read as a hang.
export const SETTLES = { timeout: 30_000 } as const;
