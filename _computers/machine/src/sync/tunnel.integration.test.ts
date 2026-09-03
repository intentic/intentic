import { connect, createServer, type Server, type Socket } from "node:net";
import { setTimeout as sleep } from "node:timers/promises";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Dialed } from "../daemon-base.js";
import type { Pairing } from "./config.js";
import { bridgeConnection, createTunnelPool, sshSocketUrl, startSshTunnel, syncSshPort, tunnelReady, tunnelTargets } from "./tunnel.js";

/* THE TRANSPORT DESKTOP SYNC RUNS ON, exercised without a sandbox at the other end.
 *
 * What these cover is the contract Mutagen depends on and nothing about how it is framed: ssh's bytes reach the
 * socket, the sandbox's bytes reach ssh, either side closing closes the other, and the enrolled machine's
 * credential is on the request. The one thing worth stubbing is the WebSocket itself: a real one needs a
 * server, and what is being tested here is this side of it.
 */

// A stand-in for the sandbox end: records what was sent, and lets a test push bytes back or close.
class FakeSocket {
    static readonly CONNECTING = 0;
    static readonly OPEN = 1;
    static readonly CLOSED = 3;
    static last: FakeSocket | undefined;

    readyState = FakeSocket.CONNECTING;
    binaryType = "blob";
    bufferedAmount = 0;
    readonly sent: Uint8Array[] = [];
    readonly closes: number[] = [];
    private readonly listeners = new Map<string, ((event: { data?: unknown }) => void)[]>();

    constructor(
        readonly url: string,
        readonly options: { headers?: Record<string, string> } | undefined,
    ) {
        FakeSocket.last = this;
    }

    addEventListener(type: string, handler: (event: { data?: unknown }) => void): void {
        this.listeners.set(type, [...(this.listeners.get(type) ?? []), handler]);
    }
    private emit(type: string, event: { data?: unknown } = {}): void {
        for (const handler of this.listeners.get(type) ?? []) {
            handler(event);
        }
    }
    send(data: Uint8Array): void {
        this.sent.push(data);
    }
    close(): void {
        this.closes.push(1);
        this.readyState = FakeSocket.CLOSED;
        this.emit("close");
    }
    // Test-side helpers.
    open(): void {
        this.readyState = FakeSocket.OPEN;
        this.emit("open");
    }
    fail(): void {
        this.emit("error");
    }
    deliver(bytes: Uint8Array): void {
        this.emit("message", { data: bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) });
    }
    get sentText(): string {
        return Buffer.concat(this.sent.map((chunk) => Buffer.from(chunk))).toString();
    }
}

// `base` rather than a public URL: the transport dials whatever this pass resolved for the pairing
// (daemon-base.ts), which is the sandbox's public address or, when its daemon proved to be on this machine, the
// loopback shortcut.
const target = { sandboxId: "sandbox-0738cd6b5027", base: "https://sandbox-0738cd6b5027.intentic.dev", syncToken: "ist_secret" };

// A local pair of connected TCP sockets: one end stands in for ssh, the other is what the bridge is handed.
const socketPair = async (): Promise<{ ssh: Socket; accepted: Socket; server: Server }> => {
    const server = createServer();
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const port = (server.address() as { port: number }).port;
    const [accepted, ssh] = await Promise.all([
        new Promise<Socket>((resolve) => server.once("connection", resolve)),
        new Promise<Socket>((resolve) => {
            const client = connect(port, "127.0.0.1", () => resolve(client));
        }),
    ]);
    return { ssh, accepted, server };
};

// Sockets are destroyed, servers are closed; both kinds get parked here so a failing assertion still releases
// the ports the next test derives from the same ids.
const open: (Socket | Server)[] = [];
afterEach(() => {
    for (const item of open.splice(0)) {
        if ("destroy" in item && typeof item.destroy === "function" && !("listen" in item)) {
            item.destroy();
        } else {
            (item as Server).close();
        }
    }
    vi.unstubAllGlobals();
});

