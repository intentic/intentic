import vue from "@vitejs/plugin-vue";
import { defineConfig } from "vitest/config";
import { sourceAliases } from "./source-aliases";

export default defineConfig({
    // SFCs have to compile for a test to mount one. Most suites here test plain .ts (composables, pure
    // projections) and never touch this, but the pieces whose whole contract is what they RENDER — a chart's
    // geometry, say — can only be pinned by mounting them.
    plugins: [vue()],
    // The same source-first aliases as vite.config.ts — without them, tests resolve first-party extensions to
    // pnpm's injected node_modules copies, whose extension-api snapshot lacks src and (on a fresh CI install)
    // dist. See source-aliases.ts.
    resolve: {
        alias: sourceAliases(),
        // Every workspace package exports an `@intentic/src` condition pointing at its .ts source, and none of
        // them ship a dist in a fresh checkout. Vite applies the condition for the app build; vitest resolves
        // with node's defaults unless told, which is why a suite that reached one of the un-aliased libs
        // (@intentic/sandbox-run, @intentic/constants) failed to LOAD rather than to assert.
        conditions: [`@intentic/src`],
    },
    test: {
        include: ["./src/**/*.test.ts"],
        environment: "node",
    },
});
