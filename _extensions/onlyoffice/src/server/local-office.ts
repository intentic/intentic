import { randomBytes } from "node:crypto";
import { stat } from "node:fs/promises";
import { dirname, join } from "node:path";
import { NAMESPACE, type DocsState, type OpenRequest } from "../contract.js";
import { documentTypeOf, extensionOf } from "../formats.js";
import { createBrowserEngine, type BrowserEngine } from "./browser-engine.js";
import { BUNDLE_PIN } from "./bundle-pin.js";
import { BundleStore } from "./bundle.js";
import { createListener, type Listener } from "./listener.js";
import { Originals } from "./originals.js";
import { parseOpen, workspacePath } from "./server.js";
import { Sessions } from "./sessions.js";

// What names a scratch file this side leaves beside a document on its way to a save, for a watcher to leave out.
export { SCRATCH_MARK } from "./browser-engine.js";

// The browser engine for folders on the user's own computer, for the desktop app's local files sidecar
// (_devices/local-files): the viewer's four routes answered with no daemon, no document server and no Docker, plus the
// two that bring a document back to how it was before this process first saved over it (originals.ts). Each folder
// gets its own engine and loopback listener, since an engine reads and writes under one root; the bundle is downloaded
// once and shared by all of them, and the app may ask for it before any document is open. Everything a sandbox's
// backend adds (the container engine, the JWT, the port it remembers across restarts) has nothing to do here.

export interface LocalFolder {
    // One engine per key: the sidecar's grant for a window.
    readonly key: string;
    readonly root: string;
    // The real path of a document inside the folder, or undefined for one that is not there or not inside it.
    readonly resolve: (path: string) => Promise<string | undefined>;
    // Whether this window may save the document, as opposed to only reading it.
    readonly writable: (path: string) => boolean;
}

export interface LocalOfficeDeps {
    // Where the editor bundle is downloaded to, once for every folder.
    readonly cacheDir: string;
    // The built editor page (this package's dist/editor).
    readonly pageDir: string;
    readonly log: (line: string) => void;
    // Where documents' originals are kept: `office-originals` beside the bundle's cache dir unless a test says.
    readonly originalsDir?: string;
    // The bundle download's fetch, for a test.
    readonly fetch?: typeof fetch;
}

// Where an asked-for download ended.
export type OfficePrefetch = { readonly state: "ready" } | { readonly state: "failed"; readonly error: string };

export interface LocalOffice {
    // The answer to one of the viewer's requests under the extension's namespace, or undefined for one that is not.
    readonly handle: (folder: LocalFolder, request: Request) => Promise<Response | undefined>;
    // Closes the listener a folder's engine opened, once no window shows the folder.
    readonly release: (key: string) => Promise<void>;
    readonly close: () => Promise<void>;
    // Downloads the editor bundle now, with no document open, and settles with where that ended. Asking again while it
    // runs joins it; asking once it is there answers at once.
    readonly prefetch: () => Promise<OfficePrefetch>;
}

// How often a download under way says how far it got.
const PROGRESS_MS = 5_000;

const json = <Body>(status: number, body: Body): Response =>
    new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

// What the viewer asks to open, or undefined for a body that is not that request.
const openRequestOf = async (request: Request): Promise<OpenRequest | undefined> =>
    // allow(silent-catch): a body that is not JSON is the caller's mistake, answered as a 400 like any other bad body.
    parseOpen(await request.json().catch(() => undefined));

interface Running {
    readonly engine: BrowserEngine;
    readonly listener: Listener;
}

// allow(silent-catch): an engine whose start failed has no listener to close, and closing is all that is left to do.
const closeQuietly = async (held: Promise<Running> | undefined): Promise<void> => held?.then(({ listener }) => listener.close()).catch(() => undefined);

// What a request's JSON body names as `path`, or undefined for a body that names none.
const pathIn = async (request: Request): Promise<string | undefined> => {
    // allow(silent-catch): a body that is not JSON names no path, answered as a 400 like any other bad body.
    const body: { readonly path?: unknown } | null = await request.json().catch(() => null);
    return workspacePath(body?.path);
};

