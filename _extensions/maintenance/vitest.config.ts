import { defineConfig } from "vitest/config";

export default defineConfig({
    resolve: {
        /* Every workspace package exports an `@intentic/src` condition pointing at its .ts source, and none of them
         * ship a dist in a fresh checkout. Vite applies it for the app build; vitest resolves with node's defaults
         * unless told, so without this, any suite that reaches `@intentic/sandbox-contract` fails to LOAD rather
         * than to assert, which is why useRuns.test.ts could not run at all before it was added. Same line, same
         * reason, as _editor/web/vitest.config.ts.
         *
         * No `@vitejs/plugin-vue`: the composable tests build their host component with `h()` rather than an SFC,
         * so nothing here needs SFC compilation and the extension needs no extra dependency for it. */
        conditions: [`@intentic/src`],
    },
    test: {
        include: ["./src/**/*.test.ts"],
        environment: "node",
    },
});