describe("syncSshPort", () => {
    // Stable, because the ssh config written at setup names the port and the watcher binds it in a different
    // process, at a different time: they agree only by deriving the same number from the same id.
    it("is stable for one sandbox and different for another", () => {
        expect(syncSshPort("sandbox-0738cd6b5027")).toBe(syncSshPort("sandbox-0738cd6b5027"));
        expect(syncSshPort("sandbox-0738cd6b5027")).not.toBe(syncSshPort("sandbox-bce57bb9fe3b"));
    });

    // Above the range dev servers claim and below Linux's ephemeral floor, so the kernel never hands the same
    // number out from under us, and clear of the band the sandbox's own loopback listener derives.
    it("lands in its own quiet band", () => {
        for (const id of ["sandbox-0738cd6b5027", "sandbox-bce57bb9fe3b", "ffffff", "000000"]) {
            expect(syncSshPort(id)).toBeGreaterThanOrEqual(24000);
            expect(syncSshPort(id)).toBeLessThan(28000);
        }
    });
});

describe("sshSocketUrl", () => {
    /* BOTH SCHEMES, because the base is no longer always a public https address: the loopback shortcut is plain
     * http (a same-machine hop, and the daemon's loopback listener speaks HTTP/1.1 there), and a stream sent to
     * `wss://127.0.0.1:29293` would fail a TLS handshake against a server that never offered one. The flip is
     * one prefix swap that has to get both right, so both are pinned by value. */
    it("is the resolved base, ws-scheme, at the transport route", () => {
        expect(sshSocketUrl("https://sandbox-abc.intentic.dev")).toBe("wss://sandbox-abc.intentic.dev/system/sync/ssh");
        expect(sshSocketUrl("https://sandbox-abc.intentic.dev/")).toBe("wss://sandbox-abc.intentic.dev/system/sync/ssh");
        expect(sshSocketUrl("http://127.0.0.1:8787")).toBe("ws://127.0.0.1:8787/system/sync/ssh");
        expect(sshSocketUrl("http://127.0.0.1:8787/")).toBe("ws://127.0.0.1:8787/system/sync/ssh");
    });
});

describe("tunnelTargets", () => {
    // The key is OMITTED rather than set to undefined for a pairing with no credential: `syncToken` is an
    // optional property, so spelling it `undefined` is a different type from not having it, and the pairing this
    // suite is about is the one that genuinely lacks one.
    const dialed = (sandboxId: string, base: string, syncToken?: string): Dialed<Pairing> => ({
        pairing: { sandboxId, sandboxUrl: base, mode: "sync", ...(syncToken === undefined ? {} : { syncToken }) },
        base,
    });

    // A listener that accepts ssh and then fails every connection is worse than no listener: ssh reports a
    // transport that died mid-handshake instead of a port that isn't there.
    it("skips a pairing with no credential to present", () => {
        expect(tunnelTargets([dialed("a", "https://a.dev", "tok"), dialed("b", "https://b.dev")])).toEqual([
            { sandboxId: "a", base: "https://a.dev", syncToken: "tok" },
        ]);
    });

    // The target carries the RESOLVED base, not the pairing's public address: that is the whole of how the
    // shortcut reaches the stream Mutagen pushes a workspace through.
    it("carries the base this pass resolved rather than the pairing's public address", () => {
        const pairing = { sandboxId: "a", sandboxUrl: "https://a.dev", mode: "sync" as const, syncToken: "tok" };
        expect(tunnelTargets([{ pairing, base: "http://127.0.0.1:29293" }])).toEqual([
            { sandboxId: "a", base: "http://127.0.0.1:29293", syncToken: "tok" },
        ]);
    });
});

