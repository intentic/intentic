import { join } from "node:path";
import { packageRoot, repoRoot } from "@intentic/constants/node";
import { defineConfig, type Plugin } from "vite";
import { shared } from "../../_editor/web/vite.shared.ts";

// Builds the same source as the app via `shared` (../../_editor/web/vite.shared.ts), differing only in entry, serving
// and output. `base: /demo/` gives vue-router its history prefix. Builds into the site's `public/demo/` (gitignored) so
// it ships same-origin, which localStorage seeding needs.

// Repo-root and package-root anchors, both found rather than counted, so neither this file's depth nor `../` counts
// matter below.
const fromRoot = (path: string): string => join(repoRoot(import.meta.url), path);
const here = (path: string): string => join(packageRoot(import.meta.url), path);

// Serves `index.html` for every document request (Accept: text/html, not path shape, since a workspace route can end in
// `.ts`). No exceptions: a floating panel is now an ordinary app route.
const spaFallback = (): Plugin => ({
    name: `demo-spa-fallback`,
    configureServer: (server) => {
        // Runs before Vite strips the base prefix, so the rewrite must include the base too.
        const entry = `${server.config.base}index.html`;
        server.middlewares.use((request, _response, next) => {
            if (request.method === `GET` && request.headers.accept?.includes(`text/html`) === true) {
                request.url = entry;
            }
            next();
        });
    },
});

export default defineConfig({
    ...shared,
    plugins: [...shared.plugins, spaFallback()],
    resolve: {
        alias: {
            ...shared.resolve.alias,
            // App's entry, source-first; no dist between an app edit and the demo showing it.
            "@intentic/web/main": fromRoot(`_editor/web/src/main.ts`),
            // Extensions this build compiled in; read from the app so the fixture's list can't drift out of sync.
            "@intentic/web/builtins": fromRoot(`_editor/web/src/extension-host/builtins.ts`),
            // How the app persists open chat tabs; sharing its shape turns a format change into a build error.
            "@intentic/web/chat-tabs": fromRoot(`_editor/web/src/features/chat/tabs/tabSnapshot.ts`),
        },
    },
    base: `/demo/`,
    // App's own public dir (assets, ext-shims/); the demo serves the app, so nothing of its own belongs here.
    publicDir: fromRoot(`_editor/web/public`),
    // 127.0.0.1, not localhost: Node resolves that to ::1, and the site's dev proxy targets 127.0.0.1.
    server: { host: `127.0.0.1`, port: 47146, strictPort: true },
    build: {
        outDir: fromRoot(`_site/site/public/demo`),
        emptyOutDir: true,
        target: `es2024`,
        // Off: otherwise Vite waits for the whole route graph before the dynamic main.ts import runs.
        modulePreload: false,
        // Off: matches the app build, so route CSS doesn't arrive under an open DevTools Styles editor.
        cssCodeSplit: false,
        // One document, same as the app: a floating panel is a route, not a page of its own.
        rolldownOptions: { input: { index: here(`index.html`) } },
    },
});
