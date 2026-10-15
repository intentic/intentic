import { defineConfig } from "vite";

/* The agent's CLI: dist/cli.js, which bin/e-urzad imports. Bundled whole like the backend, so the deployed tree needs no node_modules. */
export default defineConfig({
    resolve: { conditions: ["@intentic/src"] },
    build: {
        ssr: "src/cli.ts",
        outDir: "dist",
        emptyOutDir: false,
        target: "node22",
        rollupOptions: { output: { entryFileNames: "cli.js" } },
    },
    ssr: { noExternal: true, resolve: { conditions: ["@intentic/src"], externalConditions: ["@intentic/src"] } },
});
