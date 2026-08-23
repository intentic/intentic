import { createServer, type Server } from "node:net";
import { afterEach, expect, test } from "vitest";
import { startSocks, socksConnect, type SocksHandle } from "./exit-socks.js";

/* The proxy is the seam every consumer of an exit talks to, so it is exercised as a real SOCKS5 server over
 * loopback rather than unit-tested in pieces: a handshake that parses in theory and hangs in practice is worth
 * nothing, and the bugs this catches (a fragmented greeting, a client that writes before the reply lands) only
 * exist on a socket.
 *
 * `localAddress` is 127.0.0.1 here rather than a tunnel address, which is the one thing that cannot be
 * exercised without a live tunnel. Everything else — framing, hostname handling, the early-write replay, the
 * refusal paths and teardown — is the same code that runs behind a real exit.
 */

const opened: (SocksHandle | Server)[] = [];

afterEach(async () => {
    for (const handle of opened.splice(0)) {
        await ("close" in handle && handle.close.length === 0
            ? (handle as SocksHandle).close()
            : new Promise<void>((done) => (handle as Server).close(() => done())));
    }
});

// An echo server that also reports what it received first, so a test can prove the client's early bytes
// survived the handshake instead of being dropped.
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
        // No resolver is reachable in a test, so a hostname target must fail rather than hang; the IP paths
        // below are what a real caller uses most.
        resolver: { servers: [], localAddress: "127.0.0.1" },
    });
    opened.push(handle);
    return handle;
};

/* A fixed port per test, so two tests in this file never fight for one listener — and BELOW the ephemeral
 * range, which is the half that was wrong. These used to start at 38400, inside `ip_local_port_range`
 * (32768–60999 on Linux), so the kernel was free to hand the very same number to any outbound socket on the
 * machine: the exit then failed to bind with "local port N is already taken", which is a true statement about
 * a port this test had no claim to. It only bites under load, so it passed run after run beside its own file
 * and failed inside `pnpm verify`, where 40-odd suites are making connections at once — a gate that reports
 * the machine's traffic rather than the code. The kernel never auto-assigns below the range's low bound, so
 * these are ports nothing takes unless a service is deliberately bound to one. */
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
    /* The bug this pins: the handshake reader buffers whatever arrives, and a client that writes its request
     * in the same breath as the SOCKS reply lands those bytes in that buffer rather than on the wire. Dropping
     * them does not error, it hangs the request until something times out, which is the worst possible shape
     * for a failure. */
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
    // Request and payload in ONE write: the payload rides in behind the request, before the reply exists.
    socket.write(Buffer.concat([request, Buffer.from("early")]));
    const seen = await collect(socket, 15);
    expect(seen.includes("early")).toBe(true);
    socket.destroy();
});

test("a fragmented greeting still completes", async () => {
    // TCP may split anywhere, and every SOCKS field is length-prefixed by something read earlier, so a reader
    // that assumes one chunk per field works locally and fails against a real client.
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
    // The derived-port collision exit-paths.ts warns about. "EADDRINUSE" tells a user nothing; the fix is to
    // rename the exit, because the port is a function of the name.
    const port = freePort();
    await proxy(port);
    await expect(proxy(port)).rejects.toThrow(/Rename the exit/);
});

test("closing the proxy cuts connections still riding it", async () => {
    // An exit going down takes its tunnel with it. A socket left piping into a tunnel that no longer exists
    // hangs instead of failing, so close has to be a cut, not just "stop accepting".
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
    // socksConnect is what the observation goes through on a tor exit; pointing it at our own server proves
    // the two halves agree, which is the only place both are written by hand.
    const target = await echoServer();
    const port = freePort();
    await proxy(port);
    // Our server resolves hostnames itself and has no resolver in this test, so the failure has to be the
    // resolver's, reported cleanly rather than as a hang.
    await expect(socksConnect(port, "example.invalid", target.port)).rejects.toThrow(/refused|resolve/i);
});

// --- helpers -------------------------------------------------------------------------------------------

// A minimal SOCKS5 client that targets an IPv4 literal, so the tests above do not depend on the resolver.
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

// Read until `atLeast` bytes have arrived or the socket goes quiet, so a reply split across segments is not
// mistaken for a short one.
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
