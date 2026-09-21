import { join } from "node:path";
import { repoRoot } from "../../constants/src/node.mjs";
import { packageSourceAliases } from "@intentic/testing/aliases";

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

/* A SUITE, RUN IN A DOM. */
export const inJsdom = (suite: typeof UNIT_SUITE | typeof INTEGRATION_SUITE) => ({
    ...suite,
    exclude: [...suite.exclude],
    environment: "jsdom" as const,
});

// vi.waitFor defaults to 1s regardless of the suite's timeout; 30s matches 120s so a wait isn't read as a hang.
export const SETTLES = { timeout: 30_000 } as const;

/**
 * The two suites every in-repo extension runs, resolved against SOURCE rather than dist. Two separate reasons, both
 * of which cost an afternoon before this was one function: the kit's published bridge (`@intentic/extension-ui`)
 * returns nothing outside a running host, so a suite that got dist fails to LOAD instead of to assert; and no
 * workspace package ships a dist in a fresh checkout, which the `@intentic/src` condition answers — vitest resolves
 * externalized deps with node's rules and ignores Vite's conditions unless told.
 *
 * Stated ON EACH PROJECT, never above `projects`: a project is its own Vite config, and a `resolve` at the top level
 * is silently ignored. That failure is the quiet kind — a suite passing against a build several changes old.
 */
export const extensionProjects = (): { projects: { resolve: { conditions: string[]; alias: Record<string, string> }; test: typeof UNIT_SUITE | typeof INTEGRATION_SUITE }[] } => {
    // Found by walking to the repo marker, not by counting `../..`, so this survives the file moving.
    const resolve = {
        conditions: [`@intentic/src`],
        alias: packageSourceAliases(join(repoRoot(import.meta.url), `_shared/extension-ui`)),
    };
    return {
        projects: [
            { resolve, test: UNIT_SUITE },
            { resolve, test: INTEGRATION_SUITE },
        ],
    };
};
