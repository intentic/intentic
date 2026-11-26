import { defaultServerConditions, defineConfig } from "vite";

/* The two node bundles: dist/server.js, the manifest's `server` (the public door's routes and the install panel's reads),
and dist/gateway.js, its `gateway` process (the reply outbox's writer). Nothing but node builtins exists at runtime, so
everything else is bundled in. The widget a visitor's browser loads is copied in after (scripts/widget.mjs). */
export default defineConfig({
    build: {
        ssr: true,
        outDir: "dist",
        emptyOutDir: true,
        target: "node22",
        rollupOptions: {
            input: { server: "src/server/server.ts", gateway: "src/gateway/gateway.ts" },
            output: { entryFileNames: "[name].js" },
        },
    },
    ssr: {
        noExternal: true,
        // A Turbo cache hit restores the workspace's dist and can leave pnpm's injected copies stale.
        resolve: { conditions: ["@intentic/src", ...defaultServerConditions] },
    },
});
