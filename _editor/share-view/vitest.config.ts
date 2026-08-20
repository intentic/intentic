import { join } from "node:path";
import vue from "@vitejs/plugin-vue";
import { repoRoot } from "@intentic/constants/node";
import { defineConfig } from "vitest/config";
import { sourceAliases } from "../web/source-aliases.ts";

// The same resolution the build uses (vite.config.ts), a test that resolved the app's chat components
// differently from the page would be testing something the page never renders.
const fromRoot = (path: string): string => join(repoRoot(import.meta.url), path);

export default defineConfig({
    plugins: [vue()],
    resolve: {
        alias: {
            "@intentic-app/web": fromRoot("_editor/web/src"),
            "@intentic/ui/src": fromRoot("_editor/ui/src"),
            ...sourceAliases(),
        },
    },
    test: {
        include: ["src/**/*.test.ts"],
    },
});
