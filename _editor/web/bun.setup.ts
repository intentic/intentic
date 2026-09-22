import { plugin } from "bun";
import { registerCatalog } from "@intentic/ui/i18n";
import { appCatalog } from "./src/app/i18n";
import { sourceAliases } from "./source-aliases.js";

// Preloaded before every suite in this package, after @intentic/testing/dom (bunfig.toml lists that first: the
// catalog import above loads vue, whose runtime-dom binds `document` as its CJS graph links, before this file's body):
// the app's boot line, the globals it reads at import, and the Vite import forms bun has no loader for.

// A component test mounts without the app's boot, and a component whose catalog nobody registered draws its keys —
// so every assertion about what is on screen would read `chat.composer.send`. This is the one line of the boot a test
// needs: `en` is compiled in, so it merges in this tick and fetches nothing.
void registerCatalog(appCatalog);

// Vite's compile-time env, as the runtime reads it here: `import.meta.env` is `process.env` under bun.
process.env[`BASE_URL`] ??= `/`;
process.env[`DEV`] ??= `true`;
process.env[`MODE`] ??= `test`;

// Globals jsdom omits that the app reads at import time, before any test hook runs: `matchMedia` (@intentic/ui device
// detection; matches:false keeps the desktop form factor), `ResizeObserver` (AnchoredOverlay, a no-op here). Set with
// `??=` so a suite can override.
globalThis.matchMedia ??= ((query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addEventListener: () => {},
    removeEventListener: () => {},
    dispatchEvent: () => false,
})) as unknown as typeof globalThis.matchMedia;

globalThis.ResizeObserver ??= class {
    observe(): void {}
    unobserve(): void {}
    disconnect(): void {}
} as unknown as typeof globalThis.ResizeObserver;

// jsdom omits scrollIntoView; calling it async throws an unhandled rejection that fails the run though every assertion
// passed. A no-op is honest: nothing under jsdom can observe scroll position anyway.
Element.prototype.scrollIntoView ??= (): void => {};

// `window.env` (environment.ts) throws without deploy config.
window.env ??= {
    production: false,
    api: { url: `http://localhost` },
    auth: { googleClientId: `` },
    analytics: { posthogKey: ``, posthogHost: `` },
    afterSignOut: ``,
};

// Source-first aliases shared with vite.config.ts, so app and test resolution cannot fork: a subpath alias wins over
// its own barrel, and a bare key also covers `<key>/…` as Vite's string aliases do.
const aliases = Object.entries(sourceAliases());

// Vite-only import forms: a `?worker` import yields a Worker constructor, a stylesheet yields nothing a test can read.
const WORKER_STUB = `export default class WorkerStub { postMessage() {} terminate() {} addEventListener() {} removeEventListener() {} }`;

plugin({
    name: `web-test-resolution`,
    setup(build) {
        build.onResolve({ filter: /^@intentic\// }, ({ path }) => {
            const hit = aliases.find(([key]) => path === key || path.startsWith(`${key}/`));
            return hit === undefined ? undefined : { path: hit[1] + path.slice(hit[0].length) };
        });
        build.onResolve({ filter: /\?worker$/ }, ({ path }) => ({ path, namespace: `worker-stub` }));
        build.onLoad({ filter: /.*/, namespace: `worker-stub` }, () => ({ contents: WORKER_STUB, loader: `js` }));
        build.onLoad({ filter: /\.css$/ }, () => ({ contents: ``, loader: `js` }));
    },
});
