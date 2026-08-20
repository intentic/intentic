import { join } from "node:path";
import { repoRoot } from "@intentic/constants/node";
import { defineConfig } from "vitest/config";
import { INTEGRATION_SUITE, UNIT_SUITE } from "@intentic/testing/vitest";

const root = repoRoot(import.meta.url);

/* The sibling lib's SOURCE, not node_modules, in a worktree, node_modules symlinks to the main checkout,
 * whose dist is whatever was last deployed there; these tests must test this tree.
 *
 * It sits on each PROJECT because a project is its own Vite config: a `resolve` stated once at the top level is
 * silently ignored under `projects`, and the failure that would cause is the quiet kind, a suite passing
 * against a build several changes old. Same reasoning as _sandbox/sandbox/vitest.config.ts. */
const sourceAlias = {
    "@intentic/iq-engine/testing": join(root, "_search/iq-engine/src/testing.ts"),
    "@intentic/iq-engine": join(root, "_search/iq-engine/src/index.ts"),
};

/* Both suites here drive the CLI end to end against a fixture workspace: `makeFixtureWorkspace` copies a tree
 * under tmpdir and runs real git in it, `makeRecallFixture` builds a transcript store, and the engine then
 * indexes what they wrote. That is machine work whose duration is a fact about the runner, so the budget comes
 * from the file name (`@intentic/testing/vitest`) like everywhere else, under the 5s unit detector the first
 * query took 5.7s on a loaded CI runner and broke main. */
export default defineConfig({
    test: {
        projects: [
            { resolve: { alias: sourceAlias }, test: UNIT_SUITE },
            { resolve: { alias: sourceAlias }, test: INTEGRATION_SUITE },
        ],
    },
});
