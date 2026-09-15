import tailwindcss from "@tailwindcss/vite";
import vue from "@vitejs/plugin-vue";
import { join } from "node:path";
import { repoRoot } from "@intentic/constants/node";
import { defineConfig } from "vite";

const root = repoRoot(import.meta.url);

// The launcher window's UI. Dev server port is pinned for tauri.conf.json's devUrl; the production
// build is plain static files bundled into the app (frontendDist: ../dist).
export default defineConfig({
/* The analytics key, baked in at build time, this app is a compiled binary. */
    define: { __POSTHOG_KEY__: JSON.stringify(process.env.POSTHOG_KEY ?? ``) },
    plugins: [vue(), tailwindcss()],
    resolve: {
        alias: {
            // Subpath before the barrel: a string alias also matches `<key>/…`, so the barrel would swallow this
            // and resolve into a directory.
            "@intentic/ui/device-agent": join(root, `_editor/ui/src/components/sandbox/deviceAgent.ts`),
            "@intentic/ui": join(root, `_editor/ui/src/index.ts`),
        },
    },
    clearScreen: false,
    server: {
        host: `localhost`,
        port: 47146,
        strictPort: true,
    },
    build: {
        outDir: `dist`,
        emptyOutDir: true,
        target: `es2024`,
    },
});
