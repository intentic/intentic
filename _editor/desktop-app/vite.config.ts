import tailwindcss from "@tailwindcss/vite";
import vue from "@vitejs/plugin-vue";
import { join } from "node:path";
import { repoRoot } from "@intentic/constants/node";
import { defaultClientConditions, defineConfig } from "vite";

const root = repoRoot(import.meta.url);

// The launcher window's UI. Dev server port is pinned for tauri.conf.json's devUrl; the production
// build is plain static files bundled into the app (frontendDist: ../dist).
export default defineConfig({
    /* The analytics key, baked in at build time, this app is a compiled binary. */
    define: { __POSTHOG_KEY__: JSON.stringify(process.env.POSTHOG_KEY ?? ``), __POSTHOG_HOST__: JSON.stringify(process.env.POSTHOG_HOST ?? `https://us.i.posthog.com`) },
    plugins: [vue(), tailwindcss()],
    resolve: {
        alias: {
            // Subpath before the barrel: a string alias also matches `<key>/…`, so the barrel would swallow this
            // and resolve into a directory.
            "@intentic/ui/device-agent": join(root, `_editor/ui/src/components/sandbox/deviceAgent.ts`),
            "@intentic/ui/i18n": join(root, `_editor/ui/src/i18n/index.ts`),
            "@intentic/ui/clipboard": join(root, `_editor/ui/src/lib/clipboard.ts`),
            "@intentic/ui": join(root, `_editor/ui/src/index.ts`),
        },
        // Workspace libraries from source, as the editor's build reads them (../web/vite.shared.ts says why).
        conditions: [`@intentic/src`, ...defaultClientConditions],
    },
    clearScreen: false,
    server: {
        host: `localhost`,
        port: 47146,
        strictPort: true,
        // The local face's dev server (vite.local.config.ts), under the path its windows open in a built app.
        proxy: { "/files": { target: `http://127.0.0.1:47147`, ws: true } },
    },
    build: {
        outDir: `dist`,
        emptyOutDir: true,
        target: `es2024`,
    },
});
