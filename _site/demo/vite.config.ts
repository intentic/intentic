import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { noteStop, parseRecord, PREVIEW_IDLE_MS, RECORD_ENV, TOUCH_EVERY_MS, touchRecord } from "@intentic/constants/dev-previews";
import { packageRoot, repoRoot } from "@intentic/constants/node";
import { defineConfig, type Plugin } from "vite";
import { MONACO_WORKER, shared, sharedCacheConfig } from "../../_editor/web/vite.shared.ts";

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
        server.middlewares.use((request, response, next) => {
            // The bare origin is where a preview frame opens (the repository's Start, see the root Procfile): send it to
            // the app's own base rather than mounting the app at a path its router does not know.
            if (request.method === `GET` && request.url === `/` && server.config.base !== `/`) {
                response.statusCode = 302;
                response.setHeader(`Location`, server.config.base);
                response.end();
                return;
            }
            if (request.method === `GET` && request.headers.accept?.includes(`text/html`) === true) {
                request.url = entry;
            }
            next();
        });
    },
});

// The demo's element worker (src/world/element-worker.js), served and built at the base itself, since a service worker
// controls only what sits under its own script's folder and every editor route is under the base.
const ELEMENT_WORKER = `element-worker.js`;
const elementWorker = (): Plugin => {
    const source = (): string => readFileSync(here(`src/world/${ELEMENT_WORKER}`), `utf8`);
    return {
        name: `demo-element-worker`,
        configureServer: (server) => {
            server.middlewares.use((request, response, next) => {
                if (request.url?.split(`?`)[0] !== `${server.config.base}${ELEMENT_WORKER}`) {
                    next();
                    return;
                }
                response.setHeader(`Content-Type`, `text/javascript; charset=utf-8`);
                response.setHeader(`Cache-Control`, `no-cache`);
                response.end(source());
            });
        },
        generateBundle() {
            this.emitFile({ type: `asset`, fileName: ELEMENT_WORKER, source: source() });
        },
    };
};

// SERVE ONLY, and only for a managed preview (scripts/dev.mjs names its record in INTENTIC_PREVIEW_RECORD): keeps the
// record's lastActiveAt current while the server is used, and stops the server once it has gone PREVIEW_IDLE_MS with no
// request for the app and no page holding its HMR socket. The reason is noted beside the record first, so the conversation's next
// start says why its preview is gone. The daemon's keeper stops one whose own timer never fired
// (_sandbox/sandbox/src/processes/dev-previews.ts).
const previewKeeper = (): Plugin => ({
    name: `demo-preview-keeper`,
    apply: `serve`,
    configureServer: (server) => {
        const path = process.env[RECORD_ENV];
        if (path === undefined || path === ``) {
            return;
        }
        let usedAt = Date.now();
        let touchedAt = 0;
        // Only the app's own paths count: the daemon's port probe asks for `/` every half minute
        // (_sandbox/sandbox/src/ports/port-probe.ts), and that is nobody using the page.
        server.middlewares.use((request, _response, next) => {
            if (request.url?.startsWith(server.config.base) === true) {
                usedAt = Date.now();
            }
            next();
        });
        const tick = setInterval(() => {
            const now = Date.now();
            if (server.ws.clients.size > 0) {
                usedAt = now;
            }
            if (usedAt > touchedAt) {
                touchRecord(path, usedAt);
                touchedAt = usedAt;
            }
            if (now - usedAt < PREVIEW_IDLE_MS) {
                return;
            }
            clearInterval(tick);
            let record;
            try {
                record = parseRecord(readFileSync(path, `utf8`));
            } catch {
                // allow(silent-catch): a record already removed was stopped by someone else; this server goes either way.
            }
            if (record !== undefined) {
                noteStop(dirname(path), record, `idle: no request and no open page for ${String(PREVIEW_IDLE_MS / 60_000)} minutes`);
            }
            void server.close().finally(() => process.exit(0));
        }, TOUCH_EVERY_MS);
        tick.unref();
    },
});

const alias = {
    ...shared.resolve.alias,
    // App's entry, source-first; no dist between an app edit and the demo showing it.
    "@intentic/web/main": fromRoot(`_editor/web/src/main.ts`),
    // Extensions this build compiled in; read from the app so the fixture's list can't drift out of sync.
    "@intentic/web/builtins": fromRoot(`_editor/web/src/extension-host/builtins.ts`),
    // How the app persists open chat tabs; sharing its shape turns a format change into a build error.
    "@intentic/web/chat-tabs": fromRoot(`_editor/web/src/models/conversations/tabs/tabSnapshot.ts`),
};
// The app's list, with monaco's worker reached through the app: the demo has no monaco of its own to resolve it from.
const optimizeDeps = {
    ...shared.optimizeDeps,
    include: shared.optimizeDeps.include.map((name) => (name === MONACO_WORKER ? `@intentic/web > ${MONACO_WORKER}` : name)),
};
// The optimizer's cache, shared by every tree with the same inputs, outside node_modules (vite.shared.ts, "SHARED
// OPTIMIZER CACHE").
const cache = sharedCacheConfig(
    `demo`,
    {
        files: [here(`vite.config.ts`), fromRoot(`_editor/web/vite.shared.ts`), fromRoot(`_editor/web/source-aliases.ts`)],
        optimizeDeps,
        resolve: { alias, conditions: shared.resolve.conditions },
    },
    here(``),
);

export default defineConfig({
    ...shared,
    plugins: [...shared.plugins, elementWorker(), spaFallback(), cache.plugin, previewKeeper()],
    // The shared resolve, its source-first conditions with it; only the aliases above are added.
    resolve: { ...shared.resolve, alias },
    optimizeDeps,
    cacheDir: cache.cacheDir,
    base: `/demo/`,
    // App's own public dir (assets, ext-shims/); the demo serves the app, so nothing of its own belongs here.
    publicDir: fromRoot(`_editor/web/public`),
    // 127.0.0.1, not localhost: Node resolves that to ::1, and the site's dev proxy targets 127.0.0.1.
    server: {
        host: `127.0.0.1`,
        port: 47146,
        strictPort: true,
        // Started by the sandbox's Start (the root Procfile, which passes the PORT it assigns), the server is reached
        // through the preview proxy, which forwards its own `preview-<repo>-<sandboxId>.<zone>` Host unchanged. Run by
        // hand or as an agent's managed preview there is no PORT, and Vite's default ([]: localhost and IPs) stands.
        allowedHosts: process.env[`PORT`] === undefined ? [] : true,
        fs: { allow: cache.fsAllow },
        // The app's start, transformed as the server comes up (see the app's own vite.config.ts): the demo's entry, and
        // the app's, which it imports dynamically after installing its fakes, so no crawl from the first reaches it.
        warmup: {
            clientFiles: [
                here(`src/main.ts`),
                fromRoot(`_editor/web/src/main.ts`),
                fromRoot(`_editor/web/src/shell/WorkspaceShell.vue`),
                fromRoot(`_editor/web/src/shell/ShellDesktop.vue`),
                fromRoot(`_editor/web/src/shell/ShellMobile.vue`),
            ],
        },
    },
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
