import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const here = (path: string): string => fileURLToPath(new URL(path, import.meta.url));

/* THE CONTRACT, FROM SOURCE — and it has to be an alias rather than the `@intentic/src` export condition every
 * workspace package publishes. A dependency vitest externalizes is resolved by NODE, which never sees Vite's
 * conditions, so the condition alone leaves these suites reading whatever `dist` happens to hold: a BUILD, not
 * the code beside them.
 *
 * That fails SILENTLY, which is why it is worth the comment here too. These suites parse their fixtures through
 * `PanelsListSchema` precisely so the shapes are real rather than invented — and a `z.object` strips keys it does
 * not know about. Against a stale build, every fixture field the contract had just gained was quietly deleted on
 * its way in, and the assertions then failed as though the code under test were wrong. Aliasing the package ROOT
 * (not its index) keeps the subpath entries resolving to source too. Same reasoning as _sandbox/sandbox/vitest.config.ts. */
export default defineConfig({
    resolve: {
        alias: {
            "@intentic/extension-api": here(`../../_sandbox/extension-api/src`),
            "@intentic/registry": here(`../../_sandbox/registry/src`),
            "@intentic/sandbox-contract": here(`../../_sandbox/sandbox-contract/src`),
        },
    },
    test: {
        include: ["./src/**/*.test.ts"],
        environment: "node",
    },
});
