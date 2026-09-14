import { defineConfig } from "vite";

/* The BACKEND bundle: dist/server.js, the manifest's `server` entry. */
export default defineConfig({
    build: {
        ssr: "src/server/server.ts",
        outDir: "dist",
        target: "node22",
        rollupOptions: {
            output: { entryFileNames: "server.js" },
        },
    },
    ssr: {
        noExternal: true,
    },
});
