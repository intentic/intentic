import { join } from "node:path";
import { repoRoot } from "@intentic/constants/node";
import { defineConfig } from "vitest/config";

const root = repoRoot(import.meta.url);

export default defineConfig({
    resolve: {
        // The sibling lib's SOURCE, not node_modules — in a worktree, node_modules symlinks to the main
        // checkout, whose dist is whatever was last deployed there; these tests must test this tree.
        alias: {
            "@intentic/iq-engine/testing": join(root, "_search/iq-engine/src/testing.ts"),
            "@intentic/iq-engine": join(root, "_search/iq-engine/src/index.ts"),
        },
    },
    test: {
        include: ["./src/**/*.test.ts"],
        environment: "node",
    },
});
