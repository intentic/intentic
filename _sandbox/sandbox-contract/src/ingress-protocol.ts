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
import type { Duplex } from "node:stream";

/* THE DATA PLANE OF THE INGRESS TUNNEL: both halves of it, over any node Duplex, in node core alone.
 *
 * ./ingress-contract.ts pins WHAT the parties agree on (the grant, the host routing, the door, the env names)
 * and states that the session over the tunnel is a cleartext HTTP/2 one. This file is that session, and it
 * holds both ends on purpose: they are one wire format, and a wire format with two owners is a wire format
 * that drifts. The ingress calls `openIngressSession` (h2 CLIENT over the WebSocket's byte stream), the daemon
 * calls `serveIngressSession` (h2 SERVER over the same stream, forwarding to its own loopback listener).
 *
 * WHY H2 AND NOT FRAMES OF OUR OWN. The tunnel carries every request for a sandbox: many at once, some of them
 * long-lived (an SSE stream per browser window, an agent attach per live turn), some of them multi-megabyte in
 * either direction. A hand-rolled protocol over the WebSocket would need stream ids, interleaving, per-stream
 * flow control and half-close, which is HTTP/2's entire specification, implemented worse and tested less. Node
 * ships it: `http2.connect({ createConnection })` and `server.emit("connection", duplex)` will run a session
 * over anything that is a Duplex, so the WebSocket is reduced to what it is good at (one authenticated,
 * proxy-traversing, framed byte pipe) and the multiplexing is nghttp2's.
 *
 * It also fixes backpressure for free, and that is not a small thing here. The daemon's OTHER byte tunnel
 * (_sandbox/sandbox/src/platform/sync-ssh.ts) has to poll `ws.bufferedAmount` against a high/low watermark and
 * pause the TCP socket by hand, because `ws.send()` accepts everything and reports nothing: there is no
 * backpressure signal on a raw WebSocket to propagate. Every hop HERE is a node stream with its own
 * ({ h1 socket ⇄ h2 stream ⇄ h2 session ⇄ ws duplex }), so `pipe` propagates the whole chain and a slow browser
 * ends up slowing the daemon's own socket, which is the correct outcome and none of our code.
 *
 * WHY PER-REQUEST ROUTING IS THE POINT (the property to preserve if this file is ever rewritten): the edge
 * terminates TLS under ONE wildcard certificate, and h2 browsers coalesce connections across every host a
 * certificate covers, so a single edge connection interleaves requests for several sandboxes. The unit of
 * routing is therefore the REQUEST, and each one arrives here already carrying the host it was made to. A
 * design that routed a connection by its first Host would deliver one user's requests into another user's
 * container.
 *
 * BYTE SAFETY. Nothing in this file hands a pooled Buffer to an asynchronous writer: every hop is a stream
 * write whose completion callback gates the next read (`createWebSocketStream` calls `ws.send(chunk, callback)`
 * with the stream's own write callback, so the chunk is owned until the frame is out). That is the property
 * sync-ssh.ts has to copy each chunk to obtain — see `frameOf` there — and the reason it does not have to be
 * done here rather than an accident.
 *
 * ── WRITE SERIALIZATION: WHY THE CALLER'S DUPLEX IS BRIDGED ONTO A REAL SOCKET ───────────────────────────
 *
 * Both factories take a Duplex and neither gives it to node's http2. Each one first opens a loopback socket
 * pair, splices the caller's Duplex onto one end, and runs the h2 session over the other, which is a genuine
 * `net.Socket`. That hop is not free and it is not optional.
 *
 * NODE CANNOT RUN HTTP/2 OVER A PLAIN DUPLEX WITHOUT CRASHING THE PROCESS. `http2.connect({ createConnection })`
 * and `server.emit("connection", stream)` accept anything stream-shaped, but a session needs a NATIVE handle to
 * consume, so anything that is not a `net.Socket` is wrapped in an internal `JSStreamSocket` first (verified:
 * a Duplex yields `session.socket.constructor.name === "JSStreamSocket"`, a real socket yields `Socket`). That
 * wrapper permits exactly ONE write in flight: `doWrite` opens with `assert(this[kCurrentWriteRequest] === null)`
 * and clears that slot from a `setImmediate`, so a SECOND write dispatched in the same turn does not queue, it
 * throws ERR_INTERNAL_ASSERTION out of an internal callback — an uncaught exception, with no `try` of ours
 * anywhere on the stack, killing the process.
 *
 * Two writes in one turn is not an exotic interleaving here, it is Tuesday: nghttp2 emits a control frame the
 * moment it has one, so a RST_STREAM (a browser tab closing mid-SSE) or a GOAWAY (a tunnel being displaced)
 * lands on top of a data write that has not completed. Measured, it did two things at once — the assertion
 * killed the process AND the RST_STREAM it was trying to write never went out, so the cancellation never
 * reached the container either. On the ingress, which holds every sandbox's tunnel in one process, one
 * sandbox's ordinary traffic pattern would take every other sandbox offline.
 *
 * A wrapper around the caller's Duplex cannot fix it: the slot is cleared on a `setImmediate` inside node, so
 * no completion discipline available to us makes a same-turn second write legal. A real socket has a real
 * handle, libuv queues concurrent writes, and the whole failure class is gone. The cost is one loopback hop per
 * TUNNEL (not per request, not per byte of setup) on a stream that has already crossed the internet.
 *
 * The tests below pin it from the outside: `a burst of mid-stream cancellations` drives exactly that
 * interleaving through the public API. Do not "simplify" the bridge away because the Duplex looks like it would
 * work — it works right up until someone closes a tab. */

