import { Agent, request as h1Request, type IncomingMessage, type OutgoingHttpHeaders, type ServerResponse } from "node:http";
import {
    type ClientHttp2Session,
    connect as h2Connect,
    constants,
    createServer as createH2Server,
    type IncomingHttpHeaders,
    type ServerHttp2Stream,
} from "node:http2";
import { type AddressInfo, createServer as createNetServer, connect as netConnect, type Socket } from "node:net";
import { Duplex } from "node:stream";

// Both ends of the ingress tunnel's h2 session, over any node Duplex, in one file: a wire format with two owners
// drifts. h2 gives multiplexing and backpressure for free; routing is per h2 stream, since one edge connection can
// interleave several sandboxes' hosts.

// Header hygiene

// Headers that must not cross a hop: h2 throws on these, and `host` is replaced by :authority.
const HOP_BY_HOP = new Set([
    "connection",
    "host",
    "http2-settings",
    "keep-alive",
    "proxy-authenticate",
    "proxy-authorization",
    "proxy-connection",
    "te",
    "trailer",
    "transfer-encoding",
    "upgrade",
]);

// Headers that survive a hop: pseudo-headers and HOP_BY_HOP removed, values unchanged, including array values for a
// repeated field like `set-cookie`.
const endToEnd = (headers: IncomingHttpHeaders): OutgoingHttpHeaders => {
    const kept: OutgoingHttpHeaders = {};
    for (const [name, value] of Object.entries(headers)) {
        if (value !== undefined && !name.startsWith(":") && !HOP_BY_HOP.has(name)) {
            kept[name] = value;
        }
    }
    return kept;
};

// The upgrade envelope

// A websocket upgrade rides a CONNECT stream, where the headers an upgrade needs (Connection, Upgrade,
// Sec-WebSocket-Key) are exactly the ones h2 forbids. The whole h1 request head travels prefixed under `x-ingress-*`
// and is rebuilt verbatim on the far side, so no header is individually allowlisted.
const UPGRADE_METHOD_HEADER = "x-ingress-method";
const UPGRADE_PATH_HEADER = "x-ingress-path";
const UPGRADE_HEADER_PREFIX = "x-ingress-h-";

const upgradeEnvelope = (request: IncomingMessage, authority: string): OutgoingHttpHeaders => {
    const envelope: OutgoingHttpHeaders = {
        [constants.HTTP2_HEADER_METHOD]: constants.HTTP2_METHOD_CONNECT,
        [constants.HTTP2_HEADER_AUTHORITY]: authority,
        [UPGRADE_METHOD_HEADER]: request.method ?? "GET",
        [UPGRADE_PATH_HEADER]: request.url ?? "/",
    };
    for (const [name, value] of Object.entries(request.headers)) {
        if (value !== undefined) {
            envelope[`${UPGRADE_HEADER_PREFIX}${name}`] = value;
        }
    }
    return envelope;
};

// Rebuilds the h1 head an envelope carried; anything without the `x-ingress-h-` prefix is dropped as not part of the
// original request.
const upgradeHead = (headers: IncomingHttpHeaders): { method: string; path: string; headers: OutgoingHttpHeaders } => {
    const rebuilt: OutgoingHttpHeaders = {};
    for (const [name, value] of Object.entries(headers)) {
        if (value !== undefined && name.startsWith(UPGRADE_HEADER_PREFIX)) {
            rebuilt[name.slice(UPGRADE_HEADER_PREFIX.length)] = value;
        }
    }
    return {
        method: single(headers[UPGRADE_METHOD_HEADER]) ?? "GET",
        path: single(headers[UPGRADE_PATH_HEADER]) ?? "/",
        headers: rebuilt,
    };
};

// First value of a header that should never repeat; a repeated one is taken as its first value.
const single = (value: string | string[] | undefined): string | undefined => (Array.isArray(value) ? value[0] : value);