describe("bridgeConnection", () => {
    it("carries ssh's bytes to the sandbox and the sandbox's bytes back to ssh", async () => {
        vi.stubGlobal("WebSocket", FakeSocket);
        const { ssh, accepted, server } = await socketPair();
        open.push(server, ssh, accepted);

        bridgeConnection(accepted, target, () => {});
        const ws = FakeSocket.last;
        if (ws === undefined) {
            throw new Error("the bridge opened no socket");
        }

        // ssh speaks first, before the socket is open: its version banner must be held, not dropped.
        ssh.write("SSH-2.0-OpenSSH_9.6\r\n");
        await sleep(50);
        expect(ws.sent).toHaveLength(0);

        ws.open();
        await sleep(50);
        expect(ws.sentText).toBe("SSH-2.0-OpenSSH_9.6\r\n");

        // …and once open, straight through.
        ssh.write("more");
        await sleep(50);
        expect(ws.sentText).toBe("SSH-2.0-OpenSSH_9.6\r\nmore");

        // The sandbox's direction.
        const back = new Promise<string>((resolve) => ssh.once("data", (chunk: Buffer) => resolve(chunk.toString())));
        ws.deliver(new Uint8Array(Buffer.from("SSH-2.0-sandbox\r\n")));
        expect(await back).toBe("SSH-2.0-sandbox\r\n");
    });

    // The credential is the whole of what authorizes this stream, and it belongs on the request rather than in
    // the URL: a query string is the half of a request that gets logged.
    it("presents the enrolled machine's sync token as a header", () => {
        vi.stubGlobal("WebSocket", FakeSocket);
        const socket = connect({ port: 1, host: "127.0.0.1" });
        socket.on("error", () => {});
        open.push(socket);

        bridgeConnection(socket, target, () => {});

        expect(FakeSocket.last?.url).toBe("wss://sandbox-0738cd6b5027.intentic.dev/system/sync/ssh");
        expect(FakeSocket.last?.options?.headers).toEqual({ "x-intentic-sync": "ist_secret" });
    });

    // Mutagen treats a dropped transport as a reconnect, so the honest thing on a failed socket is to end the
    // TCP connection: leaving ssh hanging on a socket nothing will answer is what looks like a wedged sync.
    it("closes ssh's connection when the socket fails", async () => {
        vi.stubGlobal("WebSocket", FakeSocket);
        const { ssh, accepted, server } = await socketPair();
        open.push(server, ssh, accepted);
        const ended = new Promise<void>((resolve) => ssh.once("close", () => resolve()));

        bridgeConnection(accepted, target, () => {});
        FakeSocket.last?.fail();

        await expect(ended).resolves.toBeUndefined();
    });

    /* THE FAILURE SSH CANNOT SEE. The listener is local, so the TCP connect always succeeds and a sandbox that is
     * asleep, 502-ing or retired shows up only as a WebSocket that never opens, and never errors either. ssh
     * then sits in banner exchange, and everything waiting on ssh sits with it: the git bridge's own cap is two
     * MINUTES, which one unreachable pairing was adding to every watcher pass, serially, ahead of every healthy
     * pairing's ports and commits. Ending the connection here is what turns that back into seconds. */
    it("ends a connection whose socket never opens, instead of holding ssh in the handshake", async () => {
        vi.useFakeTimers();
        vi.stubGlobal("WebSocket", FakeSocket);
        const { ssh, accepted, server } = await socketPair();
        open.push(server, ssh, accepted);
        const ended = new Promise<void>((resolve) => ssh.once("close", () => resolve()));
        const said: string[] = [];

        // Neither open nor failed: exactly what a sandbox behind a hung tunnel looks like from this end.
        bridgeConnection(accepted, target, (message) => said.push(message));
        await vi.advanceTimersByTimeAsync(10_000);
        vi.useRealTimers();

        await expect(ended).resolves.toBeUndefined();
        expect(said[0]).toContain("did not open within 10s");
    });
});

