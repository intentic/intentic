import { createHash, randomBytes } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { readFile, rename, rm, stat } from "node:fs/promises";
import { basename, dirname, extname, join, posix } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { DocsState, OpenRequest, OpenResult } from "../contract.js";
import { documentTypeOf, extensionOf, READ_ONLY_IN_BROWSER } from "../formats.js";
import type { EditorPageConfig } from "../protocol.js";
import type { BundleState, BundleStore } from "./bundle.js";
import { browserPage } from "./browser-page.js";
import { createBrowserRoutes, type BrowserRoutes, type FileWrite, type FileWritten, type OpenedFile } from "./browser-routes.js";
import type { FileStat, Session, Sessions } from "./sessions.js";

// The browser engine's half of the backend: the bundle the editor runs from, sessions opened on it, the page each one
// is framed with, and the one file each session reads and writes. Nothing here runs a document server: the editor
// converts and edits in the owner's browser, and the listener only serves files and takes saves.

export interface BrowserEngineDeps {
    readonly workspaceRoot: string;
    // Where this extension's editor page build is (dist/editor), absent in a checkout that was never built.
    readonly pageDir: string;
    readonly sessions: Sessions;
    readonly bundle: BundleStore;
    // A conversation's copy of a file, through the daemon.
    readonly scopedRaw: (path: string, agent: string) => Promise<Response>;
    // What the bytes of a document are right now: the stat of a shared-tree file, the digest of a copy.
    readonly identify: (path: string, agent: string | undefined) => Promise<{ stat?: FileStat; digest?: string } | undefined>;
    // Where the browser reaches the listener, or undefined while the sandbox has no public address.
    readonly exposure: () => Promise<string | undefined>;
    readonly log: (line: string) => void;
}

export interface BrowserEngine {
    readonly status: () => Promise<DocsState>;
    // Starts the bundle's one download if it has not happened, and answers where it stands.
    readonly prepare: () => Promise<DocsState>;
    readonly open: (request: OpenRequest) => Promise<{ readonly status: number; readonly body: OpenResult | DocsState | { error: string } }>;
    // The page a browser session's frame loads.
    readonly page: (session: Session) => Promise<string>;
    readonly routes: BrowserRoutes;
}

// The version a save names: size and modification time, which a write by anyone else moves.
export const versionOfStat = (found: FileStat): string => `${found.size}-${Math.trunc(found.mtimeMs)}`;

const stateOfBundle = (bundle: BundleState): DocsState => {
    switch (bundle.state) {
        case "ready":
            return { state: "ready" };
        case "downloading":
            return { state: "pulling", percent: bundle.percent };
        case "failed":
            return { state: "error", detail: bundle.detail };
        default:
            return { state: "not-started" };
    }
};

// The first free name beside `path` for a copy: "brief (copy).docx", then "brief (copy 2).docx" and on.
export const copyNameFor = async (root: string, path: string): Promise<string> => {
    const extension = extname(path);
    const stem = posix.join(posix.dirname(path), basename(path, extension));
    for (let attempt = 1; ; attempt++) {
        const candidate = `${stem.startsWith("./") ? stem.slice(2) : stem} (copy${attempt === 1 ? "" : ` ${attempt}`})${extension}`;
        try {
            await stat(join(root, candidate));
        } catch (error) {
            // SAFETY: fs rejects with a NodeJS.ErrnoException; only its code is read.
            if ((error as NodeJS.ErrnoException).code === "ENOENT") {
                return candidate;
            }
            throw error;
        }
    }
};

// The app's language as the editor takes it: a short tag, or English.
const langOf = (lang: string | undefined): string => (lang !== undefined && /^[a-z]{2,3}(?:-[A-Za-z0-9]{2,8})?$/.test(lang) ? lang : "en");

// An origin the page may post to, or undefined for anything that is not one.
export const originOf = (origin: string | undefined): string | undefined => {
    if (origin === undefined) {
        return undefined;
    }
    try {
        const parsed = new URL(origin);
        return (parsed.protocol === "https:" || parsed.protocol === "http:") && parsed.origin === origin ? origin : undefined;
    } catch {
        // allow(silent-catch): a value that is not a URL is not an origin, which the undefined says.
        return undefined;
    }
};

