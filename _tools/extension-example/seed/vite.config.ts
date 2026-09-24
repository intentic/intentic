import vue from "@vitejs/plugin-vue";
import { defineConfig } from "vite";

/* The extension bundle, built exactly as /developers/build/ prescribes. */
export default defineConfig({
    plugins: [vue()],
    build: {
        outDir: "dist",
        lib: { entry: "src/extension.ts", formats: ["es"], fileName: () => "extension.js" },
        rollupOptions: {
            external: ["vue", "@tanstack/vue-query", "@intentic/extension-api", "@intentic/extension-ui"],
            output: { inlineDynamicImports: true },
        },
    },
});
