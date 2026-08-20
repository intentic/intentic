import { defineConfig } from "vitest/config";

export default defineConfig({
    resolve: {
        // Every workspace package exports an `@intentic/src` condition pointing at its .ts source, and none of
        // them ship a dist in a fresh checkout. Vite applies it for the app build; vitest resolves with node's
        // defaults unless told, so without this, any suite that reaches `@intentic/sandbox-contract` fails to
        // LOAD rather than to assert. Same line, same reason, as _editor/web/vitest.config.ts.
        conditions: [`@intentic/src`],
    },
    test: {
        include: ["./src/**/*.test.ts"],
        environment: "node",
    },
});
