import http from "node:http";
import type { Readable } from "node:stream";
import { relayUpgrade } from "./upgrade-relay.js";
import { endedPage } from "./host-page.js";
import { bearerOf, verifyJwt } from "./jwt.js";
import type { FileStat, Session, Sessions } from "./sessions.js";

// The listener the document server and the browser reach, outside the daemon's auth: the daemon's /x/ namespace is
// bearer-gated and a separate process can't hold a bearer. Every route here has its own credential: the editor page
// takes a session token, the document server signs what it fetches and posts with the shared JWT secret, and the rest
// is the server's own UI proxied through so it shares this origin.

export interface Document {
    readonly path: string;
    readonly agent: string | undefined;
}

export interface ListenerDeps {
    readonly secret: string;
    readonly sessions: Sessions;
    // The document server's loopback port while it answers; undefined answers 503 to what would be proxied.
    readonly documentServerPort: () => number | undefined;
    readonly pageFor: (session: Session) => string;
    // The signed editor config for `session` moved onto a fresh key, for an editor the server told to reload its
    // document; undefined when the document is gone.
    readonly refresh: (session: Session) => Promise<Record<string, unknown> | undefined>;
    // The document's bytes, or undefined when it is gone.
    readonly readDocument: (document: Document) => Promise<Readable | undefined>;
    // Fetches the edited document the server offers at `url`, writes it to the workspace, and answers what it left.
    readonly saveDocument: (document: Document, url: string) => Promise<FileStat>;
    readonly log: (line: string) => void;
}

export interface Listener {
    readonly server: http.Server;
    // Binds `port` when it is free, else any; answers the port it got.
    readonly listen: (port?: number) => Promise<number>;
    readonly close: () => Promise<void>;
    // Editor connections open right now: a reader who sends nothing for an hour still holds one.
    readonly editorsConnected: () => number;
}

// Bounded: a callback is a few hundred bytes of JSON.
const MAX_CALLBACK_BYTES = 1024 * 1024;

// What the document server's callback statuses mean here. 2 and 3 end the session: every editor closed, with the final
// document to write (2) or none because the save failed (3). 6 is a forced save (Ctrl+S, or the viewer's own when a
// document is left) inside a session that goes on. The others are lifecycle notices.
const FINAL_SAVE = 2;
const FINAL_SAVE_FAILED = 3;
const FORCED_SAVE = 6;

// HTTP/1.1 hop-by-hop headers, dropped before a request or response crosses the proxy.
const HOP_BY_HOP = ["connection", "keep-alive", "proxy-authenticate", "proxy-authorization", "te", "trailer", "transfer-encoding", "upgrade"];

const withoutHopByHop = (headers: http.IncomingHttpHeaders): http.IncomingHttpHeaders => {
    const kept = { ...headers };
    for (const name of HOP_BY_HOP) {
        delete kept[name];
    }
    return kept;
};

const readBody = (req: http.IncomingMessage, limit: number): Promise<string> =>
    new Promise((resolve, reject) => {
        const chunks: Buffer[] = [];
        let size = 0;
        req.on("data", (chunk: Buffer) => {
            size += chunk.length;
            if (size > limit) {
                req.destroy(new Error("body too large"));
                return;
            }
            chunks.push(chunk);
        });
        req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
        req.on("error", reject);
    });

const json = (res: http.ServerResponse, status: number, body: unknown): void => {
    res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" });
    res.end(JSON.stringify(body));
};

