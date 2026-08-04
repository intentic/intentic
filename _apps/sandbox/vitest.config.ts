import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";
import { INTEGRATION_SUITE, UNIT_SUITE } from "@intentic/testing/vitest";

const here = (path: string): string => fileURLToPath(new URL(path, import.meta.url));

/* THE CONTRACT, FROM SOURCE — and it has to be an alias rather than the `@intentic/src` export condition every
 * workspace package publishes. A dependency vitest externalizes is resolved by NODE, which never sees Vite's
 * conditions, so the condition alone leaves these suites reading whatever `dist` happens to hold: a BUILD, not
 * the code beside them.
 *
 * That fails silently, which is the part worth the comment. It is not a load error — the tests run, against a
 * contract several changes old. The routes suite went on calling an `accounts` procedure whose stale build had
 * never been given its query schema, so the daemon's own coercion never ran and the handler saw a raw `"1"`.
 * Aliasing the package root (rather than its index) keeps the subpath entries — `/chores`, `/tunnel-ids`,
 * `/session-names` — resolving to source too. Same reasoning as _extensions/workflows/vitest.config.ts.
 *
 * It sits on each PROJECT because a project is its own Vite config: a `resolve` stated once at the top level is
 * silently ignored under `projects`, which is the same quiet-wrong-answer this alias exists to prevent. */
const sourceAlias = { "@intentic/sandbox-contract": here(`../../_libs/sandbox-contract/src`) };

export default defineConfig({
    test: {
        projects: [
            { resolve: { alias: sourceAlias }, test: UNIT_SUITE },
            { resolve: { alias: sourceAlias }, test: INTEGRATION_SUITE },
        ],
    },
});
