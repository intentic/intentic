import { defineConfig } from "vite";

/* The server bundle: one node ES module exporting `activateServer`, with everything but node builtins bundled in, since
   the backend host provides nothing else at runtime. */
export default defineConfig({
    build: {
        ssr: "src/server.ts",
        outDir: "dist",
        emptyOutDir: false,
        rollupOptions: { output: { entryFileNames: "server.js", format: "es" } },
    },
});