const html = (res: http.ServerResponse, status: number, body: string): void => {
    res.writeHead(status, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
    res.end(body);
};

// What the document server signed: with the token in the Authorization header it wraps the body under `payload`, in
// the body it is the body's own fields. The signed copy is what is trusted, never the raw body beside it.
const callbackClaims = (req: http.IncomingMessage, rawBody: string, secret: string): Record<string, unknown> | undefined => {
    const header = bearerOf(req.headers.authorization);
    const fromHeader = header === undefined ? undefined : verifyJwt(header, secret);
    if (fromHeader !== undefined) {
        const wrapped = fromHeader["payload"];
        return typeof wrapped === "object" && wrapped !== null ? (wrapped as Record<string, unknown>) : fromHeader;
    }
    let body: unknown;
    try {
        body = JSON.parse(rawBody);
    } catch {
        return undefined;
    }
    const token = typeof body === "object" && body !== null ? (body as { token?: unknown }).token : undefined;
    return typeof token === "string" ? verifyJwt(token, secret) : undefined;
};

type Route = { readonly kind: "editor" | "refresh" | "proxy" } | { readonly kind: "doc" | "callback"; readonly key: string };

// The four routes of this listener's own, everything else being the document server's.
const routeOf = (url: URL, method: string): Route => {
    if (url.pathname === "/editor" && method === "GET") {
        return { kind: "editor" };
    }
    if (url.pathname === "/refresh" && method === "GET") {
        return { kind: "refresh" };
    }
    const keyed = /^\/(doc|callback)\/([^/]+)$/.exec(url.pathname);
    if (keyed === null) {
        return { kind: "proxy" };
    }
    const kind = keyed[1] === "doc" ? "doc" : "callback";
    const expected = kind === "doc" ? "GET" : "POST";
    return method === expected ? { kind, key: decodeURIComponent(keyed[2] ?? "") } : { kind: "proxy" };
};

export const createListener = (deps: ListenerDeps): Listener => {
    // Callbacks being handled, by key: a refresh waits for its key's final save to land before choosing the next key.
    const inFlight = new Map<string, Promise<unknown>>();
    let editorSockets = 0;

    const editor = (url: URL, res: http.ServerResponse): void => {
        const session = deps.sessions.session(url.searchParams.get("s") ?? "");
        if (session === undefined) {
            html(res, 404, endedPage());
            return;
        }
        html(res, 200, deps.pageFor(session));
    };

    // The editor page asks here when the server answers its key with "the version changed": the page is told the new
    // key instead of the editor's own "reload the page" warning, which would reload onto the same outdated key.
    const refresh = async (url: URL, res: http.ServerResponse): Promise<void> => {
        const session = deps.sessions.session(url.searchParams.get("s") ?? "");
        if (session === undefined) {
            json(res, 404, { error: "session ended" });
            return;
        }
        await inFlight.get(session.key);
        const config = await deps.refresh(session);
        if (config === undefined) {
            json(res, 404, { error: "no such document" });
            return;
        }
        deps.log(`refreshed ${session.path} onto a new key`);
        json(res, 200, config);
    };

    const document = async (req: http.IncomingMessage, res: http.ServerResponse, key: string): Promise<void> => {
        const token = bearerOf(req.headers.authorization);
        if (token === undefined || verifyJwt(token, deps.secret) === undefined) {
            deps.log(`document fetch refused: ${token === undefined ? "no signature" : "signature does not match the secret"}`);
            json(res, 401, { error: "unauthorized" });
            return;
        }
        const found = deps.sessions.document(key);
        const stream = found === undefined ? undefined : await deps.readDocument(found);
        if (stream === undefined) {
            deps.log(
                found === undefined ? `document fetch refused: no session holds key ${key}` : `document fetch refused: ${found.path} is not on disk`,
            );
            json(res, 404, { error: "no such document" });
            return;
        }
        res.writeHead(200, { "content-type": "application/octet-stream", "cache-control": "no-store" });
        stream.on("error", () => res.destroy());
        stream.pipe(res);
    };

    // Acts on one callback and answers whether it went well; a failed write is answered as one, so the server keeps the
    // document and the key stays usable.
    const settle = async (key: string, file: Document, claims: Record<string, unknown>): Promise<boolean> => {
        const status = typeof claims["status"] === "number" ? claims["status"] : Number.NaN;
        const url = typeof claims["url"] === "string" ? claims["url"] : undefined;
        try {
            if (status === FORCED_SAVE && url !== undefined) {
                deps.sessions.saved(key, await deps.saveDocument(file, url));
            } else if (status === FINAL_SAVE && url !== undefined) {
                // Nothing changed since the last forced save wrote these very bytes: writing them again would only
                // clobber whatever changed the file since (an agent's edit made while the editor sat idle).
                if (claims["notmodified"] !== true) {
                    await deps.saveDocument(file, url);
                }
                deps.sessions.closed(key);
            } else if (status === FINAL_SAVE_FAILED) {
                deps.sessions.closed(key);
            }
            return true;
        } catch (error) {
            deps.log(`saving ${file.path} failed: ${error instanceof Error ? error.message : String(error)}`);
            return false;
        }
    };

    const callback = async (req: http.IncomingMessage, res: http.ServerResponse, key: string): Promise<void> => {
        const claims = callbackClaims(req, await readBody(req, MAX_CALLBACK_BYTES), deps.secret);
        if (claims === undefined) {
            deps.log(`save callback refused: unsigned or missigned`);
            json(res, 401, { error: "unauthorized" });
            return;
        }
        const found = deps.sessions.document(key);
        if (found === undefined) {
            deps.log(`save callback refused: no session holds key ${key}`);
            json(res, 404, { error: "no such document" });
            return;
        }
        const handled = settle(key, found, claims);
        inFlight.set(key, handled);
        try {
            json(res, 200, { error: (await handled) ? 0 : 1 });
        } finally {
            if (inFlight.get(key) === handled) {
                inFlight.delete(key);
            }
        }
    };

    const proxy = (req: http.IncomingMessage, res: http.ServerResponse): void => {
        const port = deps.documentServerPort();
        if (port === undefined) {
            json(res, 503, { error: "the document server is not running" });
            return;
        }
        // X-Forwarded-Host/-Proto pass through: the preview proxy in front names the origin the server builds URLs from.
        const upstream = http.request(
            { host: "127.0.0.1", port, method: req.method, path: req.url, headers: withoutHopByHop(req.headers) },
            (answer) => {
                res.writeHead(answer.statusCode ?? 502, withoutHopByHop(answer.headers));
                answer.pipe(res);
            },
        );
        upstream.on("error", () => {
            if (res.headersSent) {
                res.destroy();
                return;
            }
            json(res, 502, { error: "the document server did not answer" });
        });
        req.pipe(upstream);
    };

    const server = http.createServer((req, res) => {
        const url = new URL(req.url ?? "/", "http://listener");
        const route = routeOf(url, req.method ?? "GET");
        void (async () => {
            switch (route.kind) {
                case "editor":
                    editor(url, res);
                    break;
                case "refresh":
                    await refresh(url, res);
                    break;
                case "doc":
                    await document(req, res, route.key);
                    break;
                case "callback":
                    await callback(req, res, route.key);
                    break;
                case "proxy":
                    proxy(req, res);
            }
        })().catch((error: unknown) => {
            deps.log(`request failed: ${error instanceof Error ? error.message : String(error)}`);
            if (!res.headersSent) {
                json(res, 500, { error: "internal" });
            }
            res.destroy();
        });
    });

    // The editors hold a socket.io connection to the document server.
    server.on("upgrade", (req, socket, head) => {
        socket.on("error", () => socket.destroy());
        const port = deps.documentServerPort();
        if (port === undefined) {
            socket.end("HTTP/1.1 503 Service Unavailable\r\n\r\n");
            return;
        }
        // Gone once either side ends it: the browser's (`end`), or the server's, which the relay passes on by ending this
        // side (`finish`). Neither waits for the other half, which a vanished client might never close.
        editorSockets += 1;
        let open = true;
        const gone = (): void => {
            if (open) {
                open = false;
                editorSockets -= 1;
            }
        };
        socket.once("end", gone);
        socket.once("finish", gone);
        socket.once("close", gone);
        relayUpgrade(http.request({ host: "127.0.0.1", port, method: req.method, path: req.url, headers: req.headers }), socket, head);
    });

    // 0.0.0.0: the document server reaches this from inside its container, through the engine's host gateway.
    const bind = (port: number): Promise<number> =>
        new Promise((resolve, reject) => {
            const failed = (error: Error): void => reject(error);
            server.once("error", failed);
            server.listen(port, "0.0.0.0", () => {
                server.off("error", failed);
                const address = server.address();
                resolve(typeof address === "object" && address !== null ? address.port : 0);
            });
        });

    return {
        server,
        listen: async (port = 0) => {
            if (port === 0) {
                return bind(0);
            }
            try {
                return await bind(port);
            } catch (error) {
                if ((error as NodeJS.ErrnoException).code !== "EADDRINUSE") {
                    throw error;
                }
                return bind(0);
            }
        },
        close: () => new Promise((resolve) => server.close(() => resolve())),
        editorsConnected: () => editorSockets,
    };
};
