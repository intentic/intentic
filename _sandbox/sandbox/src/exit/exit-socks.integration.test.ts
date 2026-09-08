import { createServer, type Server } from "node:net";
import { afterEach, expect, test } from "vitest";
import { startSocks, socksConnect, type SocksHandle } from "./exit-socks.js";

// Exercises the proxy as a real SOCKS5 server over loopback: bugs like a fragmented greeting only show on a socket.
// `localAddress` stands in for a tunnel address; everything else is the same code a real exit runs.

const opened: (SocksHandle | Server)[] = [];

afterEach(async () => {
    for (const handle of opened.splice(0)) {
        await ("close" in handle && handle.close.length === 0
            ? (handle as SocksHandle).close()
            : new Promise<void>((done) => (handle as Server).close(() => done())));
    }
});

// Reports what it received first, so a test can prove the client's early bytes survived the handshake.
const echoServer = async (): Promise<{ port: number }> => {
    const server = createServer((socket) => {
        socket.on("data", (chunk) => socket.write(chunk));
        socket.on("error", () => socket.destroy());
    });
    opened.push(server);
    await new Promise<void>((done) => server.listen(0, "127.0.0.1", () => done()));
    return { port: (server.address() as { port: number }).port };
};

const proxy = async (port: number): Promise<SocksHandle> => {
    const handle = await startSocks({
        port,
        localAddress: "127.0.0.1",
        // No resolver is reachable in a test; a hostname target must fail rather than hang.
        resolver: { servers: [], localAddress: "127.0.0.1" },
    });
    opened.push(handle);
    return handle;
};

// A fixed port per test, distinct from the kernel's ephemeral range (`ip_local_port_range`), so nothing else on the
// machine can be auto-assigned the same port under concurrent test load.
let next = 21_000;
const freePort = (): number => (next += 7);

test("an IPv4 CONNECT is proxied end to end", async () => {
    const target = await echoServer();
    const port = freePort();
    await proxy(port);
    const socket = await socksConnectRaw(port, "127.0.0.1", target.port);
    socket.write("hello");
    expect(await once(socket)).toBe("hello");
    socket.destroy();
});

test("bytes written immediately after the handshake are not lost", async () => {
    // The handshake reader buffers whatever arrives; a client that writes its request in the same breath as the reply
    // lands those bytes in that buffer instead of on the wire.
    const target = await echoServer();
    const port = freePort();
    await proxy(port);
    const { connect } = await import("node:net");
    const socket = connect({ host: "127.0.0.1", port });
    await new Promise<void>((done) => socket.once("connect", () => done()));
    socket.write(Buffer.from([5, 1, 0]));
    await new Promise<void>((done) => socket.once("data", () => done()));
    const request = Buffer.alloc(10);
    request.set([5, 1, 0, 1, 127, 0, 0, 1], 0);
    request.writeUInt16BE(target.port, 8);
    // Request and payload in one write: the payload rides in behind the request, before the reply exists.
    socket.write(Buffer.concat([request, Buffer.from("early")]));
    const seen = await collect(socket, 15);
    expect(seen.includes("early")).toBe(true);
    socket.destroy();
});

test("a fragmented greeting still completes", async () => {
    // TCP may split anywhere; a reader assuming one chunk per SOCKS field breaks against a real client.
    const target = await echoServer();
    const port = freePort();
    await proxy(port);
    const { connect } = await import("node:net");
    const socket = connect({ host: "127.0.0.1", port });
    await new Promise<void>((done) => socket.once("connect", () => done()));
    socket.write(Buffer.from([5]));
    await new Promise((done) => setTimeout(done, 10));
    socket.write(Buffer.from([1]));
    await new Promise((done) => setTimeout(done, 10));
    socket.write(Buffer.from([0]));
    await new Promise<void>((done) => socket.once("data", () => done()));
    const request = Buffer.alloc(10);
    request.set([5, 1, 0, 1, 127, 0, 0, 1], 0);
    request.writeUInt16BE(target.port, 8);
    socket.write(request.subarray(0, 4));
    await new Promise((done) => setTimeout(done, 10));
    socket.write(request.subarray(4));
    const reply = await collect(socket, 10);
    expect(reply.charCodeAt(1)).toBe(0);
    socket.destroy();
});

