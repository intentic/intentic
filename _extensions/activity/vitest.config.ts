import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";
import { INTEGRATION_SUITE, UNIT_SUITE } from "@intentic/testing/vitest";

const here = (path: string): string => fileURLToPath(new URL(path, import.meta.url));

/* THE DATE HELPER, FROM SOURCE, an alias rather than the `@intentic/src` export condition, for the
 * reason spelled out in _extensions/workflows/vitest.config.ts: a dependency vitest externalizes is
 * resolved by NODE, which never sees Vite's conditions, so the condition alone leaves the import
 * pointing at the package's default export target.
 *
 * For this kit that target is worse than stale. `@intentic/extension-ui` is PUBLISHED, and its dist is
 * the host BRIDGE, it hands back whatever the running app registered on `globalThis`, which in a test
 * process is nothing, and in a fresh checkout isn't even built. Either way `formatDayMonth` is not
 * there, and episodes.ts fails to LOAD rather than to assert. Same mapping as the app's own
 * source-aliases.ts, one package wide.
 *
 * ON EACH PROJECT, not at the top level: a project is its own Vite config, and a `resolve` stated once above
 * `projects` is silently ignored, which puts the import back on the bridge. Same reasoning as
 * _search/iq/vitest.config.ts. */
const resolve = { alias: { "@intentic/extension-ui/format": here(`../../_editor/extension-ui/src/format.ts`) } };

export default defineConfig({
    test: {
        projects: [
            { resolve, test: UNIT_SUITE },
            { resolve, test: INTEGRATION_SUITE },
        ],
    },
});
