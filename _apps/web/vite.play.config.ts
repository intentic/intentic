import { fileURLToPath } from "node:url";
import base from "./vite.config";

/* Throwaway playground config — see src/__play/. Spreads the real config (vue + tailwind + sourceAliases)
 * and replaces its server block: no https, so the headless browser doesn't reject the self-signed dev cert.
 * The extra aliases swap ChatMessageView's app singletons for src/__play/fakes.ts; Vite matches these exact
 * specifier strings before resolution, so the router/sandbox-client chains never load. */

const fakes = fileURLToPath(new URL(`./src/__play/fakes.ts`, import.meta.url));

export default {
    ...base,
    // The playground renders no code blocks and no graph, so skip the app's grammar pre-bundling.
    optimizeDeps: undefined,
    resolve: {
        alias: [
            { find: `../composables/chat/useChat`, replacement: fakes },
            { find: `../composables/workspace/useHistory`, replacement: fakes },
            { find: `../composables/workspace/openFileRef`, replacement: fakes },
            { find: `../composables/chat/attachmentPreviews`, replacement: fakes },
            ...Object.entries((base as { resolve?: { alias?: Record<string, string> } }).resolve?.alias ?? {}).map(([find, replacement]) => ({
                find,
                replacement,
            })),
        ],
    },
    server: { host: `localhost`, port: 47205, strictPort: true },
};
