import { defineConfig } from "vite";

// One self-contained IIFE the daemon serves at /webchat/widget.js and a customer drops on their page with a
// single <script>. IIFE (not ESM) because the embed must work as a plain classic script on any site, however
// old; `inlineDynamicImports` keeps it to exactly one file, since a second chunk would need a base URL the
// widget can't know before it has parsed its own script tag.
export default defineConfig({
    build: {
        lib: { entry: "src/main.ts", formats: ["iife"], name: "IntenticFrontDesk", fileName: () => "widget.js" },
        outDir: "dist",
        emptyOutDir: true,
        // The floor for the APIs the widget uses unguarded (crypto.randomUUID, ReadableStream iteration via
        // getReader, custom elements). Anything older gets no chat rather than a broken one.
        target: "es2022",
        minify: "esbuild",
        // No CSS pipeline: the widget's styles are a template string injected into its shadow root (styles.ts),
        // which is what keeps the artifact one file and the host page's stylesheet out of it.
        cssCodeSplit: false,
        reportCompressedSize: true,
    },
});
