import { defineConfig } from "vitest/config";
import { INTEGRATION_SUITE, UNIT_SUITE } from "@intentic/testing/vitest";

// Resolves `@intentic/src` so suites run against source, not a stale dist; must be `ssr.resolve`, set per project.
const ssr = { resolve: { conditions: [`@intentic/src`] } };

export default defineConfig({
    test: {
        projects: [
            { ssr, test: UNIT_SUITE },
            { ssr, test: INTEGRATION_SUITE },
        ],
    },
});
