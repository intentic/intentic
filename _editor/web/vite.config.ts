import { readFileSync, statSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
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

// The daemon loads the contract compiled; this app bundles it from source, and only the first of those follows an edit
// immediately. So an uncompiled contract change reads, to every version check there is, as two builds disagreeing — and
// the remedy that looks cheapest, reloading the page, cannot fix it. The browser already holds the source side; this
// hands it the compiled one, which is what the sandbox would advertise if it restarted right now, and it diffs the two
// itself. Dev only: a production build ships both sides compiled and serves no such route, which reads as no evidence.
const CONTRACT_DIST = here(`../../_shared/sandbox-contract/dist/index.js`);

// A shape map keyed by route name, which is all either side is read for here.
type ShapeModule = { readonly SANDBOX_ROUTE_SHAPES: Readonly<Record<string, string>> };

// Node caches a file: import for the process's life, so a rebuild would keep answering with the copy loaded before it.
// The dist's own mtime in the specifier makes a rebuilt file a different module, and an untouched one a cache hit.
const loadCompiledContract = async (): Promise<ShapeModule> =>
    (await import(`${pathToFileURL(CONTRACT_DIST).href}?built=${statSync(CONTRACT_DIST).mtimeMs}`)) as ShapeModule;

const contractFreshness = (): Plugin => ({
    name: `intentic-contract-freshness`,
    configureServer(server) {
        server.middlewares.use(`/contract-freshness.json`, (_request, response) => {
            void (async () => {
                response.setHeader(`content-type`, `application/json`);
                response.setHeader(`cache-control`, `no-store`);
                try {
                    const compiled = await loadCompiledContract();
                    response.end(JSON.stringify({ compiled: compiled.SANDBOX_ROUTE_SHAPES }));
                } catch {
                    // A contract that has never been built, or one whose dist cannot load, leaves the question open
                    // rather than answering "compiled and fine".
                    response.statusCode = 503;
                    response.end(`{}`);
                }
            })();
        });
    },
});

export default defineConfig(({ command }) => ({
    ...shared,
    plugins: [...shared.plugins, buildStamp(), contractFreshness()],
    server: {
        host: "localhost",
        // Must stay 47145: CORS, Better Auth's WEB_ORIGIN, and Google's OAuth client all trust this exact origin.
        port: 47145,
        strictPort: true,
        // Shares the API's local dev cert, so the two origins keep one trust chain and the session cookie carries with
        // no mixed-content warnings. Minted by `pnpm install`, trusted by `pnpm cert:trust`; path is per-user
        // (_tools/localhost-https).
        // Read only while serving: `vite build` loads this same config, and a machine that never runs the dev server
        // (CI, a sandbox) has no leaf to read — a build that needs one fails where nothing was ever going to serve.
        ...(command === `serve` ? { https: { cert: readFileSync(LEAF_CRT), key: readFileSync(LEAF_KEY) } } : {}),
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
}));
