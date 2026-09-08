import { join } from "node:path";
import { repoRoot } from "@intentic/constants/node";
import { defineConfig } from "vitest/config";
import { INTEGRATION_SUITE, UNIT_SUITE } from "@intentic/testing/vitest";

const root = repoRoot(import.meta.url);

// Source, not node_modules (a worktree symlinks to the main checkout's dist); set per project, not top-level.
const sourceAlias = {
    "@intentic/iq-engine/testing": join(root, "_search/iq-engine/src/testing.ts"),
    "@intentic/iq-engine": join(root, "_search/iq-engine/src/index.ts"),
};

// Both suites drive real fixtures; timeouts come from `@intentic/testing/vitest`, not the default unit budget.
export default defineConfig({
    test: {
        projects: [
            { resolve: { alias: sourceAlias }, test: UNIT_SUITE },
            { resolve: { alias: sourceAlias }, test: INTEGRATION_SUITE },
        ],
    },
});
