import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { LEAF_CRT, LEAF_KEY } from "@intentic-app/localhost-https/paths";
import { defineConfig, type Plugin } from "vite";
import { BUILD_ID, shared } from "./vite.shared.ts";

// Resolve a path relative to this config file (which lives at the app root, _editor/web/).
const here = (path: string): string => fileURLToPath(new URL(path, import.meta.url));

/* WHICH BUILD IS BEING SERVED RIGHT NOW — one tiny file at the root, and the only way a page can find out that
 * it is out of date.
 *
 * The build id is already compiled INTO the bundle, which answers "what am I running" and cannot answer "what
 * would I get if I reloaded". Everything else about this app is either immutable-and-hashed (/assets/) or the
 * index, so there was nothing a long-lived tab could poll. Deployed continuously, the app has always relied on
 * people happening to reload; inside the desktop app they never do — that webview is HIDDEN on close rather
 * than destroyed, deliberately, so it keeps its session (desktop-app/src-tauri/src/windows.rs), and a page
 * loaded on Monday is still the Monday build on Friday.
 *
 * Served under the nginx default of `no-store` (nginx.conf's $cache_control map), which is what a poll needs:
 * the whole point is to miss the cache. It is emitted in dev too, so the behaviour can be exercised locally
 * rather than only discovered in production.
 */
const buildStamp = (): Plugin => ({
    name: `intentic-build-stamp`,
    generateBundle() {
        this.emitFile({ type: `asset`, fileName: `build.json`, source: JSON.stringify({ buildId: BUILD_ID }) });
    },
    configureServer(server) {
        server.middlewares.use(`/build.json`, (_request, response) => {
            response.setHeader(`content-type`, `application/json`);
            response.end(JSON.stringify({ buildId: BUILD_ID }));
        });
    },
});

export default defineConfig({
    ...shared,
    plugins: [...shared.plugins, buildStamp()],
    server: {
        host: "localhost",
        // Must stay 47145, the API's CORS + Better Auth trust WEB_ORIGIN=https://localhost:47145, and the
        // Google client authorizes this exact origin.
        port: 47145,
        strictPort: true,
        // The same machine-local dev cert is used by the API and Vite, so https:47145 -> https:6480 shares a
        // trust chain and the session cookie rides along with no mixed-content warnings. `pnpm install` mints
        // it and `pnpm cert:trust` approves its root. The location is asked for rather than written down: it is
        // this user's own data directory, which differs per person and per OS (see _tools/localhost-https).
        https: {
            cert: readFileSync(LEAF_CRT),
            key: readFileSync(LEAF_KEY),
        },
    },
    build: {
        outDir: "dist",
        emptyOutDir: true,
        target: "es2024",
        rolldownOptions: {
            // Two HTML entries: the app, and the page a popped-out panel is teleported into (see
            // src/composables/usePopout.ts), its own document so a pop-out window carries a real URL and icon
            // instead of about:blank.
            input: { index: here("./index.html"), popout: here("./popout.html") },
        },
    },
});
