import { connect, createServer, isIP, type Server, type Socket } from "node:net";
import { type ExitResolver, resolveThroughExit } from "./exit-dns.js";

/* THE OPT-IN SEAM. An exit brings up a tunnel and installs a default route in ITS OWN routing table; nothing
 * on the machine uses that table by accident, because a route in a private table is reached only by an `ip
 * rule` and the only rule pointing at it matches the tunnel's own source address. This server is what makes
 * that address usable: a SOCKS5 proxy on loopback whose outbound sockets bind to it.
 *
 * So the shape of the whole feature is: the sandbox's default route is never touched, the daemon's uplink, the
 * model endpoint and the tunnel that makes this sandbox reachable are untouched by a live exit, and anything
 * that wants to come out in another country says so by pointing at 127.0.0.1:<port>.
 *
 * Tor needs none of this, it publishes a SOCKS port itself. This serves the tunnel-based providers (VPN Gate,
 * WireGuard), which publish an interface.
 *
 * CONNECT only. No BIND, no UDP ASSOCIATE, no authentication: the listener is on loopback inside a container
 * that is itself the isolation boundary, so an auth handshake would protect nothing and only give callers a
 * way to configure it wrong.
 */

const SOCKS_VERSION = 0x05;
const CMD_CONNECT = 0x01;
const ATYP_IPV4 = 0x01;
const ATYP_DOMAIN = 0x03;
const ATYP_IPV6 = 0x04;
const REP_OK = 0x00;
const REP_GENERAL_FAILURE = 0x01;
const REP_HOST_UNREACHABLE = 0x04;
const REP_CMD_UNSUPPORTED = 0x07;
const REP_ATYP_UNSUPPORTED = 0x08;

// A dial that hasn't resolved by now is wedged. Generous because the far side of an exit is a volunteer relay
// on a domestic line as often as it is a datacenter, and a 5s budget would report healthy exits as broken.
const DIAL_TIMEOUT_MS = 30_000;

/* Incremental reads over a socket that may fragment anywhere. Every SOCKS field is length-prefixed by
 * something read earlier, so the parser is a sequence of "give me exactly N bytes" and this is that. The
 * buffer is drained rather than re-scanned, so what is left when the handshake finishes is the client's first
 * payload byte, which must not be dropped on the floor when the pipe is wired up. */
class ByteReader {
    private buffer = Buffer.alloc(0);
    private want = 0;
    private deliver: ((chunk: Buffer) => void) | undefined;
    private failed: Error | undefined;
    private fail: ((error: Error) => void) | undefined;
    private readonly onData: (chunk: Buffer) => void;
    private readonly onError: (error: Error) => void;
    private readonly onClose: () => void;

    constructor(private readonly socket: Socket) {
        this.onData = (chunk) => {
            this.buffer = Buffer.concat([this.buffer, chunk]);
            this.flush();
        };
        const abort = (error: Error): void => {
            this.failed = error;
            this.fail?.(error);
        };
        this.onError = abort;
        this.onClose = () => abort(new Error("client closed the connection mid-handshake"));
        socket.on("data", this.onData);
        socket.on("error", this.onError);
        socket.on("close", this.onClose);
    }

    /* MUST be called once the handshake is done and before the socket is piped or handed on. A `data` listener
     * left attached goes on concatenating every byte of the proxied conversation into a buffer nobody reads,
     * which on a large download is the whole download held in memory twice. */
    detach(): void {
        this.socket.removeListener("data", this.onData);
        this.socket.removeListener("error", this.onError);
        this.socket.removeListener("close", this.onClose);
    }

    private flush(): void {
        if (this.deliver === undefined || this.buffer.length < this.want) {
            return;
        }
        const chunk = this.buffer.subarray(0, this.want);
        this.buffer = this.buffer.subarray(this.want);
        const deliver = this.deliver;
        this.deliver = undefined;
        this.fail = undefined;
        deliver(chunk);
    }

    read(count: number): Promise<Buffer> {
        if (this.failed !== undefined) {
            return Promise.reject(this.failed);
        }
        return new Promise((resolve, reject) => {
            this.want = count;
            this.deliver = resolve;
            this.fail = reject;
            this.flush();
        });
    }

    // Whatever arrived after the handshake and before the pipe was wired. Usually empty; not always, an HTTP
    // client that writes its request immediately after the SOCKS reply lands its first bytes here, and losing
    // them would hang the request forever.
    rest(): Buffer {
        const remainder = this.buffer;
        this.buffer = Buffer.alloc(0);
        return remainder;
    }
}

