import tailwindcss from "@tailwindcss/vite";
import vue from "@vitejs/plugin-vue";
import { join } from "node:path";
import { repoRoot } from "@intentic/constants/node";
import { defineConfig } from "vite";

const root = repoRoot(import.meta.url);

// The launcher window's UI. Dev server port is pinned for tauri.conf.json's devUrl; the production
// build is plain static files bundled into the app (frontendDist: ../dist).
export default defineConfig({
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
