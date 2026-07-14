import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import tailwindcss from "@tailwindcss/vite";
import vue from "@vitejs/plugin-vue";
import { defineConfig } from "vite";
import { shikiLangDeps } from "../../_libs/ui/src/vue/shikiLangs.js";
import { sourceAliases } from "./source-aliases";

// Resolve a path relative to this config file (which lives at the app root, _apps/web/).
const here = (path: string): string => fileURLToPath(new URL(path, import.meta.url));

export default defineConfig({
    plugins: [vue(), tailwindcss()],
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
        // ui lib), so they need the same treatment.
        include: [
            `shiki/core`,
            `shiki/engine/javascript`,
            `@shikijs/themes/light-plus`,
            `@shikijs/themes/dark-plus`,
            `@vue-flow/core`,
            `@dagrejs/dagre`,
            ...shikiLangDeps,
        ],
    },
    server: {
        host: "localhost",
        // Must stay 47145 — the API's CORS + Better Auth trust WEB_ORIGIN=https://localhost:47145, and the
        // Google client authorizes this exact origin.
        port: 47145,
        strictPort: true,
        // The same committed dev cert is used by the API and Vite, so https:47145 -> https:6480 shares a
        // trust chain and the session cookie rides along with no mixed-content warnings.
        https: {
            cert: readFileSync(here("./node_modules/@intentic-app/localhost-https/localhost.crt")),
            key: readFileSync(here("./node_modules/@intentic-app/localhost-https/localhost.key")),
        },
    },
    build: {
        outDir: "dist",
        emptyOutDir: true,
        target: "es2024",
    },
});
