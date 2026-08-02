import vue from "@vitejs/plugin-vue";
import { defineConfig } from "vite";

/* The extension bundle, built exactly as /docs/extensions/build/ prescribes.
 *
 * Two rules are load-bearing and neither is a preference:
 *   externals          — the host publishes its OWN vue, vue-query and extension-api instances through the
 *                        app's import map. Bundling a second copy forks reactivity and the query cache, so the
 *                        view would render from state nothing else in the shell can see.
 *   one file, no chunks — the loader fetches the bundle with an auth header and imports it from a blob: URL.
 *                        A relative chunk import has no base to resolve against there, so it would 404. */
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
