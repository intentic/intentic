import vue from "@vitejs/plugin-vue";
import { defineConfig } from "vitest/config";
import { sourceAliases } from "./source-aliases.ts";

export default defineConfig({
    // SFCs must compile for a test to mount one; most suites test plain .ts and never touch this.
    plugins: [vue()],
    // Same source-first aliases as vite.config.ts; without them, tests resolve first-party extensions to pnpm's
    // injected copies, which on a fresh checkout lack both src and dist (source-aliases.ts).
    resolve: {
        alias: sourceAliases(),
        // Points every workspace package at its .ts source; unlike Vite, vitest won't apply this condition by default.
        conditions: [`@intentic/src`],
    },
    test: {
        include: ["./src/**/*.test.ts"],
        environment: "node",
        // Stubs the browser APIs jsdom omits for every suite; see vitest.setup.ts for which and why.
        setupFiles: ["./vitest.setup.ts"],
        // Hang bounds, not latency targets: 60s covers ~90 in-body re-imports, above the shared 20s default.
        testTimeout: 60_000,
        hookTimeout: 60_000,
    },
});
