import { defineConfig } from "vitest/config";
import { INTEGRATION_SUITE, UNIT_SUITE } from "@intentic/testing/vitest";

// Sets `@intentic/src` so a suite resolving workspace packages doesn't fail to load against a missing dist. Applied on
// each project, not the top level: a `resolve` above `projects` is silently ignored. No `@vitejs/plugin-vue`: tests
// build their host component with `h()`, not an SFC.
const resolve = { conditions: [`@intentic/src`] };

export default defineConfig({
    test: {
        projects: [
            { resolve, test: UNIT_SUITE },
            { resolve, test: INTEGRATION_SUITE },
        ],
    },
});
