import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { LEAF_CRT, LEAF_KEY } from "@intentic-app/localhost-https/paths";
import { defineConfig } from "vite";
import { shared } from "./vite.shared.ts";

// Resolve a path relative to this config file (which lives at the app root, _editor/web/).
const here = (path: string): string => fileURLToPath(new URL(path, import.meta.url));

/* PUBLIC DEV MODE (`pnpm dev:public`): the tunnel hub serves this same dev server under WEB_ORIGIN's public
 * hostname, so the HMR client must dial the tunnel — wss://<host>:443, riding the hub back to this listener —
 * instead of the local port baked in by default. Only HMR needs pointing: vite's Host check is skipped on an
 * https server (DNS rebinding needs plain http), so no allowedHosts entry is required. Plain local dev leaves
 * WEB_ORIGIN unset (or localhost) and none of this applies. */
const publicHost = ((): string | undefined => {
    const origin = process.env["WEB_ORIGIN"];
    if (origin === undefined || origin === "") {
        return undefined;
    }
    const host = new URL(origin).hostname;
    return host === "localhost" || host === "127.0.0.1" ? undefined : host;
})();

export default defineConfig({
    ...shared,
    server: {
        host: "localhost",
        // Must stay 47145 — the API's CORS + Better Auth trust WEB_ORIGIN (https://localhost:47145 by
        // default), the Google client authorizes the exact origin, and dev:public binds its tunnel here.
        port: 47145,
        strictPort: true,
        ...(publicHost === undefined ? {} : { hmr: { protocol: "wss", host: publicHost, clientPort: 443 } }),
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
            // src/composables/usePopout.ts) — its own document so a pop-out window carries a real URL and icon
            // instead of about:blank.
            input: { index: here("./index.html"), popout: here("./popout.html") },
        },
    },
});