// ── Header hygiene ──────────────────────────────────────────────────────────────────────────────────────

/* WHAT MAY NOT CROSS, in either direction, and this is enforcement rather than tidiness: node's http2 THROWS
 * on connection-specific headers (ERR_HTTP2_INVALID_CONNECTION_HEADERS) because RFC 9113 §8.2.2 forbids them,
 * and node's h1 server would happily accept a forwarded `transfer-encoding` and then frame the body twice.
 *
 * `host` is in the set because :authority carries it: it is re-derived on the far side rather than duplicated,
 * so the two can never disagree about which sandbox a request is for. Pseudo-headers are dropped by the same
 * function (they are h2's own and never belong on an h1 message), which is why every mapping below is one call
 * plus the fields that mapping adds. */
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

// Everything that survives a hop: the end-to-end headers, pseudo-headers and hop-by-hop ones removed. Values
// stay as they arrived, including the arrays node uses for a repeated field (`set-cookie`), which both node's
// h1 and h2 writers re-emit as repeated fields.
const endToEnd = (headers: IncomingHttpHeaders): OutgoingHttpHeaders => {
    const kept: OutgoingHttpHeaders = {};
    for (const [name, value] of Object.entries(headers)) {
        if (value !== undefined && !name.startsWith(":") && !HOP_BY_HOP.has(name)) {
            kept[name] = value;
        }
    }
    return kept;
};

// ── The upgrade envelope ────────────────────────────────────────────────────────────────────────────────

/* A WEBSOCKET UPGRADE RIDES A CONNECT STREAM, AND ITS ORIGINAL HEAD RIDES UNDER A PREFIX.
 *
 * The h2 form of an upgrade would be extended CONNECT (RFC 8441, `:protocol`), which needs the
 * enableConnectProtocol setting negotiated on both ends; and a plain CONNECT stream may not carry `:path` or
 * `:scheme` at all — node enforces that with ERR_HTTP2_CONNECT_PATH. The headers that MATTER for an upgrade are
 * exactly the ones h2 rejects, too: `Connection: Upgrade` and `Upgrade: websocket` are connection-specific by
 * definition, and `Sec-WebSocket-Key` is meaningless without them.
 *
 * So the rule is one rule instead of two: on a CONNECT stream NOTHING is a real header. The whole h1 request
 * head travels under `x-ingress-*` — method, path, and every original field under `x-ingress-h-` — and the far
 * side rebuilds it verbatim before performing a genuine h1 upgrade against its loopback port. `:authority` is
 * ALSO set, though the daemon reads the host back out of the envelope: it keeps a packet capture readable and
 * keeps the "every stream names its sandbox" property literally true of every stream.
 *
 * Prefixing all of them rather than only the forbidden three is what makes this reviewable: there is no list to
 * remember of which fields are envelope and which are cargo, and no chance of a header nobody thought about
 * (`te`, a future h2 addition) taking the wrong path and killing the stream instead of the request. */
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

// The h1 head an envelope was made from. Anything not carrying the prefix is not part of the original request
// (h2 pseudo-headers, and whatever a future version of this file adds beside them), so it is dropped.
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

// One value of a header that should never have been repeated. A repeated `x-ingress-path` is not a request
// anyone can serve, so the first is taken rather than guessed at or concatenated.
const single = (value: string | string[] | undefined): string | undefined => (Array.isArray(value) ? value[0] : value);