// Serializes a response head verbatim from `rawHeaders` (order and spelling preserved) since it is written raw onto the
// browser's socket; latin1, since header values are opaque octets, not utf-8 text.
const serializeHead = (response: IncomingMessage, drop: ReadonlySet<string>, add: readonly string[]): Buffer => {
    const lines = [`HTTP/${response.httpVersion} ${String(response.statusCode)} ${response.statusMessage ?? ""}`];
    for (let index = 0; index + 1 < response.rawHeaders.length; index += 2) {
        const name = response.rawHeaders[index] as string;
        if (!drop.has(name.toLowerCase())) {
            lines.push(`${name}: ${response.rawHeaders[index + 1] as string}`);
        }
    }
    return Buffer.from(`${[...lines, ...add].join("\r\n")}\r\n\r\n`, "latin1");
};

// A non-101 answer on a CONNECT stream needs re-framing: `transfer-encoding` is dropped since the body is already
// de-chunked, and `connection: close` delimits it instead.
const DECLINED_UPGRADE_DROP = new Set(["connection", "keep-alive", "transfer-encoding"]);
const DECLINED_UPGRADE_ADD = ["connection: close"];
const NOTHING_DROPPED: ReadonlySet<string> = new Set();

// Session tuning

// Session memory budget shared by every stream on the tunnel; exhausting it kills the whole session, not one request.
const MAX_SESSION_MEMORY_MB = 128;

// Per-stream receive window, larger than h2's 64KB default since this session crosses the internet.
const INITIAL_WINDOW_SIZE = 1024 * 1024;

// Concurrent stream ceiling per sandbox, raised since streams here can stay open for a session's whole life.
const PEER_MAX_CONCURRENT_STREAMS = 256;

// Fixed loopback address; no stream over this tunnel can be pointed anywhere but this container's own listener.
const LOOPBACK = "127.0.0.1";

// The splice

// Pipes both directions; `pipe` carries end-of-stream each way on its own. A failure on either side destroys both,
// since `destroy` is idempotent and the two handlers won't loop.
const splice = (left: Duplex, right: Duplex): void => {
    left.pipe(right);
    right.pipe(left);
    const fail = (): void => {
        left.destroy();
        right.destroy();
    };
    left.on("error", fail);
    right.on("error", fail);
    // A side that closes without finishing its writes (a reset, a dropped socket) takes the other side down too;
    // `writableFinished` distinguishes that from a graceful FIN already forwarded by the pipe.
    left.on("close", () => {
        if (!right.writableFinished) {
            right.destroy();
        }
    });
    right.on("close", () => {
        if (!left.writableFinished) {
            left.destroy();
        }
    });
};

// The loopback bridge

// Bridges the caller's Duplex onto a real net.Socket: node's Duplex-over-h2 wrapper allows one write in flight, so a
// same-turn second write throws ERR_INTERNAL_ASSERTION and kills the process. The accepted socket is checked against
// the one just dialed.
const loopbackBridge = async (): Promise<{ session: Socket; tunnel: Socket }> => {
    const listener = createNetServer();
    try {
        await new Promise<void>((resolve, reject) => {
            listener.once("error", reject);
            listener.listen(0, LOOPBACK, resolve);
        });
        const accepted = new Promise<Socket>((resolve, reject) => {
            listener.once("connection", resolve);
            listener.once("error", reject);
        });
        const tunnel = netConnect((listener.address() as AddressInfo).port, LOOPBACK);
        await new Promise<void>((resolve, reject) => {
            tunnel.once("connect", resolve);
            tunnel.once("error", reject);
        });
        const session = await accepted;
        if (session.remotePort !== tunnel.localPort) {
            session.destroy();
            tunnel.destroy();
            throw new Error("the loopback bridge accepted a connection that was not its own");
        }
        // Disables Nagle: both ends are local, and frames here are already sized by h2.
        session.setNoDelay(true);
        tunnel.setNoDelay(true);
        return { session, tunnel };
    } finally {
        listener.close();
    }
};

