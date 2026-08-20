import { defineConfig } from "vite";

/* The `kb` CLI: dist/bin/kb, the directory the manifest's `contributes.bin` puts on the AGENT's PATH each turn.
 *
 * BUILT rather than hand-written as plain ESM (the intentic-docs precedent), because the knowledge engine it drives
 * is the same TypeScript the backend serves, one parser, one link resolver, one index, one set of tests over
 * them. A second hand-maintained copy on the agent's side is the drift this repo already paid for once, and here
 * it would show up as the agent and the panel disagreeing about what the notes say.
 *
 * Self-contained for the same reason the server bundle is: the baked checkout carries no node_modules. The
 * shebang is a banner rather than a source line, a `#!` inside an imported module is a syntax error in the
 * middle of a bundle, and the exec bit is granted by the image (the Dockerfile chmods this file). */
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
