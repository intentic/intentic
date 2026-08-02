import tailwindcss from "@tailwindcss/vite";
import vue from "@vitejs/plugin-vue";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";

// The launcher window's UI. Dev server port is pinned for tauri.conf.json's devUrl; the production
// build is plain static files bundled into the app (frontendDist: ../dist).
export default defineConfig({
    plugins: [vue(), tailwindcss()],
    resolve: {
        alias: {
            "@intentic/ui": fileURLToPath(new URL(`../../_libs/ui/src/index.ts`, import.meta.url)),
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
