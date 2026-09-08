import { defineConfig } from "vite";

// Two artifacts from one entry, for two audiences that can't share a format:
// - sdk.js: IIFE served at /intake/sdk.js for a plain <script> tag; inlineDynamicImports keeps it one file
// - sdk.mjs: ESM for a bundler or `import "@intentic/issue-sdk"`
// Auto-boots only when it finds its own tag (main.ts), so one entry serves both.
export default defineConfig({
    build: {
        lib: {
            entry: "src/main.ts",
            formats: ["iife", "es"],
            name: "IntenticIssues",
            fileName: (format) => (format === "iife" ? "sdk.js" : "sdk.mjs"),
        },
        outDir: "dist",
        emptyOutDir: true,
        // The floor for unguarded APIs like crypto.randomUUID; old browsers get no reporter, not a broken one.
        target: "es2022",
        minify: "esbuild",
        // No CSS pipeline: styles are a template string in the shadow root (styles.ts), keeping this one file.
        cssCodeSplit: false,
        reportCompressedSize: true,
        rollupOptions: { output: { inlineDynamicImports: true } },
    },
});
