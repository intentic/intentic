import { defineConfig } from "vitest/config";
import { INTEGRATION_SUITE, UNIT_SUITE } from "@intentic/testing/vitest";

/* Every workspace package exports an `@intentic/src` condition pointing at its .ts source, and none of them
 * ship a dist in a fresh checkout. Vite applies it for the app build; vitest resolves with node's defaults
 * unless told, so without this, any suite that reaches `@intentic/sandbox-contract` fails to LOAD rather
 * than to assert, which is why useRuns.test.ts could not run at all before it was added. Same line, same
 * reason, as _editor/web/vitest.config.ts.
 *
 * No `@vitejs/plugin-vue`: the composable tests build their host component with `h()` rather than an SFC,
 * so nothing here needs SFC compilation and the extension needs no extra dependency for it.
 *
 * ON EACH PROJECT, not at the top level: a project is its own Vite config, and a `resolve` stated once above
 * `projects` is silently ignored — which would put this suite straight back on the stale dist it was added to
 * escape. Same reasoning as _search/iq/vitest.config.ts. */
const resolve = { conditions: [`@intentic/src`] };

export default defineConfig({
    test: {
        projects: [
            { resolve, test: UNIT_SUITE },
            { resolve, test: INTEGRATION_SUITE },
        ],
    },
});