/* THE UPGRADED RESPONSE HEAD GOES BACK AS BYTES, not as h2 headers, and that is the choice that makes this
 * path short. Past a successful CONNECT the stream is a raw pipe, so the FIRST thing on it is the local
 * server's own response head, serialized from `rawHeaders` — original spelling, original order, original
 * values. The ingress therefore writes the daemon's literal `101 Switching Protocols` (and its
 * `Sec-WebSocket-Accept`, which is a digest of the key the browser sent and must not be recomputed by anyone)
 * onto the browser's socket without knowing what a WebSocket is.
 *
 * It also means a local server that DECLINES the upgrade — a 404 for a path it does not serve — reaches the
 * browser as that 404 rather than as a synthesized error or a hang, since its head takes the same route.
 *
 * latin1, because that is what node's h1 parser decoded these bytes as: header values are opaque octets, and
 * re-encoding them as utf-8 would mangle any field that is not ASCII (a filename in a Content-Disposition) into
 * different bytes than the ones that arrived. */
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

/* A non-101 answer on a CONNECT stream needs its FRAMING rewritten even though its head is passed through:
 * node's h1 client has already de-chunked the body it is about to hand us, so forwarding the
 * `transfer-encoding: chunked` that described it would have the browser parse chunk headers that are no longer
 * there. Dropping it and saying `connection: close` leaves the body delimited by the close that this path
 * performs anyway, which is the one framing that is true of what we are about to send. */
const DECLINED_UPGRADE_DROP = new Set(["connection", "keep-alive", "transfer-encoding"]);
const DECLINED_UPGRADE_ADD = ["connection: close"];
const NOTHING_DROPPED: ReadonlySet<string> = new Set();

// ── Session tuning ──────────────────────────────────────────────────────────────────────────────────────

/* Node's default session memory is 10MB, and it is a budget SHARED by every stream on the connection. Here the
 * connection is the sandbox's only route in, so exhausting it does not slow one request down, it kills the
 * whole session and every request on it at once — and the traffic that exhausts it is ordinary for this
 * workspace (a transcript replay, a file download, an upload). Same number and the same reasoning as the
 * daemon's own h2 listener (platform/loopback-listener.ts). Megabytes. */
const MAX_SESSION_MEMORY_MB = 128;

/* A BIGGER RECEIVE WINDOW, because unlike every other h2 session in this repo, this one crosses the internet.
 * h2's default per-stream window is 65535 bytes: the sender stops after 64KB until a WINDOW_UPDATE comes back,
 * so one stream's throughput is capped at window/RTT — about 640KB/s over a 100ms link, whatever the pipe is
 * worth. At 1MB the same link carries ~10MB/s per stream, and the memory it can pin stays two orders below the
 * session budget above. */
const INITIAL_WINDOW_SIZE = 1024 * 1024;

/* How many streams the ingress will have in flight to one sandbox before it queues them locally. Node's
 * default is 100 until the peer's SETTINGS arrive, and this session's streams are not all short: one `/events`
 * per open browser window plus one attach per conversation with a live turn are held for as long as the
 * workspace is open. Queueing an ordinary read behind those is exactly the "the sandbox froze, and its log
 * looks healthy" failure that loopback-http2.integration.test.ts exists to pin, one layer out. */
const PEER_MAX_CONCURRENT_STREAMS = 256;

// The only address the daemon half will ever forward to. Fixed, like the SSH tunnel's (platform/sync-ssh.ts):
// the port comes from the daemon's own boot, the host is not the caller's to choose, so no stream arriving over
// this tunnel can be pointed at anything but this container's own listener.
const LOOPBACK = "127.0.0.1";

// ── The splice ──────────────────────────────────────────────────────────────────────────────────────────

/* Two streams, one connection. `pipe` carries end-of-stream in each direction on its own (a browser's FIN
 * becomes the h2 END_STREAM that becomes the local socket's FIN, which is what lets a WebSocket close
 * handshake complete rather than hang), so the only thing left to state is that a FAILURE on either side is
 * not a half-open connection: it takes both ends down. `destroy` is idempotent, so the two handlers settle
 * instead of bouncing a close back and forth. */
