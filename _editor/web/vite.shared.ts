import tailwindcss from "@tailwindcss/vite";
import vue from "@vitejs/plugin-vue";
import { shikiLangDeps } from "../../_editor/ui/src/composables/shikiLangs.ts";
import { sourceAliases } from "./source-aliases.ts";

/* Everything about building THIS SOURCE that holds whichever entry is being served — the app's own
 * (vite.config.ts), or the interactive demo's (`@intentic-dev/demo`, which reaches this through the package's
 * `./vite-shared` export). Only the entry, the base, the outDir and the dev server differ between them.
 *
 * Its own module rather than an export off vite.config.ts, because the demo importing that would pull the app's
 * dev-server block with it — including a readFileSync of a certificate the demo has no use for. */
export const shared = {
    plugins: [vue(), tailwindcss()],
    // One fresh id per build (and per dev-server start), read via buildId() (composables/buildEpoch.ts). It is
    // what invalidates everything the browser persisted under the PREVIOUS build — nobody has to remember to
    // bump a schema number when a cached shape changes, because every deploy is its own bump. The cost is one
    // stale-while-revalidate paint lost per update, which nothing waits on.
    define: { "import.meta.env.BUILD_ID": JSON.stringify(String(Date.now())) },
    resolve: {
        // Source-first workspace aliases, shared with vitest.config.ts — see source-aliases.ts for why.
        alias: sourceAliases(),
    },
    optimizeDeps: {
        // Shiki's core/engine/themes are statically imported by useHighlighter, so the dep optimizer finds
        // and pre-bundles them. The grammars, though, load via dynamic import from the source-linked ui lib,
        // which the optimizer leaves un-prebundled — it then serves 504 for every grammar chunk, so the
        // <Code> highlighter (and Monaco) silently fall back to unhighlighted text. Pre-bundle them all.
        // Vue Flow + dagre reach the graph the same way (lazy views importing DagGraph from the source-linked
        // ui lib), so they need the same treatment, and so does mermaid — which MermaidDiagram imports lazily
        // on the first document that holds a diagram, and which un-prebundled costs hundreds of separate
        // grammar requests before it draws anything.
        //
        // The names are resolved from the consuming config's `root`, which is why the demo package declares
        // these six itself: pnpm does not hoist, so its root cannot see what it never asked for.
        include: [
            `shiki/core`,
            `shiki/engine/javascript`,
            `@shikijs/themes/light-plus`,
            `@shikijs/themes/dark-plus`,
            `@vue-flow/core`,
            `@dagrejs/dagre`,
            `mermaid`,
            ...shikiLangDeps,
        ],
    },
};
