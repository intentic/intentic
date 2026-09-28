import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";

/* The browser engine's editor page (AGPL-3.0): one classic script, dist/editor/editor.js, which the backend's listener serves beside the bundle it drives. Built after the server bundle, whose build empties dist/. */
const here = (path: string): string => fileURLToPath(new URL(path, import.meta.url));

export default defineConfig({
    build: {
        lib: { entry: here(`./src/main.ts`), formats: [`iife`], name: `IntenticEditorPage`, fileName: () => `editor.js` },
        outDir: here(`../dist/editor`),
        emptyOutDir: true,
        target: `es2022`,
        rolldownOptions: {
            output: {
                // After minification, which would drop it as a comment.
                postBanner: `/*! Intentic's ONLYOFFICE editor page, AGPL-3.0-only. Source: https://github.com/intentic/intentic/tree/main/_extensions/onlyoffice/editor */`,
            },
        },
    },
});
