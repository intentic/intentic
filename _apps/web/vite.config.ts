import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";
import { shared } from "./vite.shared.ts";

// Resolve a path relative to this config file (which lives at the app root, _apps/web/).
const here = (path: string): string => fileURLToPath(new URL(path, import.meta.url));

export default defineConfig({
    ...shared,
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
        rolldownOptions: {
            // Two HTML entries: the app, and the page a popped-out panel is teleported into (see
            // src/composables/usePopout.ts) — its own document so a pop-out window carries a real URL and icon
            // instead of about:blank.
            input: { index: here("./index.html"), popout: here("./popout.html") },
        },
    },
});
