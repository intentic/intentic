import { defineConfig } from "vite";

/* The BACKEND bundle: dist/server.js, the manifest's `server` entry. A node SSR build with everything
 * bundled in (noExternal), because the backend host imports the file from a checkout that has no
 * node_modules, self-contained but for node builtins is the rule the manifest schema states. The UI half
 * needs no build at all: it is compiled into the web app (extension-host/builtins.ts). */
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