export const createLocalOffice = (deps: LocalOfficeDeps): LocalOffice => {
    const bundle = new BundleStore({ root: deps.cacheDir, pin: BUNDLE_PIN, log: (line) => deps.log(`[office bundle] ${line}`), fetch: deps.fetch });
    const running = new Map<string, Promise<Running>>();
    const originals = new Originals({ dir: deps.originalsDir ?? join(dirname(deps.cacheDir), "office-originals"), log: (line) => deps.log(`[office] ${line}`) });
    // What was kept more than a week ago goes now, off every request's path.
    void originals.sweep().catch((error: Error) => deps.log(`[office] sweeping kept originals failed: ${error.message}`));

    const start = async (folder: LocalFolder): Promise<Running> => {
        const sessions = new Sessions();
        // The listener's address, known once it listens. The engine and the listener each need the other, so the engine
        // is handed the promise: it asks only to build a page, which no request reaches before the listener is up.
        const exposed = Promise.withResolvers<string>();
        const engine = createBrowserEngine({
            workspaceRoot: folder.root,
            pageDir: deps.pageDir,
            sessions,
            bundle,
            // A conversation's copy exists only in a sandbox.
            scopedRaw: async () => new Response(null, { status: 404 }),
            identify: async (path, agent) => {
                if (agent !== undefined) {
                    return undefined;
                }
                const real = await folder.resolve(path);
                if (real === undefined) {
                    return undefined;
                }
                const found = await stat(real);
                return found.isFile() ? { stat: { size: found.size, mtimeMs: found.mtimeMs } } : undefined;
            },
            exposure: () => exposed.promise,
            log: (line) => deps.log(`[office] ${line}`),
            writable: folder.writable,
            // The document as it was before this process first writes over it, kept to restore.
            beforeOverwrite: async (path) => {
                const real = await folder.resolve(path);
                if (real !== undefined) {
                    await originals.beforeOverwrite(real);
                }
            },
        });
        const listener = createListener({
            // Nothing signs callbacks here, since no document server runs; a secret nobody holds refuses any that arrive.
            secret: randomBytes(32).toString("hex"),
            sessions,
            host: "127.0.0.1",
            documentServerPort: () => undefined,
            pageFor: (session) => engine.page(session),
            refresh: async () => undefined,
            readDocument: async () => undefined,
            saveDocument: async () => {
                throw new Error("no document server runs on this computer");
            },
            browser: engine.routes,
            log: (line) => deps.log(`[office listener] ${line}`),
        });
        const port = await listener.listen(0);
        exposed.resolve(`http://127.0.0.1:${port}`);
        return { engine, listener };
    };

    const engineFor = (folder: LocalFolder): Promise<Running> => {
        let held = running.get(folder.key);
        if (held === undefined) {
            held = start(folder);
            running.set(folder.key, held);
            // A start that failed is tried again by the next request rather than remembered.
            held.catch(() => running.delete(folder.key));
        }
        return held;
    };

    const open = async (folder: LocalFolder, request: Request): Promise<Response> => {
        const asked = await openRequestOf(request);
        if (asked === undefined) {
            return json(400, { error: "expected { path, mode, theme, resume? }" });
        }
        if (documentTypeOf(extensionOf(asked.path)) === undefined) {
            return json(400, { error: `not an office document: ${asked.path}` });
        }
        const { engine } = await engineFor(folder);
        // The browser engine whatever the setting says, and read-only where this window may not write.
        const opened = await engine.open({ ...asked, engine: "browser", mode: folder.writable(asked.path) ? asked.mode : "view" });
        return json(opened.status, opened.body);
    };

    // Whether the document at `path` has an original kept, and since when.
    const original = async (folder: LocalFolder, url: URL): Promise<Response> => {
        const real = await folder.resolve(url.searchParams.get("path") ?? "");
        return json(200, real === undefined ? { kept: false } : await originals.original(real));
    };

    // Puts the kept original back, where this window may write the document.
    const restoreOriginal = async (folder: LocalFolder, request: Request): Promise<Response> => {
        const path = await pathIn(request);
        if (path === undefined) {
            return json(400, { error: "expected { path }" });
        }
        if (!folder.writable(path)) {
            return json(403, { error: "This window can't change that document." });
        }
        const real = await folder.resolve(path);
        if (real === undefined || !(await originals.restore(real))) {
            return json(404, { error: "No original of that document is kept." });
        }
        return json(200, { ok: true });
    };

    // The download on its way, shared by every ask for it until it ends.
    let prefetching: Promise<OfficePrefetch> | undefined;
    const download = async (): Promise<OfficePrefetch> => {
        const progress = setInterval(() => {
            const state = bundle.state();
            if (state.state === "downloading") {
                deps.log(`[office bundle] downloading: ${state.percent ?? 0}%`);
            }
        }, PROGRESS_MS);
        try {
            await bundle.ensure();
            const ended = await bundle.settled();
            return ended.state === "ready" ? { state: "ready" } : { state: "failed", error: ended.state === "failed" ? ended.detail : `The editor download stopped (${ended.state}).` };
        } catch (error) {
            return { state: "failed", error: error instanceof Error ? error.message : String(error) };
        } finally {
            clearInterval(progress);
        }
    };

    return {
        handle: async (folder, request) => {
            const url = new URL(request.url);
            if (!url.pathname.startsWith(`${NAMESPACE}/`)) {
                return undefined;
            }
            const route = url.pathname.slice(NAMESPACE.length);
            if (request.method === "GET" && route === "/status") {
                return json(200, (await (await engineFor(folder)).engine.status()) satisfies DocsState);
            }
            if (request.method === "POST" && route === "/start") {
                return json(200, (await (await engineFor(folder)).engine.prepare()) satisfies DocsState);
            }
            if (request.method === "POST" && route === "/open") {
                return open(folder, request);
            }
            // A browser-engine editor is told to save by message; the route exists only for the document server's.
            if (request.method === "POST" && route === "/forcesave") {
                return json(200, { outcome: "unchanged" });
            }
            if (request.method === "GET" && route === "/original") {
                return original(folder, url);
            }
            if (request.method === "POST" && route === "/restore-original") {
                return restoreOriginal(folder, request);
            }
            return undefined;
        },
        release: async (key) => {
            const held = running.get(key);
            running.delete(key);
            await closeQuietly(held);
        },
        close: async () => {
            const all = [...running.values()];
            running.clear();
            await Promise.all(all.map(closeQuietly));
        },
        prefetch: () => {
            prefetching ??= download().finally(() => {
                prefetching = undefined;
            });
            return prefetching;
        },
    };
};
