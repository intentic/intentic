import { createSecureServer } from "node:http2";
import { type AddressInfo, createServer as createNetServer, type Server as NetServer, type Socket } from "node:net";
import { Duplex } from "node:stream";
import { createAdaptorServer, type ServerType, type WebSocketServerLike } from "@hono/node-server";
import type { Hono } from "hono";

/* THE LOOPBACK LISTENER SPEAKS BOTH PROTOCOLS ON ONE PORT, and that is what makes the shortcut survive the
 * network going away.
 *
 * The browser has two ways to reach a sandbox on its own machine (editor endpoint.ts): `https://<id>.local.
 * <zone>:<port>`, a public name whose A record points at 127.0.0.1, and `http://127.0.0.1:<port>`, which the
 * mixed-content spec calls potentially-trustworthy so Chrome and Firefox accept it from an HTTPS page. It
 * probes both. Only one port is ever published to the host, so both land HERE.
 *
 * They used to be alternatives in TIME rather than in parallel: the port served plain HTTP until a
 * certificate was obtained and TLS forever after. That reads as a clean upgrade and is a single point of
 * failure. The certified name is a PUBLIC name, so reaching it costs a DNS lookup on the public internet,
 * and the moment issuance succeeded the DNS-free candidate stopped answering. A sandbox one loopback hop from
 * the browser was then reachable only via a name the internet had to resolve: when the owner's connection
 * dropped, `<id>.local.<zone>` stopped resolving, `127.0.0.1` had nothing listening for plain HTTP, and the tunnel
 * was gone with the connection. Three dead candidates, a healthy daemon, and the editor showing "connecting".
 *
 * So the two are offered TOGETHER and the client picks per connection. The first byte says which: a TLS
 * record begins with ContentType 0x16 (handshake), and every HTTP request line begins with an ASCII method,
 * so one byte separates them with no ambiguity to resolve. This is the httpolyglot trick, and the reason it
 * is safe here is that both branches terminate in the SAME app with the same auth in front of it; the choice
 * is transport only, never authority.
 *
 * Loopback-only by construction: the caller binds this to the container's internal interface and the run
 * publishes it to 127.0.0.1 on the host (sandbox-run), so "plain HTTP is acceptable" is a statement about a
 * socket that cannot leave the machine, not about the network. */

// TLS record ContentType 22 (handshake). No HTTP method starts with it, which is the whole disambiguation.
const TLS_HANDSHAKE_BYTE = 0x16;

/* A connection that opens and says nothing cannot be classified, so it is not kept. Port scanners, a
 * half-open probe and a browser that changed its mind all land here, and without a bound they would each hold
 * a socket and its listener for as long as the daemon runs. Generous next to a real client, which sends its
 * first byte in the same breath as the SYN. */
const FIRST_BYTE_TIMEOUT_MS = 10_000;

export interface LoopbackCertificate {
    readonly certificate: string;
    readonly privateKey: string;
}

export interface LoopbackListenerOptions {
    readonly fetch: Hono["fetch"];
    readonly port: number;
    readonly hostname: string;
    readonly sockets: WebSocketServerLike;
    // Absent until (or unless) issuance lands: the listener then serves plain HTTP alone, which is every
    // browser but Safari, and is what the sandbox served before a certificate existed anyway.
    readonly certificate: LoopbackCertificate | undefined;
}

export interface LoopbackListener {
    readonly close: () => void;
    // What the port can speak RIGHT NOW, for the boot log and for the renewal loop to check its work. `tls`
    // false is a normal state, not a degraded one.
    readonly tls: () => boolean;
    /* Take (or replace) the certificate without restarting anything.
     *
     * Issuance takes a CA tens of seconds to validate DNS, so the listener has to be up long before it can
     * land: boot reads whatever is on disk and this is how the answer arrives afterwards. Without it a
     * sandbox's FIRST certificate did nothing until the next restart, and since a fresh sandbox has no
     * certificate at all, that meant every new sandbox served its shortcut in plain HTTP/1.1 for as long as it
     * stayed up. Renewal has the same shape and the same fix. */
    readonly useCertificate: (certificate: LoopbackCertificate) => void;
    // The port actually bound, which is the requested one everywhere except a test that asked for 0. Resolves
    // when the socket is accepting, so a caller that must not race the first connection can await it.
    readonly listening: Promise<number>;
}

/* GIVING THE SNIFFED BYTE BACK, which the two servers need done in two different ways.
 *
 * A plain HTTP server reads its connection as a JS stream, so `unshift` genuinely puts the byte back: the
 * server then parses a request it never saw taken apart. The pause/resume around it is not optional, because
 * `emit("connection")` runs the server's own setup synchronously and that setup may pause the socket;
 * resuming before it has happened loses the connection instead of feeding it.
 *
 * A TLS server does NOT, and this is the part that silently does not work. `tls.Server` wraps the socket's
 * native handle and reads from it directly, underneath the JS stream entirely, so an unshifted byte sits in a
 * buffer nothing will ever look at: the handshake waits forever for a ClientHello whose first byte we are
 * holding, and the client eventually gives up with "socket disconnected before secure TLS connection was
 * established". Feeding it a stream with no handle is what makes it read at the JS level instead (node wraps
 * such a stream rather than reaching for `_handle`), and the byte is then simply the first thing on it.
 *
 * Nothing is lost by the wrap: the app reads no connection info off these sockets, and both halves of the
 * pair are loopback either way. */