// The SOCKS5 reply frame. BND.ADDR/BND.PORT are meaningless for CONNECT (no client uses them) and are sent as
// zeroes, which is what every other implementation does.
const reply = (code: number): Buffer => Buffer.from([SOCKS_VERSION, code, 0x00, ATYP_IPV4, 0, 0, 0, 0, 0, 0]);

export interface SocksOptions {
    readonly port: number;
    // The tunnel address outbound sockets bind to. THE point of the whole server: the `ip rule` that sends
    // traffic into the exit's routing table matches on exactly this source address.
    readonly localAddress: string;
    readonly resolver: ExitResolver;
    readonly onError?: ((message: string) => void) | undefined;
}

export interface SocksHandle {
    readonly port: number;
    readonly close: () => Promise<void>;
}

const readTarget = async (reader: ByteReader): Promise<{ host: string; port: number; resolve: boolean }> => {
    const [version, command, , type] = await reader.read(4);
    if (version !== SOCKS_VERSION) {
        throw Object.assign(new Error("not a SOCKS5 request"), { code: REP_GENERAL_FAILURE });
    }
    if (command !== CMD_CONNECT) {
        throw Object.assign(new Error("only CONNECT is supported through an exit"), { code: REP_CMD_UNSUPPORTED });
    }
    if (type === ATYP_IPV4) {
        const address = await reader.read(4);
        const port = (await reader.read(2)).readUInt16BE(0);
        return { host: [...address].join("."), port, resolve: false };
    }
    if (type === ATYP_DOMAIN) {
        const length = (await reader.read(1))[0] ?? 0;
        const host = (await reader.read(length)).toString("utf8");
        const port = (await reader.read(2)).readUInt16BE(0);
        return { host, port, resolve: true };
    }
    if (type === ATYP_IPV6) {
        const address = await reader.read(16);
        const port = (await reader.read(2)).readUInt16BE(0);
        const groups: string[] = [];
        for (let byte = 0; byte < 16; byte += 2) {
            groups.push(address.readUInt16BE(byte).toString(16));
        }
        return { host: groups.join(":"), port, resolve: false };
    }
    throw Object.assign(new Error("unsupported address type"), { code: REP_ATYP_UNSUPPORTED });
};

const dial = (host: string, port: number, localAddress: string): Promise<Socket> =>
    new Promise((resolve, reject) => {
        const upstream = connect({ host, port, localAddress });
        const timer = setTimeout(() => {
            upstream.destroy();
            reject(new Error(`${host}:${port} did not answer through the exit within ${DIAL_TIMEOUT_MS / 1000}s`));
        }, DIAL_TIMEOUT_MS);
        upstream.once("connect", () => {
            clearTimeout(timer);
            resolve(upstream);
        });
        upstream.once("error", (error) => {
            clearTimeout(timer);
            reject(error);
        });
    });

