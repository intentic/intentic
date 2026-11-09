import { stat } from "node:fs/promises";
import { dirname, join } from "node:path";
import { errorMessage } from "@intentic/base/errors";
import { NAMESPACE, type DocsState, type OpenRequest } from "../contract.js";
import { documentTypeOf, extensionOf } from "../formats.js";
import { createBrowserEngine, warmBundle } from "./browser-engine.js";
import { BUNDLE_PIN } from "./bundle-pin.js";
import { BundleStore } from "./bundle.js";
import { createFolderListener, type FolderEngine } from "./local-listener.js";
import { Originals } from "./originals.js";
import { parseOpen, workspacePath } from "./server.js";
import { Sessions } from "./sessions.js";

// What names a scratch file this side leaves beside a document on its way to a save, for a watcher to leave out.
export { SCRATCH_MARK } from "./browser-engine.js";

// The browser engine for folders on the user's own computer, for the desktop app's local files sidecar
// (_devices/local-files): the viewer's four routes answered with no daemon, no document server and no Docker, plus the
// two that bring a document back to how it was before this process first saved over it (originals.ts). Each folder
// gets its own engine, since an engine reads and writes under one root, and all of them are served by one loopback
// listener on the port it had last run (local-listener.ts), so the editor's files stay cached across windows and runs.
// The bundle is downloaded once and shared by all of them, and the app may ask for it before any document is open.
// Everything a sandbox's backend adds (the container engine, the JWT) has nothing to do here.

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
    // Where the listener's port is remembered across runs: `office-port` beside the bundle's cache dir unless a test says.
    readonly portFile?: string;
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
// How long after the bundle is known to be on disk its files are warmed: out of the way of the app's own start, which
// asks for the bundle as its first window opens.
const WARM_AFTER_MS = 5_000;

const json = <Body>(status: number, body: Body): Response =>
    new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

// What the viewer asks to open, or undefined for a body that is not that request.
const openRequestOf = async (request: Request): Promise<OpenRequest | undefined> =>
    // allow(silent-catch): a body that is not JSON is the caller's mistake, answered as a 400 like any other bad body.
    parseOpen(await request.json().catch(() => undefined));

// What a request's JSON body names as `path`, or undefined for a body that names none.
const pathIn = async (request: Request): Promise<string | undefined> => {
    // allow(silent-catch): a body that is not JSON names no path, answered as a 400 like any other bad body.
    const body: { readonly path?: unknown } | null = await request.json().catch(() => null);
    return workspacePath(body?.path);
};

// The bundle's download, started unless it is on disk or on its way, and where it ended, saying how far it got meanwhile.
const downloadBundle = async (bundle: BundleStore, log: (line: string) => void): Promise<OfficePrefetch> => {
    const progress = setInterval(() => {
        const state = bundle.state();
        if (state.state === "downloading") {
            log(`[office bundle] downloading: ${state.percent ?? 0}%`);
        }
    }, PROGRESS_MS);
    try {
        await bundle.ensure();
        const ended = await bundle.settled();
        return ended.state === "ready" ? { state: "ready" } : { state: "failed", error: ended.state === "failed" ? ended.detail : `The editor download stopped (${ended.state}).` };
    } catch (error) {
        return { state: "failed", error: errorMessage(error) };
    } finally {
        clearInterval(progress);
    }
};

// The editor's files read once in the background, the first time the bundle is known to be on disk (warmBundle), so the
// first document opened in this run does not pay for a scan or a compression of them. Once per process.
const bundleWarmer = (bundle: BundleStore, log: (line: string) => void) => {
    let asked = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    return {
        soon: () => {
            if (asked) {
                return;
            }
            asked = true;
            timer = setTimeout(() => {
                const began = Date.now();
                warmBundle(bundle)
                    .then((count) => log(`[office bundle] warmed ${count} editor files in ${Date.now() - began} ms`))
                    .catch((error: Error) => log(`[office bundle] warming the editor files failed: ${error.message}`));
            }, WARM_AFTER_MS);
            timer.unref?.();
        },
        stop: () => clearTimeout(timer),
    };
};

