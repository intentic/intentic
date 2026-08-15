import { defineConfig } from "vite";

/* The `obsidian` CLI: dist/bin/obsidian, beside `kb` in the directory `contributes.bin` puts on the AGENT's
 * PATH each turn.
 *
 * Its own build rather than a second entry in the `kb` one, because Vite's ssr build takes a single entry and
 * each of these has to come out as a bare executable with a shebang banner — two files, two configs, same
 * shape. Everything else about it is the kb config's reasoning verbatim: built from this package's TypeScript
 * so a vault note is parsed by the same reader the panel uses, self-contained because the baked checkout
 * carries no node_modules, and the exec bit granted by the image (the Dockerfile COPYs dist/bin --chmod=755). */
export default defineConfig({
    build: {
        ssr: "src/cli/obsidian.ts",
        outDir: "dist/bin",
        // The kb build wrote this directory first; without this the second build empties it again and ships
        // one of the two CLIs.
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