const splice = (left: Duplex, right: Duplex): void => {
    left.pipe(right);
    right.pipe(left);
    const fail = (): void => {
        left.destroy();
        right.destroy();
    };
    left.on("error", fail);
    right.on("error", fail);
    /* A peer that VANISHES (an h2 reset, a socket the network dropped) has to take the other half with it, or
     * the far end sits on a connection nobody is at the other end of. `writableFinished` is what separates that
     * from the graceful case, where the FIN has already been forwarded by the pipe above and destroying now
     * would truncate bytes that are still on their way out. */
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

// ── The loopback bridge ─────────────────────────────────────────────────────────────────────────────────

/* One connected pair of real sockets, for the reason set out at the top of this file. Both ends are this
 * process's own: a listener on 127.0.0.1 with an ephemeral port, one connection to it, and the listener shut
 * the moment that connection is accepted.
 *
 * THE ACCEPTED SOCKET IS CHECKED AGAINST OUR OWN, because for the microseconds the listener is up it is a port
 * on this machine that anything local may connect to, and a sandbox's tunnel is not something to hand to
 * whoever got there first. The first arrival either IS our connection — same remote port as our client's local
 * port, which the kernel guarantees is unique among live loopback connections — or the bridge fails outright
 * and the tunnel redials. There is deliberately no "wait for the right one": a stranger on this port means the
 * assumption behind the whole arrangement is wrong, and retrying with a fresh port is the only safe move. */
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
        // Nagle would batch this hop's writes into 40ms windows for no gain: both ends are in this process, and
        // the frames crossing here are already sized by h2.
        session.setNoDelay(true);
        tunnel.setNoDelay(true);
        return { session, tunnel };
    } finally {
        listener.close();
    }
};

// ── The ingress half: an h2 client over the tunnel ──────────────────────────────────────────────────────

export interface IngressSession {
    /* Forward one edge request down the tunnel and answer `response` with what comes back.
     *
     * Resolves when the response has been fully written. REJECTS when the exchange failed, and the caller reads
     * `response.headersSent` to know what that means: false, and nothing has been said to the browser yet, so
     * the ingress writes its own 502 (the body naming the sandbox label, which is the ingress's vocabulary and
     * not this file's); true, and the response was truncated mid-body, where a reset socket is the only honest
     * signal HTTP has. */
    readonly forwardRequest: (request: IncomingMessage, response: ServerResponse) => Promise<void>;
    /* The same for an upgrade, taking the hijacked socket and whatever bytes arrived past the request head.
     * Nothing is written to `socket` until the far end has accepted the stream, so a rejection leaves it
     * untouched and the caller free to answer on it (an h1 error head) rather than merely resetting it. */
    readonly forwardUpgrade: (request: IncomingMessage, socket: Duplex, head: Buffer) => Promise<void>;
    // Shutdown and displacement. Ends the session and drops the bridge under it, which ends the caller's duplex
    // and so closes the WebSocket.
    readonly close: () => void;
}

/* Open the ingress side of a tunnel. Asynchronous because the bridge is: a tunnel exists once its transport
 * does, which is also the moment the caller should register it.
 *
 * The URL is a placeholder and says so: a session with an authority of its own would invite exactly the mistake
 * the contract warns about, since every request that rides it carries the authority it must be routed by and
 * this session has no host of its own. */
