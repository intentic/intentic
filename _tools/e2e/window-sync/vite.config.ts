import { fileURLToPath } from "node:url";
import { repoRoot } from "@intentic/constants/node";

export default {
    root: fileURLToPath(new URL(`./`, import.meta.url)),
    cacheDir: `../.cache/window-sync-vite`,
    resolve: {
        alias: [{ find: /.*\/useSandbox$/u, replacement: fileURLToPath(new URL(`./sandbox.js`, import.meta.url)) }],
    },
    server: { fs: { allow: [repoRoot(import.meta.url)] } },
};