// The ingress half: an h2 client over the tunnel

export interface IngressSession {
    // Forwards one edge request down the tunnel. Resolves once the response is fully written; rejects on failure, and
    // the caller reads `response.headersSent` to tell an untouched response (write your own 502) from one truncated
    // mid-body.
    readonly forwardRequest: (request: IncomingMessage, response: ServerResponse) => Promise<void>;
    // Same for an upgrade, given the hijacked socket and any bytes already read past the request head. Nothing is
    // written to `socket` until the far end accepts, so a rejection leaves it untouched for the caller to answer.
    readonly forwardUpgrade: (request: IncomingMessage, socket: Duplex, head: Buffer) => Promise<void>;
    // Ends the session and its bridge, which ends the caller's duplex and closes the WebSocket.
    readonly close: () => void;
}

// Opens the ingress side of a tunnel; async since the bridge itself is. The connect URL is a placeholder — this session
// has no host of its own, every request supplies the authority it's routed by.
export const openIngressSession = async (duplex: Duplex): Promise<IngressSession> => {
    const bridge = await loopbackBridge();
    splice(bridge.tunnel, duplex);
    const session: ClientHttp2Session = h2Connect("http://tunnel.invalid", {
        createConnection: () => bridge.session,
        maxSessionMemory: MAX_SESSION_MEMORY_MB,
        peerMaxConcurrentStreams: PEER_MAX_CONCURRENT_STREAMS,
        settings: { initialWindowSize: INITIAL_WINDOW_SIZE },
    });
    // Without a handler here, a dead or hostile peer raises an uncaught exception and takes every other sandbox's
    // tunnel down with it. Destroying the duplex closes the WebSocket, which the reconnect loop waits on.
    session.on("error", () => duplex.destroy());
    session.on("close", () => duplex.destroy());

    // Authority to route the stream by. The ingress already refuses any Host that doesn't own a sandbox, so a request
    // with no Host here is a caller bug, not a routing decision.
    const authorityOf = (request: IncomingMessage): string => {
        const host = request.headers.host;
        if (host === undefined || host === "") {
            throw new Error("an ingress request is routed by its Host header, and this one has none");
        }
        return host;
    };

    const forwardRequest = (request: IncomingMessage, response: ServerResponse): Promise<void> =>
        new Promise<void>((resolve, reject) => {
            const authority = authorityOf(request);
            // `endStream: false` for every method, not only ones that may carry a body: the request is piped
            // regardless, and an already-ended GET closes the stream with an empty frame.
            const stream = session.request(
                {
                    [constants.HTTP2_HEADER_METHOD]: request.method ?? "GET",
                    [constants.HTTP2_HEADER_PATH]: request.url ?? "/",
                    [constants.HTTP2_HEADER_AUTHORITY]: authority,
                    // The edge is HTTPS-only, so this is what the browser used; nothing here routes on it.
                    [constants.HTTP2_HEADER_SCHEME]: "https",
                    ...endToEnd(request.headers),
                },
                { endStream: false },
            );
            request.pipe(stream);

            // The browser giving up must reach the daemon: without this, a closed tab leaves the h2 stream, the
            // daemon's own request, and any long-lived generator (SSE) running for nobody. RST_STREAM(CANCEL) unwinds
            // all three.
            response.on("close", () => {
                if (!response.writableFinished) {
                    stream.close(constants.NGHTTP2_CANCEL);
                }
            });

            stream.on("response", (headers) => {
                if (response.destroyed) {
                    stream.close(constants.NGHTTP2_CANCEL);
                    return;
                }
                response.writeHead(Number(headers[constants.HTTP2_HEADER_STATUS] ?? 502), endToEnd(headers));
                stream.pipe(response);
            });
            stream.on("error", reject);
            // The response resolves on `finish`, once node has flushed it to the browser, not merely when the h2 stream
            // closes.
            response.on("finish", resolve);
            stream.on("close", () => {
                if (!response.writableEnded) {
                    reject(new Error("the tunnel closed the stream before the response was complete"));
                }
            });
        });

    const forwardUpgrade = (request: IncomingMessage, socket: Duplex, head: Buffer): Promise<void> =>
        new Promise<void>((resolve, reject) => {
            const stream = session.request(upgradeEnvelope(request, authorityOf(request)), { endStream: false });
            stream.on("error", reject);
            stream.once("response", (headers) => {
                const status = Number(headers[constants.HTTP2_HEADER_STATUS]);
                if (status !== constants.HTTP_STATUS_OK) {
                    // The far end refused the upgrade; nothing has reached the browser yet, so the caller still owns
                    // the socket.
                    stream.close(constants.NGHTTP2_CANCEL);
                    reject(new Error(`the tunnel refused an upgrade with :status ${String(status)}`));
                    return;
                }
                // Bytes the client already sent past its request head; dropped, the handshake completes and then hangs
                // on a frame nobody has.
                if (head.length > 0) {
                    stream.write(head);
                }
                splice(stream, socket);
                resolve();
            });
        });

    return {
        forwardRequest,
        forwardUpgrade,
        // Graceful GOAWAY first, then the bridge's far half, which the session itself knows nothing about.
        close: () => {
            session.close(() => bridge.tunnel.destroy());
            bridge.tunnel.end();
        },
    };
};