// What the bytes of a document in `folder` are right now; nothing for a conversation's copy, which exists only in a sandbox.
const identifyIn =
    (folder: LocalFolder) =>
    async (path: string, agent: string | undefined): Promise<{ stat: { size: number; mtimeMs: number } } | undefined> => {
        const real = agent === undefined ? await folder.resolve(path) : undefined;
        if (real === undefined) {
            return undefined;
        }
        const found = await stat(real);
        return found.isFile() ? { stat: { size: found.size, mtimeMs: found.mtimeMs } } : undefined;
    };

export const createLocalOffice = (deps: LocalOfficeDeps): LocalOffice => {
    const bundle = new BundleStore({ root: deps.cacheDir, pin: BUNDLE_PIN, log: (line) => deps.log(`[office bundle] ${line}`), fetch: deps.fetch });
    const running = new Map<string, Promise<FolderEngine>>();
    const originals = new Originals({ dir: deps.originalsDir ?? join(dirname(deps.cacheDir), "office-originals"), log: (line) => deps.log(`[office] ${line}`) });
    // What was kept more than a week ago goes now, off every request's path.
    void originals.sweep().catch((error: Error) => deps.log(`[office] sweeping kept originals failed: ${error.message}`));

    // Engines whose start finished, by folder key: where the listener finds the engine a session belongs to.
    const started = new Map<string, FolderEngine>();
    const listener = createFolderListener({
        engines: () => started.values(),
        portFile: deps.portFile ?? join(dirname(deps.cacheDir), "office-port"),
        log: deps.log,
    });

    const start = async (folder: LocalFolder): Promise<FolderEngine> => {
        const sessions = new Sessions();
        const engine = createBrowserEngine({
            workspaceRoot: folder.root,
            pageDir: deps.pageDir,
            sessions,
            bundle,
            // A conversation's copy exists only in a sandbox.
            scopedRaw: async () => new Response(null, { status: 404 }),
            identify: identifyIn(folder),
            exposure: listener.origin,
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
        await listener.origin();
        return { engine, sessions };
    };

    const engineFor = (folder: LocalFolder): Promise<FolderEngine> => {
        let held = running.get(folder.key);
        if (held === undefined) {
            const starting = start(folder);
            held = starting;
            running.set(folder.key, starting);
            // Registered before any caller's own wait on it, so a session the engine opens is found by the listener at once.
            starting.then(
                (one) => {
                    if (running.get(folder.key) === starting) {
                        started.set(folder.key, one);
                    }
                },
                // A start that failed is tried again by the next request rather than remembered.
                () => {
                    if (running.get(folder.key) === starting) {
                        running.delete(folder.key);
                    }
                },
            );
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

    const warmer = bundleWarmer(bundle, deps.log);

    // The download on its way, shared by every ask for it until it ends.
    let prefetching: Promise<OfficePrefetch> | undefined;
    const download = async (): Promise<OfficePrefetch> => {
        const ended = await downloadBundle(bundle, deps.log);
        if (ended.state === "ready") {
            warmer.soon();
        }
        return ended;
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
            if (request.method === "POST" && route === "/start") { // allow(route-literal): this extension's own backend route
                return json(200, (await (await engineFor(folder)).engine.prepare()) satisfies DocsState);
            }
            if (request.method === "POST" && route === "/open") { // allow(route-literal): this extension's own backend route
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
        // The folder's sessions go with its engine, so its editor's requests are answered as ended; the listener stays
        // for the other windows and the next one.
        release: async (key) => {
            running.delete(key);
            started.delete(key);
        },
        close: async () => {
            warmer.stop();
            running.clear();
            started.clear();
            await listener.close();
        },
        prefetch: () => {
            prefetching ??= download().finally(() => {
                prefetching = undefined;
            });
            return prefetching;
        },
    };
};
