import vue from "@vitejs/plugin-vue";
import { defineConfig } from "vite";

/* @intentic/sandbox-contract and the @intentic packages it brings in: schemas and constants, nothing that runs on import. */
const SIDE_EFFECT_FREE = /[\\/]node_modules[\\/]@intentic[\\/](?:sandbox-contract|base|constants)[\\/]/;

/* The extension bundle, built exactly as /developers/build/ prescribes. */
export default defineConfig({
    plugins: [vue()],
    build: {
        outDir: "dist",
        lib: { entry: "src/extension.ts", formats: ["es"], fileName: () => "extension.js" },
        rollupOptions: {
            external: ["vue", "@tanstack/vue-query", "@intentic/extension-api", "@intentic/extension-ui"],
            // Keeps only the contract modules the code imports: they are declarations, but the package does not say so.
            treeshake: { moduleSideEffects: (id: string) => (SIDE_EFFECT_FREE.test(id) ? false : undefined) },
            // Whitespace too, which a library build keeps for a downstream bundler this bundle never meets.
            output: { inlineDynamicImports: true, minify: true },
        },
    },
});
