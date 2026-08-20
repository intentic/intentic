import { defineConfig } from "vitest/config";
import { INTEGRATION_SUITE, UNIT_SUITE } from "@intentic/testing/vitest";

// The __fixtures__ tree is sample INPUT, repositories the engine indexes, and carries files that look like
// tests to any glob. Nothing in it is a suite.
const FIXTURES = "./src/__fixtures__/**";

export default defineConfig({
    test: {
        projects: [
            { test: { ...UNIT_SUITE, exclude: [...UNIT_SUITE.exclude, FIXTURES] } },
            { test: { ...INTEGRATION_SUITE, exclude: [...INTEGRATION_SUITE.exclude, FIXTURES] } },
        ],
    },
});