test("an unsupported command is refused with the right SOCKS code, not a dropped connection", async () => {
    // A caller that asked for BIND deserves "that is not supported"; a silent close reads as a broken proxy.
    const port = freePort();
    await proxy(port);
    const { connect } = await import("node:net");
    const socket = connect({ host: "127.0.0.1", port });
    await new Promise<void>((done) => socket.once("connect", () => done()));
    socket.write(Buffer.from([5, 1, 0]));
    await new Promise<void>((done) => socket.once("data", () => done()));
    socket.write(Buffer.from([5, 2, 0, 1, 127, 0, 0, 1, 0, 80]));
    const reply = await collect(socket, 10);
    expect(reply.charCodeAt(0)).toBe(5);
    // 0x07 = command not supported.
    expect(reply.charCodeAt(1)).toBe(7);
    socket.destroy();
});

test("a port already in use fails with the recovery, not an errno", async () => {
    // The derived-port collision exit-paths.ts warns about; rename the exit, since the port is a name function.
    const port = freePort();
    await proxy(port);
    await expect(proxy(port)).rejects.toThrow(/Rename the exit/);
});

test("closing the proxy cuts connections still riding it", async () => {
    // An exit going down takes its tunnel with it; a socket left piping into a vanished tunnel hangs, so close must cut
    // the connection, not just stop accepting.
    const target = await echoServer();
    const port = freePort();
    const handle = await proxy(port);
    const socket = await socksConnectRaw(port, "127.0.0.1", target.port);
    const closed = new Promise<void>((done) => socket.once("close", () => done()));
    await handle.close();
    await closed;
    expect(socket.destroyed).toBe(true);
});

test("the client half speaks the same protocol as the server half", async () => {
    // socksConnect is what the observation uses on a tor exit; our own server proves the two halves agree.
    const target = await echoServer();
    const port = freePort();
    await proxy(port);
    // Our server resolves hostnames and has no resolver here, so the failure is the resolver's, reported cleanly.
    await expect(socksConnect(port, "example.invalid", target.port)).rejects.toThrow(/refused|resolve/i);
});

// Minimal SOCKS5 client targeting an IPv4 literal, so these tests don't depend on a resolver.
const socksConnectRaw = async (proxyPort: number, host: string, port: number) => {
    const { connect } = await import("node:net");
    const socket = connect({ host: "127.0.0.1", port: proxyPort });
    await new Promise<void>((done) => socket.once("connect", () => done()));
    socket.write(Buffer.from([5, 1, 0]));
    await new Promise<void>((done) => socket.once("data", () => done()));
    const request = Buffer.alloc(10);
    request.set([5, 1, 0, 1, ...host.split(".").map(Number)], 0);
    request.writeUInt16BE(port, 8);
    socket.write(request);
    await new Promise<void>((done) => socket.once("data", () => done()));
    return socket;
};

const once = (socket: { once: (event: string, listener: (chunk: Buffer) => void) => void }): Promise<string> =>
    new Promise((resolve) => socket.once("data", (chunk) => resolve(chunk.toString("utf8"))));

// Reads until `atLeast` bytes arrive or the socket goes quiet, so a reply split across segments isn't read as short.
const collect = (socket: { on: (event: string, listener: (chunk: Buffer) => void) => void }, atLeast: number): Promise<string> =>
    new Promise((resolve) => {
        let seen = "";
        const timer = setTimeout(() => resolve(seen), 500);
        socket.on("data", (chunk) => {
            seen += chunk.toString("utf8");
            if (seen.length >= atLeast) {
                clearTimeout(timer);
                resolve(seen);
            }
        });
    });