export const createBrowserEngine = (deps: BrowserEngineDeps): BrowserEngine => {
    const { sessions, bundle, workspaceRoot } = deps;
    // The page build, by the hash of its content: its URL changes exactly when it does.
    let page: { readonly id: string } | undefined;
    const pageBuild = async (): Promise<{ readonly id: string } | undefined> => {
        if (page !== undefined) {
            return page;
        }
        try {
            const script = await readFile(join(deps.pageDir, "editor.js"));
            page = { id: createHash("sha256").update(script).digest("hex").slice(0, 16) };
        } catch (error) {
            deps.log(`the browser engine's editor page is not built: ${error instanceof Error ? error.message : String(error)}`);
        }
        return page;
    };
    const readyBundle = (): { id: string; root: { dir: string; gzipCache: string } } | undefined => {
        const state = bundle.state();
        return state.state === "ready" ? { id: bundle.pinId, root: { dir: state.dir, gzipCache: join(state.dir, ".gz") } } : undefined;
    };

    const openFile = async (session: Session): Promise<OpenedFile | undefined> => {
        if (session.agent !== undefined) {
            const response = await deps.scopedRaw(session.path, session.agent);
            // SAFETY: fetch's body is a web ReadableStream of bytes; the DOM and node typings of it only disagree in name.
            return response.ok && response.body !== null ? { stream: Readable.fromWeb(response.body as never), version: undefined } : undefined;
        }
        const file = join(workspaceRoot, session.path);
        let found: FileStat;
        try {
            found = await stat(file);
        } catch (error) {
            // SAFETY: fs rejects with a NodeJS.ErrnoException; only its code is read.
            if ((error as NodeJS.ErrnoException).code === "ENOENT") {
                return undefined;
            }
            throw error;
        }
        return { stream: createReadStream(file), version: versionOfStat(found) };
    };

    const currentVersion = async (file: string): Promise<string | undefined> => {
        try {
            return versionOfStat(await stat(file));
        } catch (error) {
            // SAFETY: fs rejects with a NodeJS.ErrnoException; only its code is read.
            if ((error as NodeJS.ErrnoException).code === "ENOENT") {
                return undefined;
            }
            throw error;
        }
    };

    // Streams the body beside the file first, so the file is only ever the old bytes or the new ones, and checks the
    // version it replaces at the last moment before the rename.
    const writeFile = async (session: Session, body: Readable, write: FileWrite): Promise<FileWritten> => {
        const target = join(workspaceRoot, session.path);
        const temporary = join(dirname(target), `.${basename(target)}.onlyoffice-${randomBytes(4).toString("hex")}.tmp`);
        try {
            await pipeline(body, createWriteStream(temporary));
            if (write.kind === "save" && (await currentVersion(target)) !== write.expected) {
                await rm(temporary, { force: true });
                return { conflict: true };
            }
            const path = write.kind === "copy" ? await copyNameFor(workspaceRoot, session.path) : session.path;
            await rename(temporary, join(workspaceRoot, path));
            const written = await stat(join(workspaceRoot, path));
            if (write.kind !== "copy") {
                // The kept editor holds these bytes now: the next open of them is still its session.
                sessions.saved(session.key, { size: written.size, mtimeMs: written.mtimeMs });
            }
            return { written: true, path, version: versionOfStat(written) };
        } catch (error) {
            await rm(temporary, { force: true });
            throw error;
        }
    };

    const routes = createBrowserRoutes({
        sessions,
        bundle: readyBundle,
        page: () => (page === undefined ? undefined : { id: page.id, root: { dir: deps.pageDir, gzipCache: undefined } }),
        openFile,
        writeFile,
        log: deps.log,
    });

    const prepare = async (): Promise<DocsState> => stateOfBundle(await bundle.ensure());

    const open = async (request: OpenRequest): Promise<{ status: number; body: OpenResult | DocsState | { error: string } }> => {
        const extension = extensionOf(request.path);
        const state = await prepare();
        if (state.state !== "ready") {
            return { status: 409, body: state };
        }
        const build = await pageBuild();
        if (build === undefined) {
            return { status: 409, body: { state: "error", detail: "This sandbox's copy of the extension has no editor page built." } };
        }
        const identity = await deps.identify(request.path, request.agent);
        if (identity === undefined) {
            return { status: 404, body: { error: `no such file: ${request.path}` } };
        }
        const writable = request.agent === undefined && !READ_ONLY_IN_BROWSER.includes(extension);
        const input = {
            path: request.path,
            agent: request.agent,
            mode: writable ? request.mode : ("view" as const),
            theme: request.theme,
            stat: identity.stat,
            digest: identity.digest,
            engine: "browser" as const,
            lang: langOf(request.lang),
            origin: originOf(request.origin),
        };
        if (request.resume !== undefined && sessions.current(request.resume, input)) {
            return { status: 200, body: { resumed: true } };
        }
        const origin = await deps.exposure();
        if (origin === undefined) {
            return { status: 409, body: { state: "no-address" } };
        }
        const session = sessions.open(input);
        return { status: 200, body: { url: `${origin}/editor?s=${encodeURIComponent(session.token)}`, session: session.token, engine: "browser" } };
    };

    const renderPage = async (session: Session): Promise<string> => {
        const build = await pageBuild();
        const extension = extensionOf(session.path);
        const version = session.agent === undefined ? await currentVersion(join(workspaceRoot, session.path)) : undefined;
        const config: EditorPageConfig = {
            title: basename(session.path),
            fileType: extension,
            documentType: documentTypeOf(extension) ?? "word",
            mode: session.mode,
            theme: session.theme,
            lang: session.lang ?? "en",
            fileUrl: `/file?s=${encodeURIComponent(session.token)}`,
            version,
            // Fresh per page load, so the editor never serves a conversion it cached from other bytes under this name.
            key: `${session.key.slice(0, 43)}.${Date.now().toString(36)}${randomBytes(3).toString("hex")}`,
            saveable: session.mode === "edit" && session.agent === undefined && !READ_ONLY_IN_BROWSER.includes(extension),
            parentOrigin: session.origin,
        };
        return browserPage({ config, bundlePath: `/bundle/${bundle.pinId}/`, pagePath: `/page/${build?.id ?? "missing"}/` });
    };

    return {
        status: async () => stateOfBundle(await bundle.load()),
        prepare,
        open,
        page: renderPage,
        routes,
    };
};