export const startSocks = (options: SocksOptions): Promise<SocksHandle> =>
    new Promise((resolve, reject) => {
        // Every socket this proxy owns, so `close` can actually cut them. server.close() alone only stops
        // accepting: a download in flight would keep a tunnel that is being torn down alive underneath it.
        const live = new Set<Socket>();
        const server: Server = createServer((client) => {
            live.add(client);
            client.on("close", () => live.delete(client));
            client.on("error", () => client.destroy());
            void (async () => {
                const reader = new ByteReader(client);
                try {
                    // Greeting: version, method count, then that many method bytes, all discarded. We answer
                    // "no authentication" regardless, which is the only method offered.
                    const [version, methods] = await reader.read(2);
                    if (version !== SOCKS_VERSION) {
                        client.destroy();
                        return;
                    }
                    await reader.read(methods ?? 0);
                    client.write(Buffer.from([SOCKS_VERSION, 0x00]));
                    const target = await readTarget(reader);
                    // A hostname is resolved THROUGH the exit, never by this container's resolver: see
                    // exit-dns.ts for why a leak here would undo the country switch without changing the IP.
                    const address = target.resolve ? await resolveThroughExit(options.resolver, target.host) : target.host;
                    if (isIP(address) === 0) {
                        throw Object.assign(new Error(`could not resolve ${target.host}`), { code: REP_HOST_UNREACHABLE });
                    }
                    const upstream = await dial(address, target.port, options.localAddress);
                    client.write(reply(REP_OK));
                    // Bytes the client sent between our reply and this pipe being wired: replayed first, or an
                    // eager HTTP request would be lost and the connection would hang until it timed out.
                    const pending = reader.rest();
                    reader.detach();
                    if (pending.length > 0) {
                        upstream.write(pending);
                    }
                    live.add(upstream);
                    upstream.on("close", () => live.delete(upstream));
                    upstream.on("error", () => {
                        client.destroy();
                        upstream.destroy();
                    });
                    client.pipe(upstream);
                    upstream.pipe(client);
                } catch (error) {
                    const message = error instanceof Error ? error.message : String(error);
                    options.onError?.(message);
                    const code = typeof (error as { code?: unknown }).code === "number" ? (error as { code: number }).code : REP_HOST_UNREACHABLE;
                    if (client.writable) {
                        client.write(reply(code));
                    }
                    client.destroy();
                }
            })();
        });
        server.once("error", (error) => {
            // EADDRINUSE here is the derived-port collision exit-paths.ts warns about, and it is worth naming,
            // the recovery is renaming an exit, which nobody guesses from a bare errno.
            const message =
                (error as NodeJS.ErrnoException).code === "EADDRINUSE"
                    ? `local port ${options.port} is already taken, so this exit cannot publish its proxy. Rename the exit (its port is derived from its name).`
                    : error.message;
            reject(new Error(message));
        });
        // Loopback ONLY. A proxy into another country bound to 0.0.0.0 inside a container with published ports
        // is an open relay, and an open relay is how an IP range gets burned for everyone using it.
        server.listen(options.port, "127.0.0.1", () => {
            resolve({
                port: options.port,
                close: () =>
                    new Promise<void>((done) => {
                        server.close(() => done());
                        // Cut live proxied connections. Correct: the exit is going down, and a socket still
                        // piping through a tunnel that is about to disappear would hang rather than fail.
                        for (const socket of live) {
                            socket.destroy();
                        }
                        live.clear();
                    }),
            });
        });
    });

/* The client half, for talking THROUGH a SOCKS proxy we did not open, which in practice means Tor. Returns a
 * connected socket with the handshake already done, so a caller can put TLS or an HTTP request straight on it.
 */
export const socksConnect = (proxyPort: number, host: string, port: number): Promise<Socket> =>
    new Promise((resolve, reject) => {
        const socket = connect({ host: "127.0.0.1", port: proxyPort });
        const reader = new ByteReader(socket);
        const timer = setTimeout(() => {
            socket.destroy();
            reject(new Error(`the exit's proxy did not open a connection to ${host}:${port} within ${DIAL_TIMEOUT_MS / 1000}s`));
        }, DIAL_TIMEOUT_MS);
        const fail = (error: Error): void => {
            clearTimeout(timer);
            socket.destroy();
            reject(error);
        };
        socket.once("error", fail);
        socket.once("connect", () => {
            void (async () => {
                try {
                    socket.write(Buffer.from([SOCKS_VERSION, 0x01, 0x00]));
                    const [, method] = await reader.read(2);
                    if (method !== 0x00) {
                        throw new Error("the exit's proxy asked for an authentication method we do not offer");
                    }
                    // Always ATYP_DOMAIN: handing the NAME to the proxy is what lets Tor resolve it at the exit
                    // rather than here, which is both the private answer and the geographically correct one.
                    const name = Buffer.from(host, "utf8");
                    const request = Buffer.alloc(7 + name.length);
                    request[0] = SOCKS_VERSION;
                    request[1] = CMD_CONNECT;
                    request[2] = 0x00;
                    request[3] = ATYP_DOMAIN;
                    request[4] = name.length;
                    name.copy(request, 5);
                    request.writeUInt16BE(port, 5 + name.length);
                    socket.write(request);
                    const [, code, , type] = await reader.read(4);
                    if (code !== REP_OK) {
                        throw new Error(`the exit's proxy refused ${host}:${port} (SOCKS reply ${code})`);
                    }
                    // The bound address is unused but must be consumed, it sits between here and the payload.
                    if (type === ATYP_IPV4) {
                        await reader.read(6);
                    } else if (type === ATYP_IPV6) {
                        await reader.read(18);
                    } else {
                        const length = (await reader.read(1))[0] ?? 0;
                        await reader.read(length + 2);
                    }
                    clearTimeout(timer);
                    socket.removeListener("error", fail);
                    // Hand the socket on clean: the reader's own listeners would otherwise keep buffering the
                    // whole conversation that follows, and the caller is about to put TLS on top of this.
                    reader.detach();
                    resolve(socket);
                } catch (error) {
                    fail(error instanceof Error ? error : new Error(String(error)));
                }
            })();
        });
    });
