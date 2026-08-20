import tailwindcss from "@tailwindcss/vite";
import vue from "@vitejs/plugin-vue";
import { join } from "node:path";
import { repoRoot } from "@intentic/constants/node";
import { defineConfig } from "vite";

const root = repoRoot(import.meta.url);

// The launcher window's UI. Dev server port is pinned for tauri.conf.json's devUrl; the production
// build is plain static files bundled into the app (frontendDist: ../dist).
export default defineConfig({
    /* The analytics key, baked in at build time, this app is a compiled binary, so there is no container
     * entrypoint to substitute one at start the way the web image does. Unset leaves it empty, which is what
     * switches analytics off (src/analytics.ts): every local `tauri build` and every dev run reports nothing,
     * and only the release workflow passes a key. */
    define: { __POSTHOG_KEY__: JSON.stringify(process.env.POSTHOG_KEY ?? ``) },
    plugins: [vue(), tailwindcss()],
    resolve: {
        alias: {
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