export const openIngressSession = async (duplex: Duplex): Promise<IngressSession> => {
    const bridge = await loopbackBridge();
    splice(bridge.tunnel, duplex);
    const session: ClientHttp2Session = h2Connect("http://tunnel.invalid", {
        createConnection: () => bridge.session,
        maxSessionMemory: MAX_SESSION_MEMORY_MB,
        peerMaxConcurrentStreams: PEER_MAX_CONCURRENT_STREAMS,
        settings: { initialWindowSize: INITIAL_WINDOW_SIZE },
    });
    /* CONTAINMENT, and it is the whole reason this listener exists rather than a tidier `throw`. The ingress
     * holds every sandbox's tunnel in ONE process: a peer that vanishes mid-request, or one that speaks
     * nonsense, is a fact about that tunnel and must end at that tunnel's teardown. Without a handler here node
     * raises the session's error as an uncaught exception and takes every other sandbox down with it.
     *
     * Destroying the caller's duplex is what the registry is watching: the WebSocket closes, the id is
     * unregistered, and the container's own reconnect loop redials. */
    session.on("error", () => duplex.destroy());
    session.on("close", () => duplex.destroy());

    // The authority to route by, read off the request that is being forwarded. The ingress has already refused
    // anything without a sandbox-owned Host (hostOwnerId), so a request with no Host cannot reach here; if one
    // does, that is a bug in the caller and it says so rather than opening a stream to an empty authority.
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
            /* `endStream: false` for every method, so there is ONE code path: the request is piped, and a GET
             * (whose IncomingMessage is already ended) closes the stream with an empty frame the instant the
             * pipe runs. The alternative is a branch on which methods may carry a body, which is a list that
             * has been wrong in every proxy that has ever kept one. */
            const stream = session.request(
                {
                    [constants.HTTP2_HEADER_METHOD]: request.method ?? "GET",
                    [constants.HTTP2_HEADER_PATH]: request.url ?? "/",
                    [constants.HTTP2_HEADER_AUTHORITY]: authority,
                    // The edge is HTTPS-only (fly.toml forces it), so this is what the browser used. Nothing
                    // routes on it; `x-forwarded-proto` is what a framework behind us will read, and it rides
                    // through as an ordinary header.
                    [constants.HTTP2_HEADER_SCHEME]: "https",
                    ...endToEnd(request.headers),
                },
                { endStream: false },
            );
            request.pipe(stream);

            /* THE BROWSER GIVING UP HAS TO REACH THE DAEMON. Without this, a closed tab leaves the h2 stream
             * open, the daemon's own h1 request to its listener open behind it, and — for the long-lived
             * streams this tunnel mostly carries — an SSE generator producing frames for nobody, for as long as
             * the container lives. RST_STREAM(CANCEL) is the signal that unwinds all three. */
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
            // `close` after a clean exchange is the h2 stream ending; the response is only DONE once node has
            // flushed it to the browser, which is what the caller is waiting to hear.
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
                    // The far end refused to open the tunnel at all (its listener is down). Nothing has been
                    // written to the browser, so the caller still owns the socket and can say so properly.
                    stream.close(constants.NGHTTP2_CANCEL);
                    reject(new Error(`the tunnel refused an upgrade with :status ${String(status)}`));
                    return;
                }
                // Bytes the client sent past its request head, before anything of the far end's answer: they
                // are the first thing the local server must read, and dropping them is a WebSocket handshake
                // that completes and then hangs on a frame nobody has.
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
        // Graceful first (GOAWAY, then node ends its own socket), then the far half of the bridge, which the
        // session knows nothing about. Both sockets are this session's alone, so nothing else is affected.
        close: () => {
            session.close(() => bridge.tunnel.destroy());
            bridge.tunnel.end();
        },
    };
};

// ── The daemon half: an h2 server over the tunnel, onto the loopback listener ───────────────────────────

export interface ServeIngressSessionOptions {
    // The daemon's own listener. Every stream on this session lands there as a plain HTTP/1.1 request or a
    // genuine HTTP/1.1 upgrade — the Hono app already dispatches previews, ports and the outbox by Host.
    readonly targetPort: number;
}

export interface IngressSessionServer {
    /* Stop serving. The session says GOAWAY over its own half of the bridge; this ends the other half, which
     * ends the caller's duplex. The duplex is never destroyed out from under a session that is still writing
     * its shutdown frame — that ordering is what the WRITE SERIALIZATION note at the top of this file is
     * about. The WebSocket belongs to whoever dialled it and is closed there. */
    readonly close: () => void;
}

/* Serve the daemon side of a tunnel. One h2 server per session: it binds nothing and listens on nothing, it
 * exists to be handed a connection, which is the only way node exposes a server-side session at all.
 *
 * The h1 hop to the loopback listener runs over a keep-alive agent, so a workspace's steady traffic reuses
 * sockets instead of paying a connect per request; the upgrade path deliberately does not (below). */
