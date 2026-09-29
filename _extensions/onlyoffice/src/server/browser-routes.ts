import type http from "node:http";
import { Transform, type Readable } from "node:stream";
import type { Session, Sessions } from "./sessions.js";
import { serveStatic, type StaticRoot } from "./static-files.js";

// The browser engine's routes on the listener: its static files (the verified bundle, and this extension's editor page)
// and the one document a session is for, read and written by the page editing it. The file routes take the session
// token, like the editor page; the static ones are the same public files for everyone.

export type FileWrite =
    // The page's save, written only while the file is still the version the page last loaded or wrote.
    | { readonly kind: "save"; readonly expected: string }
    // The owner chose to write over whatever changed the file meanwhile.
    | { readonly kind: "overwrite" }
    // The owner chose to keep both: written beside the file under a free name.
    | { readonly kind: "copy" };

// Written, not written because the file changed on disk since, or refused outright (a copy where this window may not
// write), with the words the page shows.
export type FileWritten =
    | { readonly written: true; readonly path: string; readonly version: string }
    | { readonly conflict: true }
    | { readonly refused: string };

export interface OpenedFile {
    readonly stream: Readable;
    // What the page sends back with its save; undefined for a copy that is never written back.
    readonly version: string | undefined;
}

export interface BrowserRouteDeps {
    readonly sessions: Sessions;
    // The verified bundle, once it is on disk.
    readonly bundle: () => { readonly id: string; readonly root: StaticRoot } | undefined;
    // This extension's editor page build, under the hash of its content.
    readonly page: () => { readonly id: string; readonly root: StaticRoot } | undefined;
    readonly openFile: (session: Session) => Promise<OpenedFile | undefined>;
    // Writes the body per `write`; a body past the size limit rejects with BodyTooLarge.
    readonly writeFile: (session: Session, body: Readable, write: FileWrite) => Promise<FileWritten>;
    readonly log: (line: string) => void;
}

// Answers the request when it is one of these routes; false leaves it to the rest of the listener.
export type BrowserRoutes = (req: http.IncomingMessage, res: http.ServerResponse, url: URL) => Promise<boolean>;

// Past any office document anyone edits in a browser; the bound is on what the listener accepts, not on the editor.
const MAX_SAVE_BYTES = 1024 * 1024 * 1024;

class BodyTooLarge extends Error {
    constructor() {
        super("the document is larger than a save may be");
    }
}

const json = (res: http.ServerResponse, status: number, body: unknown, headers: http.OutgoingHttpHeaders = {}): void => {
    res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store", ...headers });
    res.end(JSON.stringify(body));
};

// The version an ETag names, with its quotes and weak marker taken off.
export const versionOf = (etag: string | undefined): string | undefined => {
    const value = etag?.trim().replace(/^W\//, "").replace(/^"(.*)"$/, "$1");
    return value === undefined || value === "" ? undefined : value;
};

// The request body, failing once it passes `limit` bytes.
const limited = (req: http.IncomingMessage, limit: number): Readable => {
    let seen = 0;
    const counter = new Transform({
        transform(chunk: Buffer, _encoding, done) {
            seen += chunk.length;
            done(seen > limit ? new BodyTooLarge() : null, chunk);
        },
    });
    req.on("error", (error) => counter.destroy(error));
    return req.pipe(counter);
};

const writeOf = (url: URL, req: http.IncomingMessage): FileWrite | undefined => {
    const asked = url.searchParams.get("write");
    if (asked === "overwrite" || asked === "copy") {
        return { kind: asked };
    }
    const expected = versionOf(req.headers["if-match"]);
    return asked === null && expected !== undefined ? { kind: "save", expected } : undefined;
};

export const createBrowserRoutes = (deps: BrowserRouteDeps, limit = MAX_SAVE_BYTES): BrowserRoutes => {
    const staticRoute = async (req: http.IncomingMessage, res: http.ServerResponse, found: { id: string; root: StaticRoot } | undefined, rest: string): Promise<void> => {
        const slash = rest.indexOf("/");
        if (found === undefined || slash === -1 || rest.slice(0, slash) !== found.id) {
            json(res, 404, { error: "not found" });
            return;
        }
        await serveStatic(req, res, found.root, rest.slice(slash + 1));
    };

    const readFile = async (req: http.IncomingMessage, res: http.ServerResponse, session: Session): Promise<void> => {
        const opened = await deps.openFile(session);
        if (opened === undefined) {
            json(res, 404, { error: "no such document" });
            return;
        }
        const headers: http.OutgoingHttpHeaders = { "content-type": "application/octet-stream", "cache-control": "no-store" };
        // A conversation's copy has no version: it is never written back.
        if (opened.version !== undefined) {
            headers["etag"] = `"${opened.version}"`;
        }
        res.writeHead(200, headers);
        if (req.method === "HEAD") {
            opened.stream.destroy();
            res.end();
            return;
        }
        opened.stream.on("error", () => res.destroy());
        opened.stream.pipe(res);
    };

    const writeFile = async (req: http.IncomingMessage, res: http.ServerResponse, url: URL, session: Session): Promise<void> => {
        if (session.mode !== "edit" || session.agent !== undefined) {
            json(res, 403, { error: "this document is open read-only" });
            return;
        }
        const write = writeOf(url, req);
        if (write === undefined) {
            json(res, 428, { error: "a save names the version it replaces (If-Match), or asks to overwrite or copy" });
            return;
        }
        const declared = Number(req.headers["content-length"] ?? Number.NaN);
        if (Number.isFinite(declared) && declared > limit) {
            json(res, 413, { error: new BodyTooLarge().message });
            return;
        }
        try {
            const result = await deps.writeFile(session, limited(req, limit), write);
            if ("conflict" in result) {
                json(res, 409, { error: "the file changed on disk" });
                return;
            }
            if ("refused" in result) {
                json(res, 403, { error: result.refused });
                return;
            }
            deps.log(`saved ${result.path} from the browser editor`);
            json(res, 200, { path: result.path, version: result.version }, { etag: `"${result.version}"` });
        } catch (error) {
            if (error instanceof BodyTooLarge) {
                json(res, 413, { error: error.message });
                return;
            }
            throw error;
        }
    };

    return async (req, res, url) => {
        const method = req.method ?? "GET";
        const readOnly = method === "GET" || method === "HEAD";
        if (url.pathname.startsWith("/bundle/") && readOnly) {
            await staticRoute(req, res, deps.bundle(), url.pathname.slice("/bundle/".length));
            return true;
        }
        if (url.pathname.startsWith("/page/") && readOnly) {
            await staticRoute(req, res, deps.page(), url.pathname.slice("/page/".length));
            return true;
        }
        if (url.pathname !== "/file") {
            return false;
        }
        const session = deps.sessions.session(url.searchParams.get("s") ?? "");
        if (session === undefined || session.engine !== "browser") {
            json(res, 404, { error: "session ended" });
            return true;
        }
        if (readOnly) {
            await readFile(req, res, session);
        } else if (method === "PUT") {
            await writeFile(req, res, url, session);
        } else {
            json(res, 405, { error: "method not allowed" });
        }
        return true;
    };
};
