import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
    resolve: {
        // The sibling lib's SOURCE, not node_modules — in a worktree, node_modules symlinks to the main
        // checkout, whose dist is whatever was last deployed there; these tests must test this tree.
        alias: {
            "@intentic/graph": fileURLToPath(new URL("../graph/src/index.ts", import.meta.url)),
        },
    },
    test: {
        include: ["./src/**/*.test.ts"],
        environment: "node",
    },
});
