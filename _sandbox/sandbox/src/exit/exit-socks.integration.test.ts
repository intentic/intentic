import { connect, createServer, type Socket } from "node:net";
import { SETTLES } from "@intentic/testing/vitest";
import { afterEach, expect, test } from "vitest";
import { startSocks, socksConnect, type SocksHandle } from "./exit-socks.js";

// Exercises the proxy as a real SOCKS5 server over loopback: bugs like a fragmented greeting only show on a socket.
// `localAddress` stands in for a tunnel address; everything else is the same code a real exit runs.

// Torn down last-opened-first, and every socket registered at birth: `server.close()` waits on its connections, so one
// client socket outliving the proxy it rode hangs the hook for its whole timeout instead of failing the test.
const opened: (() => void | Promise<void>)[] = [];

// What the proxy refused, if anything. Without it a dial that failed reads as "the bytes vanished", which sends the
// reader after the wrong bug.
const refused: string[] = [];

afterEach(async () => {
    refused.length = 0;
    for (const close of opened.splice(0).toReversed()) {
        await close();
    }
});

// Reports what it received first, so a test can prove the client's early bytes survived the handshake.
const echoServer = async (): Promise<{ port: number }> => {
    const live = new Set<Socket>();
    const server = createServer((socket) => {
        live.add(socket);
        socket.on("close", () => live.delete(socket));
        socket.on("data", (chunk) => socket.write(chunk));
        socket.on("error", () => socket.destroy());
    });
    opened.push(
        () =>
            new Promise<void>((done) => {
                for (const socket of live) {
                    socket.destroy();
                }
                server.close(() => done());
            }),
    );
    await new Promise<void>((done) => server.listen(0, "127.0.0.1", () => done()));
    return { port: (server.address() as { port: number }).port };
};

const proxy = async (port: number): Promise<SocksHandle> => {
    const handle = await startSocks({
        port,
        localAddress: "127.0.0.1",
        // No resolver is reachable in a test; a hostname target must fail rather than hang.
        resolver: { servers: [], localAddress: "127.0.0.1" },
        onError: (message) => refused.push(message),
    });
    opened.push(() => handle.close());
    return handle;
};

// A connected client socket, registered for teardown before the handshake it is about to fail somewhere inside.
const client = async (proxyPort: number): Promise<Socket> => {
    const socket = connect({ host: "127.0.0.1", port: proxyPort });
    opened.push(() => void socket.destroy());
    await new Promise<void>((done) => socket.once("connect", () => done()));
    return socket;
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
});

test("bytes written immediately after the handshake are not lost", async () => {
    // The handshake reader buffers whatever arrives; a client that writes its request in the same breath as the reply
    // lands those bytes in that buffer instead of on the wire.
    const target = await echoServer();
    const port = freePort();
    await proxy(port);
    const socket = await client(port);
    socket.write(Buffer.from([5, 1, 0]));
    await new Promise<void>((done) => socket.once("data", () => done()));
    const request = Buffer.alloc(10);
    request.set([5, 1, 0, 1, 127, 0, 0, 1], 0);
    request.writeUInt16BE(target.port, 8);
    // Request and payload in one write: the payload rides in behind the request, before the reply exists.
    socket.write(Buffer.concat([request, Buffer.from("early")]));
    const seen = await collect(socket, 15);
    expect(seen.includes("early"), `the proxy refused: ${refused.join("; ") || "nothing"}`).toBe(true);
});

test("a fragmented greeting still completes", async () => {
    // TCP may split anywhere; a reader assuming one chunk per SOCKS field breaks against a real client.
    const target = await echoServer();
    const port = freePort();
    await proxy(port);
    const socket = await client(port);
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
});

test("an unsupported command is refused with the right SOCKS code, not a dropped connection", async () => {
    // A caller that asked for BIND deserves "that is not supported"; a silent close reads as a broken proxy.
    const port = freePort();
    await proxy(port);
    const socket = await client(port);
    socket.write(Buffer.from([5, 1, 0]));
    await new Promise<void>((done) => socket.once("data", () => done()));
    socket.write(Buffer.from([5, 2, 0, 1, 127, 0, 0, 1, 0, 80]));
    const reply = await collect(socket, 10);
    expect(reply.charCodeAt(0)).toBe(5);
    // 0x07 = command not supported.
    expect(reply.charCodeAt(1)).toBe(7);
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
const socksConnectRaw = async (proxyPort: number, host: string, port: number): Promise<Socket> => {
    const socket = await client(proxyPort);
    socket.write(Buffer.from([5, 1, 0]));
    await new Promise<void>((done) => socket.once("data", () => done()));
    const request = Buffer.alloc(10);
    request.set([5, 1, 0, 1, ...host.split(".").map(Number)], 0);
    request.writeUInt16BE(port, 8);
    socket.write(request);
    await new Promise<void>((done) => socket.once("data", () => done()));
    return socket;
};

const once = (socket: Socket): Promise<string> => new Promise((resolve) => socket.once("data", (chunk: Buffer) => resolve(chunk.toString("utf8"))));

// Reads until `atLeast` bytes arrive or the budget runs out, so a reply split across segments isn't read as short. The
// budget is the suite's, not a tight number: on a loaded runner a slow round trip is not a lost byte.
const collect = (socket: Socket, atLeast: number): Promise<string> =>
    new Promise((resolve) => {
        let seen = "";
        const timer = setTimeout(() => resolve(seen), SETTLES.timeout);
        socket.on("data", (chunk) => {
            seen += chunk.toString("utf8");
            if (seen.length >= atLeast) {
                clearTimeout(timer);
                resolve(seen);
            }
        });
    });
