import http from "node:http";
import type { Readable } from "node:stream";
import { relayUpgrade } from "@intentic/sandbox-contract/upgrade-relay";
import { endedPage } from "./host-page.js";
import { bearerOf, verifyJwt } from "./jwt.js";
import type { Session, Sessions } from "./sessions.js";

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
    // The document's bytes, or undefined when it is gone.
    readonly readDocument: (document: Document) => Promise<Readable | undefined>;
    // Fetches the edited document the server offers at `url` and writes it to the workspace.
    readonly saveDocument: (key: string, document: Document, url: string) => Promise<void>;
    readonly log: (line: string) => void;
}

export interface Listener {
    readonly server: http.Server;
    readonly listen: () => Promise<number>;
    readonly close: () => Promise<void>;
}

// Bounded: a callback is a few hundred bytes of JSON.
const MAX_CALLBACK_BYTES = 1024 * 1024;

// The document server posts these when the document should be written: every editor closed (2), or a Ctrl+S with
// forcesave on (6). The others are lifecycle notices.
const SAVE_STATUSES = new Set([2, 6]);

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

type Route = { readonly kind: "editor" | "proxy" } | { readonly kind: "doc" | "callback"; readonly key: string };

// The three routes of this listener's own, everything else being the document server's.
const routeOf = (url: URL, method: string): Route => {
    if (url.pathname === "/editor" && method === "GET") {
        return { kind: "editor" };
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
    const editor = (url: URL, res: http.ServerResponse): void => {
        const session = deps.sessions.session(url.searchParams.get("s") ?? "");
        if (session === undefined) {
            html(res, 404, endedPage());
            return;
        }
        html(res, 200, deps.pageFor(session));
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
        const status = typeof claims["status"] === "number" ? claims["status"] : Number.NaN;
        const url = typeof claims["url"] === "string" ? claims["url"] : undefined;
        if (SAVE_STATUSES.has(status) && url !== undefined) {
            try {
                await deps.saveDocument(key, found, url);
            } catch (error) {
                deps.log(`saving ${found.path} failed: ${error instanceof Error ? error.message : String(error)}`);
                json(res, 200, { error: 1 });
                return;
            }
        }
        json(res, 200, { error: 0 });
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
        relayUpgrade(http.request({ host: "127.0.0.1", port, method: req.method, path: req.url, headers: req.headers }), socket, head);
    });

    return {
        server,
        // 0.0.0.0: the document server reaches this from inside its container, through the engine's host gateway.
        listen: () =>
            new Promise((resolve, reject) => {
                server.on("error", reject);
                server.listen(0, "0.0.0.0", () => {
                    const address = server.address();
                    resolve(typeof address === "object" && address !== null ? address.port : 0);
                });
            }),
        close: () => new Promise((resolve) => server.close(() => resolve())),
    };
};
