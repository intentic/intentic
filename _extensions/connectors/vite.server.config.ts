import { defineConfig } from "vite";

/* The backend bundle: dist/server.js, the manifest's `server` entry. Nothing but node builtins exists at runtime, so everything else is bundled in. */
export default defineConfig({
    build: {
        ssr: "src/server/server.ts",
        outDir: "dist",
        emptyOutDir: true,
        target: "node22",
        rollupOptions: { output: { entryFileNames: "server.js" } },
    },
    ssr: { noExternal: true },
});
