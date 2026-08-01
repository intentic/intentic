import { fileURLToPath } from "node:url";
import { defineConfig, type Plugin } from "vite";
import { shared } from "./vite.config";

/* The interactive demo: the SAME app, from the same source, entered through `demo.html` instead of `index.html`
 * (src/demo/ is what that entry installs before the app boots). Its own config rather than a second input on the
 * app's build, for two reasons that both matter:
 *
 *   - It ships to its own place — a static bundle the marketing site embeds — so it wants its own outDir and can
 *     take its own `--base` at deploy time.
 *   - Nothing under src/demo/ can then reach the app bundle. The fixture is not code that ships to users.
 *
 * Plain http on its own port: the demo talks to nothing real, so there is no cross-origin cookie, no Google
 * client and no mixed content to keep the dev certificate for. The app's dev server is untouched — it still owns
 * 47145 with the cert the API and Google trust. */

const here = (path: string): string => fileURLToPath(new URL(path, import.meta.url));

/* Serve `demo.html` for every DOCUMENT request, which is the one thing a static host has to be told too: the
 * demo is a history-mode SPA, so `/agents` and `/workspace/api/src/stripe.ts` are its routes, not its files.
 * Keyed on `Accept: text/html` rather than on the path's shape, because a workspace route legitimately ends in
 * `.ts` — a navigation says what it wants, and module/asset requests never ask for html. */
const demoEntry = (): Plugin => ({
    name: `demo-entry`,
    configureServer: (server) => {
        server.middlewares.use((request, _response, next) => {
            if (request.method === `GET` && request.headers.accept?.includes(`text/html`) === true) {
                request.url = `/demo.html`;
            }
            next();
        });
    },
});

export default defineConfig({
    ...shared,
    plugins: [...shared.plugins, demoEntry()],
    server: { host: `localhost`, port: 47146, strictPort: true },
    build: {
        outDir: here(`./dist-demo`),
        emptyOutDir: true,
        target: `es2024`,
        rollupOptions: { input: { demo: here(`./demo.html`) } },
    },
});
