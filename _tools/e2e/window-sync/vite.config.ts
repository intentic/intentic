import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { repoRoot } from "@intentic/constants/node";

// The app's own first script, which says a popped-out window is booting before any module loads: lifted out of its
// index.html, so the fixture's windows boot the way the app's do rather than by a copy.
const appHtml = readFileSync(new URL(`../../../_editor/web/index.html`, import.meta.url), `utf8`);
const bootingScript = [...appHtml.matchAll(/<script>([\s\S]*?)<\/script>/gu)].map((found) => found[1] ?? ``).find((body) => body.includes(`booting`));
if (bootingScript === undefined) {
    throw new Error(`_editor/web/index.html has no script saying a floating window is booting`);
}

export default {
    root: fileURLToPath(new URL(`./`, import.meta.url)),
    cacheDir: `../.cache/window-sync-vite`,
    resolve: {
        alias: [{ find: /.*\/useSandbox$/u, replacement: fileURLToPath(new URL(`./sandbox.js`, import.meta.url)) }],
    },
    server: { fs: { allow: [repoRoot(import.meta.url)] } },
    plugins: [
        {
            name: `app-booting-script`,
            transformIndexHtml: () => [{ tag: `script`, children: bootingScript, injectTo: `head-prepend` as const }],
        },
    ],
};
