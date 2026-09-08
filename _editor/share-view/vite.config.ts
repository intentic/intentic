import { join } from "node:path";
import tailwindcss from "@tailwindcss/vite";
import vue from "@vitejs/plugin-vue";
import { repoRoot } from "@intentic/constants/node";
import { defineConfig } from "vite";
import { sourceAliases } from "../web/source-aliases.ts";
import { SHARE_VIEWER_BASE } from "../../_shared/sandbox-contract/src/ids/share-paths.ts";

// Builds the page a shared conversation renders as, compiling the app's own chat components directly so a
// recipient sees the same code, with no router, daemon client or store in the bundle. `base` is fixed
// (share-paths.ts) so every share loads one shared copy of assets from `/conversations/_viewer/`.

const fromRoot = (path: string): string => join(repoRoot(import.meta.url), path);

export default defineConfig({
    base: SHARE_VIEWER_BASE,
    plugins: [vue(), tailwindcss()],
    resolve: {
        alias: {
            // Listed before the workspace aliases, since a string alias also matches `<key>/…`.
            "@intentic/web": fromRoot("_editor/web/src"),
            // Design system by file, not its barrel; ordered before @intentic/ui so this deeper key wins.
            "@intentic/ui/src": fromRoot("_editor/ui/src"),
            ...sourceAliases(),
        },
    },
    optimizeDeps: {
        // Un-prebundled, these 504 in dev and code bodies silently fall back to plain text.
        include: [`shiki/core`, `shiki/engine/javascript`, `@shikijs/themes/light-plus`, `@shikijs/themes/dark-plus`],
    },
    build: {
        outDir: "dist",
        emptyOutDir: true,
        // Deliberately generous, since a shared link's recipient uses a browser this app didn't choose.
        target: "es2022",
        // Splits the DagGraph chunk (Vue Flow + dagre + a stylesheet) out by hand: the design system's barrel imports
        // it
        // statically for the shared tool card's highlighter/diff-stat, which would otherwise pull it into every page's
        // bundle instead of loading it lazily.
        rollupOptions: { output: { advancedChunks: { groups: [{ name: `dag-graph`, test: /DagGraph\.vue|@vue-flow|@dagrejs/ }] } } },
    },
});
