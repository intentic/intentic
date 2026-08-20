import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const here = (path: string): string => fileURLToPath(new URL(path, import.meta.url));

export default defineConfig({
    resolve: {
        /* THE DATE HELPER, FROM SOURCE, an alias rather than the `@intentic/src` export condition, for the
         * reason spelled out in _extensions/workflows/vitest.config.ts: a dependency vitest externalizes is
         * resolved by NODE, which never sees Vite's conditions, so the condition alone leaves the import
         * pointing at the package's default export target.
         *
         * For this kit that target is worse than stale. `@intentic/extension-ui` is PUBLISHED, and its dist is
         * the host BRIDGE, it hands back whatever the running app registered on `globalThis`, which in a test
         * process is nothing, and in a fresh checkout isn't even built. Either way `formatDayMonth` is not
         * there, and episodes.ts fails to LOAD rather than to assert. Same mapping as the app's own
         * source-aliases.ts, one package wide. */
        alias: { "@intentic/extension-ui/format": here(`../../_editor/extension-ui/src/format.ts`) },
    },
    test: {
        include: ["./src/**/*.test.ts"],
        environment: "node",
    },
});
