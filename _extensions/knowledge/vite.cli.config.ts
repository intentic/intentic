import { defineConfig } from "vite";

// `kb` CLI: dist/bin/kb, on the agent's PATH via `contributes.bin`. Built from the same TypeScript as the backend,
// self-contained (no node_modules). Shebang is a rollup banner, not source text, since `#!` inside a bundle is a syntax
// error; exec bit is set by the image's Dockerfile.
export default defineConfig({
    build: {
        ssr: "src/cli/kb.ts",
        outDir: "dist/bin",
        target: "node22",
        rollupOptions: {
            output: { entryFileNames: "kb", banner: "#!/usr/bin/env node" },
        },
    },
    ssr: {
        noExternal: true,
    },
});
