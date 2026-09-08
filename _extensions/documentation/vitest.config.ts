import { defineConfig } from "vitest/config";
import { INTEGRATION_SUITE, UNIT_SUITE } from "@intentic/testing/vitest";

// Workspace packages resolve via an `@intentic/src` condition to their .ts source (no dist in a fresh checkout); vitest
// needs it stated explicitly, and per-project since `resolve` at the root is ignored under `projects`. No Vue plugin or
// browser env: tests build their host with `h()`, not an SFC, and mount through a stub renderer.
const resolve = { conditions: [`@intentic/src`] };

// Split into unit and integration suites, so real-git integration tests aren't held to the fast in-memory hang-detector
// budget.
export default defineConfig({
    test: {
        projects: [
            { resolve, test: UNIT_SUITE },
            { resolve, test: INTEGRATION_SUITE },
        ],
    },
});
