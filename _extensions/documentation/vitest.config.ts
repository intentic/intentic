import { defineConfig } from "vitest/config";
import { INTEGRATION_SUITE, UNIT_SUITE } from "@intentic/testing/vitest";

/* Every workspace package exports an `@intentic/src` condition pointing at its .ts source, and none of them
 * ship a dist in a fresh checkout. Vite applies it for the app build; vitest resolves with node's defaults
 * unless told — so without this, any suite that reaches `@intentic/sandbox-contract` fails to LOAD rather than
 * to assert, which is why useRuns.test.ts could not run at all before it was added. Same line, same reason, as
 * _editor/web/vitest.config.ts.
 *
 * It sits on each PROJECT, not once at the top: a project is its own Vite config, so a `resolve` stated at the
 * root is silently ignored under `projects`. Same reasoning as _sandbox/sandbox/vitest.config.ts.
 *
 * No `@vitejs/plugin-vue`: the composable tests build their host component with `h()` rather than an SFC, so
 * nothing here needs SFC compilation and the extension needs no extra dependency for it. Nothing needs a
 * BROWSER either — useRuns.test.ts mounts through a stub renderer, and the comment there says what asking for
 * jsdom cost this package in CI. */
const resolve = { conditions: [`@intentic/src`] };

/* The two budgets, from the one place that defines them, rather than the single default this package used to
 * run everything under. docsTool.integration.test.ts drives real git in temp trees — thirteen tests, the slowest
 * of them a second when the machine is idle — and it was held to the 5s hang detector meant for in-memory work.
 * That is the budget shape AGENTS.md warns about: it fails on contention rather than on regressions, on the same
 * loaded runners that were already timing this package's workers out. */
export default defineConfig({
    test: {
        projects: [
            { resolve, test: UNIT_SUITE },
            { resolve, test: INTEGRATION_SUITE },
        ],
    },
});