// The daemon half: an h2 server over the tunnel, onto the loopback listener

export interface ServeIngressSessionOptions {
    // The daemon's own listener; every stream lands there as a plain HTTP/1.1 request or upgrade.
    readonly targetPort: number;
}

export interface IngressSessionServer {
    // Sends GOAWAY over the bridge, which ends the caller's duplex once it's done writing the shutdown frame. The
    // WebSocket itself belongs to whoever dialed it.
    readonly close: () => void;
}

// One h2 server per session, bound to nothing; it exists only to be handed a connection. The h1 hop to the loopback
// listener runs over a keep-alive agent, so steady traffic reuses sockets; the upgrade path does not.
export const serveIngressSession = async (duplex: Duplex, options: ServeIngressSessionOptions): Promise<IngressSessionServer> => {
    const bridge = await loopbackBridge();
    splice(bridge.tunnel, duplex);
    const agent = new Agent({ keepAlive: true, maxSockets: PEER_MAX_CONCURRENT_STREAMS });
    const server = createH2Server({
        maxSessionMemory: MAX_SESSION_MEMORY_MB,
        settings: { initialWindowSize: INITIAL_WINDOW_SIZE },
    });

    // A failed session is news for the reconnect loop, not an uncaught exception that takes the whole daemon down.
    // Destroying the duplex closes the WebSocket the loop waits on; `clientError` should never fire but isn't worth
    // crashing over either.
    server.on("sessionError", () => duplex.destroy());
    server.on("clientError", () => duplex.destroy());
    server.on("error", () => duplex.destroy());

    const forwardToLoopback = (stream: ServerHttp2Stream, headers: IncomingHttpHeaders): void => {
        const local = h1Request({
            host: LOOPBACK,
            port: options.targetPort,
            method: single(headers[constants.HTTP2_HEADER_METHOD]) ?? "GET",
            path: single(headers[constants.HTTP2_HEADER_PATH]) ?? "/",
            // The Host the request was made to, restored where an h1 server reads it; this alone tells a preview, a
            // port and the daemon apart.
            headers: { host: single(headers[constants.HTTP2_HEADER_AUTHORITY]) ?? "", ...endToEnd(headers) },
            agent,
        });
        stream.pipe(local);
        local.on("response", (response) => {
            stream.respond({ [constants.HTTP2_HEADER_STATUS]: response.statusCode ?? 502, ...endToEnd(response.headers) });
            response.pipe(stream);
        });
        // The listener isn't answering; closed with an error code rather than a 502 of our own, since the ingress owns
        // what an unreachable sandbox looks like.
        local.on("error", () => stream.close(constants.NGHTTP2_INTERNAL_ERROR));
        stream.on("error", () => local.destroy());
        // The edge cancelled (RST_STREAM); stop generating a response nobody reads. `aborted` is the only event that
        // means this — on a reset, node fires `aborted` before `finish` and `close`, so a
        // `writableEnded`/`writableFinished` guard there would miss it.
        stream.on("aborted", () => local.destroy());
    };

    const spliceUpgrade = (stream: ServerHttp2Stream, headers: IncomingHttpHeaders): void => {
        const head = upgradeHead(headers);
        // `agent: false`: an upgraded connection stops being HTTP once accepted and can never return to the keep-alive
        // pool the request path above uses.
        const local = h1Request({ host: LOOPBACK, port: options.targetPort, method: head.method, path: head.path, headers: head.headers, agent: false });
        local.on("upgrade", (response, socket, first) => {
            stream.respond({ [constants.HTTP2_HEADER_STATUS]: constants.HTTP_STATUS_OK });
            // Response head written verbatim (see serializeHead), then any bytes already sent past it, then the pipe.
            stream.write(serializeHead(response, NOTHING_DROPPED, []));
            if (first.length > 0) {
                stream.write(first);
            }
            splice(stream, socket);
        });
        // The local server declined to upgrade; its answer goes to the browser with framing that matches the already
        // de-chunked body.
        local.on("response", (response) => {
            stream.respond({ [constants.HTTP2_HEADER_STATUS]: constants.HTTP_STATUS_OK });
            stream.write(serializeHead(response, DECLINED_UPGRADE_DROP, DECLINED_UPGRADE_ADD));
            response.pipe(stream);
        });
        local.on("error", () => stream.close(constants.NGHTTP2_CONNECT_ERROR));
        // An upgrade request carries no body; the client is waiting on the handshake before it says anything else.
        local.end();
    };

    server.on("stream", (stream, headers) => {
        if (headers[constants.HTTP2_HEADER_METHOD] === constants.HTTP2_METHOD_CONNECT) {
            spliceUpgrade(stream, headers);
            return;
        }
        forwardToLoopback(stream, headers);
    });

    // Creates a server-side session without a listener: the server never binds, it is simply handed a connection.
    server.emit("connection", bridge.session);

    return {
        close: () => {
            agent.destroy();
            server.close();
            bridge.tunnel.end();
        },
    };
};

