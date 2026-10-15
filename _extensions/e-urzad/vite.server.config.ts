import { defineConfig } from "vite";

/* The backend bundle: dist/server.js, the manifest's `server` entry. Nothing but node builtins exists where the daemon's extension host loads it, so everything else is bundled in. */
export default defineConfig({
    resolve: { conditions: ["@intentic/src"] },
    build: {
        ssr: "src/server/server.ts",
        outDir: "dist",
        emptyOutDir: true,
        target: "node22",
        rollupOptions: { output: { entryFileNames: "server.js" } },
    },
    ssr: { noExternal: true, resolve: { conditions: ["@intentic/src"], externalConditions: ["@intentic/src"] } },
});
