import { join } from "node:path";
import vue from "@vitejs/plugin-vue";
import { repoRoot } from "@intentic/constants/node";
import { defineConfig } from "vitest/config";
import { INTEGRATION_SUITE, UNIT_SUITE } from "@intentic/testing/vitest";
import { sourceAliases } from "../web/source-aliases.ts";

// The same resolution the build uses (vite.config.ts), a test that resolved the app's chat components
// differently from the page would be testing something the page never renders.
const fromRoot = (path: string): string => join(repoRoot(import.meta.url), path);

// ON EACH PROJECT, not at the top level — including the plugin. A project is its own Vite config, so a
// `plugins` or `resolve` stated once above `projects` is silently ignored: the aliases would fall back to the
// injected node_modules copies, and an SFC would reach the runner uncompiled. Same reasoning as
// _search/iq/vitest.config.ts.
const project = {
    plugins: [vue()],
    resolve: {
        alias: {
            "@intentic-app/web": fromRoot("_editor/web/src"),
            "@intentic/ui/src": fromRoot("_editor/ui/src"),
            ...sourceAliases(),
        },
    },
};

export default defineConfig({
    test: {
        projects: [
            { ...project, test: UNIT_SUITE },
            { ...project, test: INTEGRATION_SUITE },
        ],
    },
});
