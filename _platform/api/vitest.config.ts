import { defineConfig } from "vitest/config";
import { INTEGRATION_SUITE, UNIT_SUITE } from "@intentic/testing/vitest";

// Points each `@intentic/*` import at its own `.ts` source, like the real build, instead of a stale last-built dist.
// Must be `ssr.resolve` (vitest resolves through SSR) and set per project, since project-level Vite configs ignore
// top-level options.
const ssr = { resolve: { conditions: [`@intentic/src`, `@intentic/src`] } };

export default defineConfig({
    test: {
        projects: [
            { ssr, test: UNIT_SUITE },
            { ssr, test: INTEGRATION_SUITE },
        ],
    },
});
