import { defineConfig } from "vitest/config";
import { INTEGRATION_SUITE, UNIT_SUITE } from "@intentic/testing/vitest";

// The SDK imports the contract for TYPES only, but vitest still resolves the specifier, and every
// workspace package publishes its source behind this condition rather than a dist a fresh checkout has
// never built.
//
// ON EACH PROJECT, not at the top level: a project is its own Vite config, and a `resolve` stated once above
// `projects` is silently ignored. Same reasoning as _search/iq/vitest.config.ts.
const resolve = { conditions: [`@intentic/src`] };

// The dialog and capture suites need a DOM; the fingerprint-free transport bits don't care, and one
// environment for the package beats a per-file annotation. It overrides the shared budgets' `node`, which is the only thing this
// package needs from them changed — the ceilings are the point and they come across untouched.
//
// `exclude` is rebuilt rather than spread through: the shared suites are `as const`, so it arrives readonly and
// vitest's ProjectConfig wants a mutable array. Same copy the other overriding configs make
// (_search/iq-engine/vitest.config.ts).
const inJsdom = (suite: typeof UNIT_SUITE | typeof INTEGRATION_SUITE) => ({
    ...suite,
    exclude: [...suite.exclude],
    environment: "jsdom" as const,
});

export default defineConfig({
    test: {
        projects: [
            { resolve, test: inJsdom(UNIT_SUITE) },
            { resolve, test: inJsdom(INTEGRATION_SUITE) },
        ],
    },
});
