import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { LEAF_CRT, LEAF_KEY } from "@intentic/localhost-https/paths";
import { defineConfig, type Plugin } from "vite";
import { BUILD_ID, shared } from "./vite.shared.ts";

// Resolve a path relative to this config file (which lives at the app root, _editor/web/).
const here = (path: string): string => fileURLToPath(new URL(path, import.meta.url));

// The only way a long-lived tab can learn it's stale: the desktop webview is hidden, not destroyed, and rarely reloads,
// and the bundle only knows what it's running. Served with no-store, in dev too, so the poll can't hit a cache.
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
        // Must stay 47145: CORS, Better Auth's WEB_ORIGIN, and Google's OAuth client all trust this exact origin.
        port: 47145,
        strictPort: true,
        // Shares the API's local dev cert, so the two origins keep one trust chain and the session cookie carries with
        // no mixed-content warnings. Minted by `pnpm install`, trusted by `pnpm cert:trust`; path is per-user
        // (_tools/localhost-https).
        https: {
            cert: readFileSync(LEAF_CRT),
            key: readFileSync(LEAF_KEY),
        },
    },
    build: {
        outDir: "dist",
        emptyOutDir: true,
        target: "es2024",
        // Keeps one stylesheet identity across routes; a per-route CSS link would rebuild DevTools' Styles editor.
        cssCodeSplit: false,
        rolldownOptions: {
            // One HTML entry: a floating panel is a route (/floating/<panel>), not a separate page to build.
            input: { index: here("./index.html") },
        },
    },
});