const rewound = (socket: Socket, first: Buffer): Duplex => {
    const stream = new Duplex({
        read: () => void socket.resume(),
        write: (chunk: Buffer, _encoding, callback) => void socket.write(chunk, callback),
        final: (callback) => void socket.end(callback),
    });
    stream.push(first);
    // Backpressure both ways: stop reading the socket when the wrapper's buffer is full, and let `read` above
    // start it again. Without this a fast client outruns TLS and the wrapper grows without bound.
    socket.on(`data`, (chunk: Buffer) => {
        if (!stream.push(chunk)) {
            socket.pause();
        }
    });
    socket.on(`end`, () => void stream.push(null));
    socket.on(`error`, (error) => stream.destroy(error));
    // Either end closing takes the other with it; `destroy` is idempotent, so the two listeners settle rather
    // than bouncing a close back and forth.
    socket.on(`close`, () => stream.destroy());
    stream.on(`close`, () => socket.destroy());
    return stream;
};

const handOff = (server: ServerType, socket: Socket, first: Buffer, tls: boolean): void => {
    if (tls) {
        server.emit(`connection`, rewound(socket, first));
        return;
    }
    socket.pause();
    socket.unshift(first);
    server.emit(`connection`, socket);
    socket.resume();
};

export const createLoopbackListener = (options: LoopbackListenerOptions): LoopbackListener => {
    const { fetch, port, hostname, sockets, certificate } = options;

    // The plain half, always present: it is the candidate that needs no DNS, and therefore the one that still
    // answers when the machine is offline.
    const plain = createAdaptorServer({ fetch, hostname, websocket: { server: sockets } });

    /* The TLS half, present only once there is a certificate to serve it with.
     *
     * HTTP/2, and that is not a performance nicety, it is what stops the workspace freezing. A browser allows
     * SIX concurrent HTTP/1.1 connections per origin, and this app holds LONG-LIVED ones: `/events` for every
     * window, plus an `/agent/attach` for every conversation with a live turn. Four or five of those consume
     * every slot and the next ordinary read simply queues in the browser until a stream ends, which presents
     * as "the sandbox froze" with a silent, healthy log. One h2 connection carries ~100 streams instead.
     *
     * `allowHTTP1` is required rather than tidy: WebSocket has no h2 form here (node does not advertise the
     * extended-CONNECT setting RFC 8441 needs), so the browser opens a separate http/1.1 connection for the
     * terminal, which this accepts, and whose `upgrade` event still reaches the `ws` server. */
    const tlsServer = (loaded: LoopbackCertificate): ServerType =>
        createAdaptorServer({
            fetch,
            hostname,
            websocket: { server: sockets },
            createServer: createSecureServer,
            serverOptions: {
                cert: loaded.certificate,
                key: loaded.privateKey,
                allowHTTP1: true,
                // Node's default session memory (10MB) is a budget shared by every stream on the connection,
                // which is now ALL of them, including transcript replays that arrive in multi-megabyte bursts.
                // Exceeding it kills the whole workspace's connection at once.
                maxSessionMemory: 128,
            },
        });

    /* Mutable, because a certificate can arrive (or be replaced) while this is serving, and rebuilding the
     * listener to take one would drop every connection on the port to gain a protocol.
     *
     * A replaced server is kept rather than closed: the sockets it is already serving are mid-request, and
     * `close()` on an http2 server waits for them anyway. It stops receiving NEW connections the moment the
     * reference moves, drains on its own, and is closed for real at shutdown. */
    let secure: ServerType | undefined = certificate === undefined ? undefined : tlsServer(certificate);
    const superseded: ServerType[] = [];

    /* The port itself is a bare TCP listener: neither backing server binds, they are fed sockets. That is why
     * both can own the same port without either knowing the other exists. */
    const router: NetServer = createNetServer((socket) => {
        const timer = setTimeout(() => socket.destroy(), FIRST_BYTE_TIMEOUT_MS);
        // Unref'd so a pending classification is never what keeps the process alive at shutdown.
        timer.unref();
        socket.once(`data`, (first: Buffer) => {
            clearTimeout(timer);
            const wantsTls = first.length > 0 && first[0] === TLS_HANDSHAKE_BYTE;
            if (wantsTls && secure === undefined) {
                /* A TLS hello with nothing to answer it. Closing beats a plain-HTTP error, which the client
                 * would read as a corrupt handshake anyway: the browser then falls to its next candidate,
                 * which is the point. Reached when a certificate expired or was removed under a client that
                 * still remembers the certified address. */
                socket.destroy();
                return;
            }
            handOff(wantsTls ? (secure as ServerType) : plain, socket, first, wantsTls);
        });
        // A connection that errors before it is classified belongs to nobody, so nothing else will report it.
        socket.once(`error`, () => socket.destroy());
    });
    const listening = new Promise<number>((resolve, reject) => {
        router.once(`listening`, () => resolve((router.address() as AddressInfo).port));
        router.once(`error`, reject);
    });
    router.listen(port, hostname);

    return {
        tls: (): boolean => secure !== undefined,
        listening,
        useCertificate: (loaded: LoopbackCertificate): void => {
            const previous = secure;
            secure = tlsServer(loaded);
            if (previous !== undefined) {
                superseded.push(previous);
            }
        },
        close: (): void => {
            router.close();
            plain.close();
            secure?.close();
            for (const drained of superseded) {
                drained.close();
            }
        },
    };
};
