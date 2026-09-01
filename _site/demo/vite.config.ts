import { join } from "node:path";
import { packageRoot, repoRoot } from "@intentic/constants/node";
import { defineConfig, type Plugin } from "vite";
// Relative, not through the package's exports: Vite bundles a config's RELATIVE imports (so the .ts sources
// behind them are compiled with it) and leaves bare specifiers to Node, which cannot load TypeScript. The
// package dependency in package.json is the real statement; this is how a build config reaches another one.
import { shared } from "../../_editor/web/vite.shared.ts";

/* The demo builds the SAME source as the app, `shared` above is the app's own plugin/alias/prebundle setup,
 * imported through its package rather than copied, and differs only in where it enters (this package's
 * index.html), where it is served from, and where it lands.
 *
 * `base` is what makes vue-router cooperate: createWebHistory() reads import.meta.env.BASE_URL, so the demo's
 * history paths are `/demo/agents`, `/demo/workspace/…`, the app's own routes, under one prefix the marketing
 * site's worker can serve with a single fallback.
 *
 * It builds INTO the site's `public/`, which Astro copies verbatim into its dist, so the demo ships as part of
 * one site deploy, at the same origin as the page that embeds it. Same-origin matters beyond convenience: a
 * cross-origin iframe gets partitioned storage, and the demo seeds its credentials into localStorage before the
 * app boots. `public/demo/` is gitignored, and a site build with no demo in it simply has no /demo/, the two
 * builds are ordered (the site depends on this package) but not entangled. */

// Paths from the monorepo root, and paths inside this package. Both anchors are FOUND rather than counted, so
// neither this file's depth nor the number of `../` between here and _editor is part of any answer below.
const fromRoot = (path: string): string => join(repoRoot(import.meta.url), path);
const here = (path: string): string => join(packageRoot(import.meta.url), path);

/* Serve `index.html` for every DOCUMENT request, which is the same thing the site's worker is told for
 * production: the demo is a history-mode SPA, so `/demo/agents`, `/demo/workspace/api/src/stripe.ts` and
 * `/demo/floating/chat` are its routes, not its files. Keyed on `Accept: text/html` rather than on the path's
 * shape, because a workspace route legitimately ends in `.ts`, a navigation says what it wants, and module or
 * asset requests never ask for html.
 *
 * No exceptions any more. A floating panel used to live on a page of its own, teleported into from the tab that
 * opened it, and that page had to be excepted by name or the fallback booted a second copy of the demo into it.
 * A floating panel is an ordinary route of the app now (_editor/web/src/composables/floating.ts), so it wants
 * exactly this fallback. */
const spaFallback = (): Plugin => ({
    name: `demo-spa-fallback`,
    configureServer: (server) => {
        // A middleware registered here runs BEFORE Vite's own, which is before the base prefix is stripped, so
        // the rewrite has to carry the base too, or Vite reads `/index.html` as outside the base and bounces it
        // back to `/demo/`, forever.
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
            // The app's entry, source-first, the same treatment `shared` gives every workspace lib, and the
            // mapping this package's tsconfig `paths` already declares. `package.json` names the dependency;
            // this is how it resolves, with no dist between an app edit and the demo showing it.
            "@intentic-app/web/main": fromRoot(`_editor/web/src/main.ts`),
            // The extensions THIS app build compiled in, which the fixture's GET /extensions enumerates. Read
            // from the app rather than re-listed here on purpose: a demo whose list is one extension short shows
            // that extension as image/app drift, in the app's own alarmed wording.
            "@intentic-app/web/builtins": fromRoot(`_editor/web/src/extension-host/builtins.ts`),
            // How the app persists a window's open chat tabs. The recording seeds four of them (fixture/
            // openChats.ts), and takes the shape from the app so a change to the strip's stored form is a
            // build error here rather than four rows that quietly stop appearing.
            "@intentic-app/web/chat-tabs": fromRoot(`_editor/web/src/composables/chat/tabSnapshot.ts`),
        },
    },
    base: `/demo/`,
    // The app's own static assets, its logo, and the `ext-shims/` modules an extension bundle's bare `vue` /
    // `@intentic/extension-api` imports resolve to through index.html's import map. The demo serves the app, so
    // it serves the app's public dir; nothing of its own belongs here.
    publicDir: fromRoot(`_editor/web/public`),
    // Plain http on its own port: the demo talks to nothing real, so there is no cross-origin cookie, no Google
    // client and no mixed content to keep the app's dev certificate for. The app's dev server is untouched.
    // `127.0.0.1` rather than `localhost`, which Node resolves to ::1 on a dual-stack host: the site's dev
    // server proxies /demo/ here (_site/site/astro.config.mjs) and Vite rewrites a `localhost` proxy target to
    // 127.0.0.1, so a v6-only listener is refused. Pinning the family makes both ends name the same socket.
    server: { host: `127.0.0.1`, port: 47146, strictPort: true },
    build: {
        outDir: fromRoot(`_site/site/public/demo`),
        emptyOutDir: true,
        target: `es2024`,
        /* The demo installs its fixture transports before dynamically importing the real app entry. With one
         * extracted stylesheet Vite otherwise treats every lazy route as a dependency of that import and waits
         * for the whole route graph before evaluating main.ts. The stylesheet is already linked from the HTML;
         * route code remains lazy and the app's own idle prefetcher warms it after the shell has mounted. */
        modulePreload: false,
        // Match the app build's stable stylesheet ownership: route chunks may stay lazy, their CSS may not
        // arrive underneath an open DevTools Styles editor when the visitor changes views.
        cssCodeSplit: false,
        // One document, the same as the app's: a floating panel is a route rather than a page of its own.
        rolldownOptions: { input: { index: here(`index.html`) } },
    },
});
