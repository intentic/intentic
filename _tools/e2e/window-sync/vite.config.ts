import { fileURLToPath } from "node:url";

export default {
    root: fileURLToPath(new URL(`./`, import.meta.url)),
    cacheDir: `../.cache/window-sync-vite`,
    resolve: {
        alias: [{ find: /.*\/useSandbox$/u, replacement: fileURLToPath(new URL(`./sandbox.js`, import.meta.url)) }],
    },
    server: { fs: { allow: [fileURLToPath(new URL(`../../../`, import.meta.url))] } },
};
