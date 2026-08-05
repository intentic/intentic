import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const here = (path: string): string => fileURLToPath(new URL(path, import.meta.url));

export default defineConfig({
    resolve: {
        /* THE CONTRACT, FROM SOURCE — and it has to be an alias rather than the `@intentic/src` export
         * condition every workspace package publishes. A dependency vitest externalizes is resolved by NODE,
         * which never sees Vite's conditions, so the condition alone leaves these suites reading whatever
         * `dist` happens to hold: a BUILD, not the code beside them.
         *
         * That fails silently, which is the part worth the comment. It is not a load error — the tests run,
         * against a schema several changes old. This suite went on passing a `WorkflowSchema.safeParse` of a
         * template that no longer matched the contract at all, and only noticed when a field the stale build
         * still required was removed. Same reasoning as _editor/web/source-aliases.ts, one package wide. */
        alias: { "@intentic/sandbox-contract": here(`../../_sandbox/sandbox-contract/src/index.ts`) },
    },
    test: {
        include: ["./src/**/*.test.ts"],
        environment: "node",
    },
});
