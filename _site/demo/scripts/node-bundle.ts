// The demo's modules as Node can load them, shared by the scripts that drive the fixture daemon outside a browser
// (smoke-daemon.ts, unserved-report.ts). The modules are Vite-shaped (import.meta.glob, .vue), so Vite bundles them
// for Node first, and they read the browser as they load, so a stand-in for it goes on globalThis before any import.

import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "vite";

const DEMO_ROOT = fileURLToPath(new URL(`..`, import.meta.url));

const store = (): Storage => {
    const held = new Map<string, string>();
    return {
        getItem: (key) => held.get(key) ?? null,
        setItem: (key, value) => void held.set(key, value),
        removeItem: (key) => void held.delete(key),
        clear: () => held.clear(),
        key: () => null,
        get length() {
            return held.size;
        },
    };
};

const ignore = (): void => {};

const element = () => ({
    dataset: {},
    style: { setProperty: ignore, removeProperty: ignore, getPropertyValue: () => `` },
    classList: { add: ignore, remove: ignore, toggle: ignore, contains: () => false },
    setAttribute: ignore,
    getAttribute: () => null,
    removeAttribute: ignore,
    appendChild: ignore,
    addEventListener: ignore,
    removeEventListener: ignore,
});

// What the demo's modules read from the browser as they load; the full recording, so every agent and extension is on.
export const stubBrowser = (): void => {
    const sessionStorage = store();
    sessionStorage.setItem(`intentic.demo.mode`, `full`);
    Object.assign(globalThis, {
        window: globalThis,
        location: new URL(`https://demo.smoke.invalid/demo/s/demo/agents`),
        history: { state: null, replaceState: ignore, pushState: ignore },
        sessionStorage,
        localStorage: store(),
        addEventListener: ignore,
        removeEventListener: ignore,
        dispatchEvent: () => true,
        matchMedia: (media: string) => ({
            matches: false,
            media,
            addEventListener: ignore,
            removeEventListener: ignore,
            addListener: ignore,
            removeListener: ignore,
        }),
        document: {
            documentElement: element(),
            head: element(),
            body: element(),
            createElement: element,
            addEventListener: ignore,
            removeEventListener: ignore,
            querySelector: () => null,
            querySelectorAll: () => [],
            visibilityState: `visible`,
        },
    });
};

// Every entry bundled once, into one output, so the modules they share are one instance of each. An entry under
// `src/` is the demo's own file; anything else is a package name.
export const bundle = async (out: string, entries: Readonly<Record<string, string>>): Promise<void> => {
    await build({
        root: DEMO_ROOT,
        configFile: join(DEMO_ROOT, `vite.config.ts`),
        logLevel: `error`,
        publicDir: false,
        ssr: { noExternal: true, target: `node` },
        build: {
            ssr: true,
            outDir: out,
            emptyOutDir: true,
            minify: false,
            rolldownOptions: {
                input: Object.fromEntries(
                    Object.entries(entries).map(([name, entry]) => [name, entry.startsWith(`src/`) ? join(DEMO_ROOT, entry) : entry]),
                ),
            },
        },
    });
};

// Typed as the module it was bundled from; the bundle is that module, compiled.
export const loaded = async <T>(out: string, entry: string): Promise<T> => {
    const module: unknown = await import(pathToFileURL(join(out, `${entry}.js`)).href);
    // SAFETY: the file is the named entry's bundle, so it exports what that module exports, and T names that module.
    return module as T;
};
