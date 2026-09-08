import { defineConfig } from "vite";

// `obsidian` CLI: dist/bin/obsidian, beside `kb` on the agent's PATH via `contributes.bin`. Own build because Vite's
// ssr build takes a single entry per config. Same reasoning as kb's config: built from this package's TypeScript,
// self-contained, exec bit set by the image.
export default defineConfig({
    build: {
        ssr: "src/cli/obsidian.ts",
        outDir: "dist/bin",
        // kb's build already wrote dist/bin; without this, the second build empties it and ships only one CLI.
        emptyOutDir: false,
        target: "node22",
        rollupOptions: {
            output: { entryFileNames: "obsidian", banner: "#!/usr/bin/env node" },
        },
    },
    ssr: {
        noExternal: true,
    },
});
