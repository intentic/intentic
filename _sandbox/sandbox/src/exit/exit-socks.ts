import { connect, createServer, isIP, type Server, type Socket } from "node:net";
import { errorMessage } from "@intentic/base/errors";
import { type ExitResolver, resolveThroughExit } from "./exit-dns.js";

// A SOCKS5 proxy on loopback whose outbound sockets bind to the tunnel's own source address, the only thing the exit's
// `ip rule` matches. Serves tunnel-based providers (VPN Gate, WireGuard); tor publishes its own SOCKS port and needs
// none of this. CONNECT only, no auth: the listener is on loopback inside an already-isolated container.

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

// Generous: a home-line relay is as common as a datacenter; a short budget reports healthy exits as broken.
const DIAL_TIMEOUT_MS = 30_000;

// Incremental reads over a socket that may fragment anywhere; every SOCKS field is length-prefixed, so the parser asks
// for exactly N bytes at a time. What's left after the handshake is the client's first payload byte.
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

    // Must be called once the handshake is done, before the socket is piped or handed on, or a lingering `data`
    // listener buffers the whole proxied conversation in memory.
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

    // Whatever arrived after the handshake and before the pipe was wired; usually empty, but an eager client's first
    // bytes land here and must not be dropped.
    rest(): Buffer {
        const remainder = this.buffer;
        this.buffer = Buffer.alloc(0);
        return remainder;
    }
}

// The SOCKS5 reply frame; BND.ADDR/BND.PORT don't matter for CONNECT, sent as zeroes like other implementations.
const reply = (code: number): Buffer => Buffer.from([SOCKS_VERSION, code, 0x00, ATYP_IPV4, 0, 0, 0, 0, 0, 0]);

export interface SocksOptions {
    readonly port: number;
    // The tunnel address outbound sockets bind to; the exit's `ip rule` matches on this exact source address.
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
        // Every socket this proxy owns, so `close` can cut them; server.close() alone only stops accepting new ones.
        const live = new Set<Socket>();
        const server: Server = createServer((client) => {
            live.add(client);
            client.on("close", () => live.delete(client));
            client.on("error", () => client.destroy());
            void (async () => {
                const reader = new ByteReader(client);
                try {
                    // Greeting: version, method count, then that many method bytes, discarded; we always answer "no
                    // authentication".
                    const [version, methods] = await reader.read(2);
                    if (version !== SOCKS_VERSION) {
                        client.destroy();
                        return;
                    }
                    await reader.read(methods ?? 0);
                    client.write(Buffer.from([SOCKS_VERSION, 0x00]));
                    const target = await readTarget(reader);
                    // Resolved through the exit, never by this container's resolver, or the country switch leaks
                    // through DNS.
                    const address = target.resolve ? await resolveThroughExit(options.resolver, target.host) : target.host;
                    if (isIP(address) === 0) {
                        throw Object.assign(new Error(`could not resolve ${target.host}`), { code: REP_HOST_UNREACHABLE });
                    }
                    const upstream = await dial(address, target.port, options.localAddress);
                    client.write(reply(REP_OK));
                    // Bytes the client sent before the pipe was wired, replayed first, or an eager request hangs until
                    // it times out.
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
                    const message = errorMessage(error);
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
            // EADDRINUSE here is the derived-port collision exit-paths.ts warns about; the fix is renaming the exit.
            const message =
                (error as NodeJS.ErrnoException).code === "EADDRINUSE"
                    ? `local port ${options.port} is already taken, so this exit cannot publish its proxy. Rename the exit (its port is derived from its name).`
                    : error.message;
            reject(new Error(message));
        });
        // Loopback only: bound to 0.0.0.0 inside a container with published ports, this would be an open relay.
        server.listen(options.port, "127.0.0.1", () => {
            resolve({
                port: options.port,
                close: () =>
                    new Promise<void>((done) => {
                        server.close(() => done());
                        // Cuts live proxied connections; the exit is going down, and a socket still piping through it
                        // would hang.
                        for (const socket of live) {
                            socket.destroy();
                        }
                        live.clear();
                    }),
            });
        });
    });

// The client half, for talking through a SOCKS proxy this process did not open (in practice, Tor); returns a connected
// socket with the handshake already done.
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
                    // Always ATYP_DOMAIN: handing the proxy a name, not an address, is what lets Tor resolve it at the
                    // exit.
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
                    // The bound address is unused but must still be consumed; it sits between here and the payload.
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
                    // Hand the socket on clean, or the reader's listeners keep buffering the conversation the caller
                    // puts TLS on.
                    reader.detach();
                    resolve(socket);
                } catch (error) {
                    fail(error instanceof Error ? error : new Error(String(error)));
                }
            })();
        });
    });
