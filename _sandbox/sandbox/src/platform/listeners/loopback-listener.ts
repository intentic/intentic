import type { Server as HttpServer } from "node:http";
import { createSecureServer } from "node:http2";
import { type AddressInfo, createServer as createNetServer, type Server as NetServer, type Socket } from "node:net";
import { Duplex } from "node:stream";
import { createAdaptorServer, type ServerType, type WebSocketServerLike } from "@hono/node-server";
import type { Hono } from "hono";

// Speaks plain HTTP and TLS on one port, so the DNS-free http://127.0.0.1 candidate and the publicly-named
// https://<id>.local.<zone> candidate share the one port the host publishes, instead of TLS quietly replacing HTTP once
// issued. The client's first byte picks the protocol; both branches terminate in the same app.

// TLS record ContentType (handshake); no HTTP method starts with this byte, which is the whole disambiguation.
const TLS_HANDSHAKE_BYTE = 0x16;

// How long an unclassified connection (a port scanner, a half-open probe) may hold a socket before being dropped.
const FIRST_BYTE_TIMEOUT_MS = 10_000;

// A request head is read off a plain connection before anything owns it, so its Host can pick the server; past this
// many bytes without a blank line it is the app's problem.
const HEAD_LIMIT_BYTES = 16 * 1024;

const headComplete = (head: Buffer): boolean => head.includes("\r\n\r\n") || head.length >= HEAD_LIMIT_BYTES;

// The Host header of a plain request head, undefined when there is none yet.
export const hostOf = (head: Buffer): string | undefined => {
    const text = head.toString("latin1");
    const end = text.indexOf("\r\n\r\n");
    const match = /^host:[ \t]*([^\r\n]*)/im.exec(end === -1 ? text : text.slice(0, end));
    return match?.[1]?.trim();
};

export interface LoopbackCertificate {
    readonly certificate: string;
    readonly privateKey: string;
}

export interface LoopbackListenerOptions {
    readonly fetch: Hono["fetch"];
    readonly port: number;
    readonly hostname: string;
    readonly sockets: WebSocketServerLike;
    // Absent until issuance lands; the listener then serves plain HTTP alone (every browser but Safari).
    readonly certificate: LoopbackCertificate | undefined;
    // The preview proxy, given every plain connection whose Host it owns (`port-<slot>-<id>.localhost` and its
    // siblings): previews then have a loopback lane too, on this same published port, for a browser on this machine.
    // Plain HTTP only: TLS hides the Host until the handshake, and `*.localhost` needs no certificate to be trusted.
    readonly preview?: { readonly server: HttpServer; readonly owns: (hostHeader: string | undefined) => boolean } | undefined;
}

export interface LoopbackListener {
    readonly close: () => void;
    // What the port speaks right now, for the boot log and the renewal loop; false is a normal state, not degraded.
    readonly tls: () => boolean;
    // Takes or replaces the certificate without restarting anything: the listener is up long before issuance can land,
    // and a certificate handed over later takes effect immediately instead of at the next restart.
    readonly useCertificate: (certificate: LoopbackCertificate) => void;
    // The port actually bound (the requested one, unless a test asked for 0); resolves once the socket is accepting.
    readonly listening: Promise<number>;
}

// Feeds the sniffed first byte back to whichever server reads the connection: a plain server can `unshift` it onto its
// stream, but a TLS server reads its socket's native handle directly and needs it wrapped in a plain Duplex first.
const rewound = (socket: Socket, first: Buffer): Duplex => {
    const stream = new Duplex({
        read: () => void socket.resume(),
        write: (chunk: Buffer, _encoding, callback) => void socket.write(chunk, callback),
        final: (callback) => void socket.end(callback),
    });
    stream.push(first);
    // Backpressure both ways: stop reading the socket when the wrapper is full, resume when `read` drains it.
    socket.on(`data`, (chunk: Buffer) => {
        if (!stream.push(chunk)) {
            socket.pause();
        }
    });
    socket.on(`end`, () => void stream.push(null));
    socket.on(`error`, (error) => stream.destroy(error));
    // Either end closing takes the other with it; `destroy` is idempotent so the two settle instead of bouncing.
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
    const { fetch, port, hostname, sockets, certificate, preview } = options;

    // The plain half, always present: needs no DNS, so it still answers when the network is offline.
    const plain = createAdaptorServer({ fetch, hostname, websocket: { server: sockets } });

    // Present only once there's a certificate. HTTP/2 is why this exists: it stops six-per-origin from starving this
    // app's long-lived streams.
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
                // Session memory (10MB default) is now shared by every stream on the connection, replays included.
                maxSessionMemory: 128,
            },
        });

    // Mutable since a certificate can arrive or be replaced while serving; a replaced server is kept, not closed, until
    // its in-flight sockets drain on their own.
    let secure: ServerType | undefined = certificate === undefined ? undefined : tlsServer(certificate);
    const superseded: ServerType[] = [];

    // The port itself is a bare TCP listener; neither backing server binds it, they're only fed sockets.
    const router: NetServer = createNetServer((socket) => {
        // Set here or nowhere: the TLS server writes through the `rewound` wrapper, so its own setNoDelay never reaches
        // this socket, and Nagle holds a new connection's first answer for a delayed ACK (about 45 ms measured).
        socket.setNoDelay(true);
        const timer = setTimeout(() => socket.destroy(), FIRST_BYTE_TIMEOUT_MS);
        // Unref'd so a pending classification never keeps the process alive at shutdown.
        timer.unref();
        socket.once(`data`, (first: Buffer) => {
            clearTimeout(timer);
            const wantsTls = first.length > 0 && first[0] === TLS_HANDSHAKE_BYTE;
            if (wantsTls && secure === undefined) {
                // A TLS hello with no certificate to answer it; closing lets the browser fall to its next candidate.
                socket.destroy();
                return;
            }
            if (wantsTls || preview === undefined) {
                handOff(wantsTls ? (secure as ServerType) : plain, socket, first, wantsTls);
                return;
            }
            // Plain HTTP with a preview proxy to choose from: the head decides, and whoever gets it gets it whole.
            let head = first;
            const settle = (): void => {
                socket.off(`data`, more);
                handOff(preview.owns(hostOf(head)) ? preview.server : plain, socket, head, false);
            };
            const more = (chunk: Buffer): void => {
                head = Buffer.concat([head, chunk]);
                if (headComplete(head)) {
                    settle();
                }
            };
            if (headComplete(head)) {
                settle();
            } else {
                socket.on(`data`, more);
            }
        });
        // A connection that errors before classification belongs to nobody; nothing else will report it.
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
