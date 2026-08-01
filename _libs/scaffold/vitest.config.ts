import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";
import { INTEGRATION_SUITE, UNIT_SUITE } from "@intentic/testing/vitest";

// The sibling lib's SOURCE, not node_modules — in a worktree, node_modules symlinks to the main checkout,
// whose dist is whatever was last deployed there; these tests must test this tree. Stated per project: a
// project resolves on its own, so a root-level alias would reach neither of them.
const resolve = {
    alias: {
        "@intentic/graph": fileURLToPath(new URL("../graph/src/index.ts", import.meta.url)),
    },
};

export default defineConfig({
    test: {
        projects: [
            { resolve, test: UNIT_SUITE },
            { resolve, test: INTEGRATION_SUITE },
        ],
    },
});
