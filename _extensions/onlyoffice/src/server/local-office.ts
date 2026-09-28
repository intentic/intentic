import { randomBytes } from "node:crypto";
import { stat } from "node:fs/promises";
import { NAMESPACE, type DocsState, type OpenRequest } from "../contract.js";
import { documentTypeOf, extensionOf } from "../formats.js";
import { createBrowserEngine, type BrowserEngine } from "./browser-engine.js";
import { BUNDLE_PIN } from "./bundle-pin.js";
import { BundleStore } from "./bundle.js";
import { createListener, type Listener } from "./listener.js";
import { parseOpen } from "./server.js";
import { Sessions } from "./sessions.js";

// The browser engine for folders on the user's own computer, for the desktop app's local files sidecar
// (_devices/local-files): the viewer's four routes answered with no daemon, no document server and no Docker. Each
// folder gets its own engine and loopback listener, since an engine reads and writes under one root; the bundle is
// downloaded once and shared by all of them. Everything a sandbox's backend adds (the container engine, the JWT, the
// port it remembers across restarts) has nothing to do here.

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
}

export interface LocalOffice {
    // The answer to one of the viewer's requests under the extension's namespace, or undefined for one that is not.
    readonly handle: (folder: LocalFolder, request: Request) => Promise<Response | undefined>;
    // Closes the listener a folder's engine opened, once no window shows the folder.
    readonly release: (key: string) => Promise<void>;
    readonly close: () => Promise<void>;
}

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

export const createLocalOffice = (deps: LocalOfficeDeps): LocalOffice => {
    const bundle = new BundleStore({ root: deps.cacheDir, pin: BUNDLE_PIN, log: (line) => deps.log(`[office bundle] ${line}`) });
    const running = new Map<string, Promise<Running>>();

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
    };
};