describe("startSshTunnel and the pool", () => {
    it("binds this pairing's derived port, and stops listening when told", async () => {
        vi.stubGlobal("WebSocket", FakeSocket);
        const stop = await startSshTunnel(target, () => {});
        if (stop === undefined) {
            throw new Error("the transport did not bind");
        }
        expect(await tunnelReady(syncSshPort(target.sandboxId), 2000)).toBe(true);

        await stop();
        expect(await tunnelReady(syncSshPort(target.sandboxId), 200)).toBe(false);
    });

    /* A port somebody else holds must cost that ONE pairing its transport, not the machine's whole watcher: a
     * fleet syncs several sandboxes, and the loop that binds them runs in a single process. */
    it("reports a port it cannot have instead of throwing", async () => {
        const blocker = createServer();
        await new Promise<void>((resolve) => blocker.listen(syncSshPort(target.sandboxId), "127.0.0.1", resolve));
        open.push(blocker);
        const said: string[] = [];

        const stop = await startSshTunnel(target, (message) => said.push(message));

        expect(stop).toBeUndefined();
        expect(said.join("\n")).toMatch(/already taken/);
    });

    // How a `setup` in another terminal gets served, and how an `uninstall` stops being served, without this
    // process being restarted.
    it("starts a transport for a new pairing and drops one that went away", async () => {
        vi.stubGlobal("WebSocket", FakeSocket);
        const pool = createTunnelPool(() => {});

        await pool.reconcile([target]);
        expect(await tunnelReady(syncSshPort(target.sandboxId), 2000)).toBe(true);

        await pool.reconcile([]);
        expect(await tunnelReady(syncSshPort(target.sandboxId), 200)).toBe(false);

        await pool.stopAll();
    });

    /* A BASE THAT MOVED IS A REBIND, and without it the resolution would be decided once and then ignored for
     * the life of the login: the listener closes over the address it dials, so a pairing promoted onto loopback
     * would keep opening streams to the public URL from a listener bound before the promotion. Read off where
     * the next connection actually goes, which is the only thing that proves the new target took. */
    it("rebinds a pairing whose resolved base moved, so later streams use the new address", async () => {
        vi.stubGlobal("WebSocket", FakeSocket);
        const pool = createTunnelPool(() => {});
        const port = syncSshPort(target.sandboxId);

        await pool.reconcile([target]);
        const first = connect(port, "127.0.0.1");
        open.push(first);
        await new Promise<void>((resolve) => first.once("connect", () => resolve()));
        await sleep(50);
        expect(FakeSocket.last?.url).toBe("wss://sandbox-0738cd6b5027.intentic.dev/system/sync/ssh");

        // The same pairing, now resolved to the loopback shortcut.
        await pool.reconcile([{ ...target, base: "http://127.0.0.1:29293" }]);
        // Still serving on the same local port: the port is derived from the sandbox id and does not move with
        // the base, which is what keeps the ssh config written at setup valid across a promotion.
        expect(await tunnelReady(port, 2000)).toBe(true);
        const second = connect(port, "127.0.0.1");
        open.push(second);
        await new Promise<void>((resolve) => second.once("connect", () => resolve()));
        await sleep(50);
        expect(FakeSocket.last?.url).toBe("ws://127.0.0.1:29293/system/sync/ssh");

        // An unchanged base is NOT a rebind: it would drop every live ssh connection on every watcher tick.
        const before = FakeSocket.last;
        await pool.reconcile([{ ...target, base: "http://127.0.0.1:29293" }]);
        const third = connect(port, "127.0.0.1");
        open.push(third);
        await new Promise<void>((resolve) => third.once("connect", () => resolve()));
        await sleep(50);
        expect(FakeSocket.last).not.toBe(before); // the new connection got its own socket…
        expect(FakeSocket.last?.url).toBe("ws://127.0.0.1:29293/system/sync/ssh"); // …to the same place

        await pool.stopAll();
    });
});