export const serveIngressSession = async (duplex: Duplex, options: ServeIngressSessionOptions): Promise<IngressSessionServer> => {
    const bridge = await loopbackBridge();
    splice(bridge.tunnel, duplex);
    const agent = new Agent({ keepAlive: true, maxSockets: PEER_MAX_CONCURRENT_STREAMS });
    const server = createH2Server({
        maxSessionMemory: MAX_SESSION_MEMORY_MB,
        settings: { initialWindowSize: INITIAL_WINDOW_SIZE },
    });

    /* Same reasoning as the client's, one container in: a session that failed is news for the reconnect loop,
     * never an uncaught exception that takes the daemon — and with it the workspace, the agent turns and the
     * terminals — down over a dropped tunnel. Destroying the duplex closes the WebSocket, which is what that
     * loop waits on. `clientError` is the h1 door on an h2 server; nothing should ever arrive there, and if
     * something does it is still not worth a crash. */
    server.on("sessionError", () => duplex.destroy());
    server.on("clientError", () => duplex.destroy());
    server.on("error", () => duplex.destroy());

    const forwardToLoopback = (stream: ServerHttp2Stream, headers: IncomingHttpHeaders): void => {
        const local = h1Request({
            host: LOOPBACK,
            port: options.targetPort,
            method: single(headers[constants.HTTP2_HEADER_METHOD]) ?? "GET",
            path: single(headers[constants.HTTP2_HEADER_PATH]) ?? "/",
            // The Host the request was MADE to, put back where an h1 server reads it. This is the whole of how
            // a preview, a forwarded port and the daemon itself are told apart inside the container.
            headers: { host: single(headers[constants.HTTP2_HEADER_AUTHORITY]) ?? "", ...endToEnd(headers) },
            agent,
        });
        stream.pipe(local);
        local.on("response", (response) => {
            stream.respond({ [constants.HTTP2_HEADER_STATUS]: response.statusCode ?? 502, ...endToEnd(response.headers) });
            response.pipe(stream);
        });
        /* The listener is not answering. Closed with an error code rather than answered with a 502 of our own:
         * the ingress is the party that owns what an unreachable sandbox looks like to a browser (it has the
         * host label to name in the body), and one author for that message beats two that will drift. */
        local.on("error", () => stream.close(constants.NGHTTP2_INTERNAL_ERROR));
        stream.on("error", () => local.destroy());
        /* The edge cancelled (RST_STREAM): stop generating a response nobody will read. Without this, a closed
         * browser tab leaves an SSE route in this container producing frames until the daemon restarts.
         *
         * `aborted` is the event that means this and the only one that does. On an incoming RST node fires
         * `aborted`, then `finish`, then `close` — so a guard on `writableEnded` or `writableFinished` inside a
         * `close` handler reads as "ended normally" for a stream that was reset, which is how this was wrong
         * first: nothing propagated, and the target only noticed when the whole session went away. */
        stream.on("aborted", () => local.destroy());
    };

    const spliceUpgrade = (stream: ServerHttp2Stream, headers: IncomingHttpHeaders): void => {
        const head = upgradeHead(headers);
        /* `agent: false`, deliberately, where the request path above pools: an upgraded connection stops being
         * HTTP the moment it is accepted, so it can never go back in a keep-alive pool. Node would take it out
         * of one for us; asking for a dedicated socket says why. */
        const local = h1Request({ host: LOOPBACK, port: options.targetPort, method: head.method, path: head.path, headers: head.headers, agent: false });
        local.on("upgrade", (response, socket, first) => {
            stream.respond({ [constants.HTTP2_HEADER_STATUS]: constants.HTTP_STATUS_OK });
            // Verbatim, including Sec-WebSocket-Accept: see serializeHead. Then the bytes the local server had
            // already sent past its own head, then the pipe.
            stream.write(serializeHead(response, NOTHING_DROPPED, []));
            if (first.length > 0) {
                stream.write(first);
            }
            splice(stream, socket);
        });
        // The local server answered instead of upgrading. Its answer is the browser's answer; it just needs
        // framing that matches a body node has already de-chunked.
        local.on("response", (response) => {
            stream.respond({ [constants.HTTP2_HEADER_STATUS]: constants.HTTP_STATUS_OK });
            stream.write(serializeHead(response, DECLINED_UPGRADE_DROP, DECLINED_UPGRADE_ADD));
            response.pipe(stream);
        });
        local.on("error", () => stream.close(constants.NGHTTP2_CONNECT_ERROR));
        // An upgrade request carries no body: the head IS the request, and the client is waiting for the
        // handshake before it says anything else.
        local.end();
    };

    server.on("stream", (stream, headers) => {
        if (headers[constants.HTTP2_HEADER_METHOD] === constants.HTTP2_METHOD_CONNECT) {
            spliceUpgrade(stream, headers);
            return;
        }
        forwardToLoopback(stream, headers);
    });

    // This is the whole of how a server-side session is created without a listener of its own: the server never
    // binds, it is handed a connection — the same property platform/loopback-listener.ts relies on to feed a
    // rewound socket to a server that is already running.
    server.emit("connection", bridge.session);

    return {
        close: () => {
            agent.destroy();
            server.close();
            bridge.tunnel.end();
        },
    };
};
