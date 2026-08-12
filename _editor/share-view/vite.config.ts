import { join } from "node:path";
import tailwindcss from "@tailwindcss/vite";
import vue from "@vitejs/plugin-vue";
import { repoRoot } from "@intentic/constants/node";
import { defineConfig } from "vite";
// Relative, not through the package's exports: Vite bundles a config's RELATIVE imports (so the .ts sources
// behind them are compiled with it) and leaves bare specifiers to Node, which cannot load TypeScript. The same
// reason @intentic-dev/demo reaches the app's shared config this way.
import { sourceAliases } from "../web/source-aliases.ts";
import { SHARE_VIEWER_BASE } from "../../_sandbox/sandbox-contract/src/share-paths.ts";

/* The build of the page a shared conversation is published as.
 *
 * It compiles the APP's OWN chat components (the alias below reaches straight into the web package's source),
 * which is the whole point: a recipient sees the transcript the owner saw, drawn by the same code, and there is
 * no second renderer to drift. What it does not compile is the app — the page's entry pulls a tool card and the
 * markdown engine, not a router, a daemon client or a store, so nothing in the bundle can reach for a sandbox
 * that a recipient has no business reaching.
 *
 * `base` is absolute and fixed (share-paths.ts): every share's page loads ONE copy of these assets from
 * `/conversations/_viewer/`, so opening a second shared link costs nothing and the daemon copies the assets in
 * once rather than per share.
 *
 * It builds like the widget does, into a `dist/` this package ships as its only files — the daemon depends on
 * the package and copies that directory into the outbox on the first share. */

const fromRoot = (path: string): string => join(repoRoot(import.meta.url), path);

export default defineConfig({
    base: SHARE_VIEWER_BASE,
    plugins: [vue(), tailwindcss()],
    resolve: {
        alias: {
            // The app's chat components, by the path this package's own source names them with. Listed BEFORE
            // the workspace aliases for the same reason source-aliases.ts orders its own subpaths: a string
            // alias also matches `<key>/…`.
            "@intentic-app/web": fromRoot("_editor/web/src"),
            // The design system by FILE rather than through its barrel — see boot.ts for why this page cannot
            // use the barrel's own entry point. Ordered before `@intentic/ui` (which sourceAliases maps to the
            // barrel file) so the deeper key wins.
            "@intentic/ui/src": fromRoot("_editor/ui/src"),
            ...sourceAliases(),
        },
    },
    optimizeDeps: {
        // Shiki's core/engine/themes are statically imported by the shared highlighter (a Read card's body is
        // syntax-highlighted here exactly as it is in the app). Un-prebundled they 504 in dev and the code
        // bodies silently fall back to plain text.
        include: [`shiki/core`, `shiki/engine/javascript`, `@shikijs/themes/light-plus`, `@shikijs/themes/dark-plus`],
    },
    build: {
        outDir: "dist",
        emptyOutDir: true,
        // The floor for what the page uses unguarded, and generous about who can read a shared link: a
        // recipient's browser is not one we chose.
        target: "es2022",
        // Grammars and the highlighter load on demand — a conversation with no code in it should not pay for
        // shiki at all. Chunks are fine here (unlike the widget, which must be one file): the daemon copies the
        // whole directory, and every asset URL is absolute under `base`.
        rollupOptions: {},
    },
});
