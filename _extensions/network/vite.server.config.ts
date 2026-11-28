import { defineConfig } from "vite";

export default defineConfig({
    build: { ssr: "src/server/server.ts", outDir: "dist", emptyOutDir: true, target: "node24", rollupOptions: { output: { entryFileNames: "server.js" } } },
    ssr: { noExternal: true },
});