// Reimplements `ws`'s createWebSocketStream, which Bun does not support, so both runtimes get the same Duplex.
// Preserves byte safety: the write callback fires only once the socket has taken the frame, and a closed socket ends
// the readable side with `push(null)`.
export interface TunnelWebSocket {
    readonly send: (data: Buffer, options: { binary: boolean }, callback: (error?: Error) => void) => void;
    readonly close: () => void;
    readonly on: {
        (event: `message`, listener: (data: unknown) => void): unknown;
        (event: `close`, listener: () => void): unknown;
        (event: `error`, listener: (error: Error) => void): unknown;
    };
}

export const webSocketDuplex = (socket: TunnelWebSocket): Duplex => {
    const duplex = new Duplex({
        read: () => {},
        write: (chunk: Buffer, _encoding, callback) => {
            socket.send(chunk, { binary: true }, (error) => callback(error ?? null));
        },
        // Half-closing a WebSocket isn't possible; ending the writable side closes the socket outright.
        final: (callback) => {
            socket.close();
            callback();
        },
    });
    // `message` carries a Buffer for binary frames; a stray text frame arrives as a string and is coerced rather than
    // dropped.
    socket.on(`message`, (data: unknown) => {
        duplex.push(Buffer.isBuffer(data) ? data : Buffer.from(data as string));
    });
    socket.on(`close`, () => duplex.push(null));
    socket.on(`error`, (error: Error) => duplex.destroy(error));
    return duplex;
};
