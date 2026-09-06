import { defineConfig } from "vite";

/* TWO ARTIFACTS FROM ONE ENTRY, because this SDK has two audiences and they cannot share a format:
 *
 *   dist/sdk.js    IIFE, what the daemon serves at /intake/sdk.js and a customer drops on their page with a
 *                  single <script>. A classic script, so it works on any site however old, and
 *                  `inlineDynamicImports` keeps it to one file, since a second chunk would need a base URL the
 *                  bundle cannot know before it has parsed its own script tag.
 *   dist/sdk.mjs   ESM, for a site with a bundler, a mobile web build, or anything importing `@intentic/issue-sdk`
 *                  by name. Same code, same wire, no script tag to find.
 *
 * The entry auto-boots only when it can find its own tag (main.ts), which is what lets one file be both.
 */
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
        /* The floor for the APIs used unguarded: crypto.randomUUID, crypto.subtle, custom elements, structured
         * `catch {}`. A browser older than this gets no reporter rather than a broken one, which for a crash
         * handler is the important direction: the script must never be the thing that breaks the page. */
        target: "es2022",
        minify: "esbuild",
        // No CSS pipeline: the dialog's styles are a template string injected into its shadow root (styles.ts),
        // which is what keeps the artifact one file and the host page's stylesheet out of it.
        cssCodeSplit: false,
        reportCompressedSize: true,
        rollupOptions: { output: { inlineDynamicImports: true } },
    },
});
