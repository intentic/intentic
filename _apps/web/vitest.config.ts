import { defineConfig } from "vitest/config";
import { sourceAliases } from "./source-aliases";

export default defineConfig({
    // The same source-first aliases as vite.config.ts — without them, tests resolve first-party extensions to
    // pnpm's injected node_modules copies, whose extension-api snapshot lacks src and (on a fresh CI install)
    // dist. See source-aliases.ts.
    resolve: {
        alias: sourceAliases(),
    },
    test: {
        include: ["./src/**/*.test.ts"],
        environment: "node",
    },
});
