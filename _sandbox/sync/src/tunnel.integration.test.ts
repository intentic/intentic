import { connect, createServer, type Server, type Socket } from "node:net";
import { setTimeout as sleep } from "node:timers/promises";
import { afterEach, describe, expect, it, vi } from "vitest";
import { bridgeConnection, createTunnelPool, sshSocketUrl, startSshTunnel, syncSshPort, tunnelReady, tunnelTargets } from "./tunnel.js";

/* THE TRANSPORT DESKTOP SYNC RUNS ON, exercised without a sandbox at the other end.
 *
 * What these cover is the contract Mutagen depends on and nothing about how it is framed: ssh's bytes reach the
 * socket, the sandbox's bytes reach ssh, either side closing closes the other, and the enrolled machine's
 * credential is on the request. The one thing worth stubbing is the WebSocket itself — a real one needs a
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

const target = { sandboxId: "sandbox-0738cd6b5027", sandboxUrl: "https://sandbox-0738cd6b5027.intentic.dev", syncToken: "ist_secret" };

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
    // process, at a different time — they agree only by deriving the same number from the same id.
    it("is stable for one sandbox and different for another", () => {
        expect(syncSshPort("sandbox-0738cd6b5027")).toBe(syncSshPort("sandbox-0738cd6b5027"));
        expect(syncSshPort("sandbox-0738cd6b5027")).not.toBe(syncSshPort("sandbox-bce57bb9fe3b"));
    });

    // Above the range dev servers claim and below Linux's ephemeral floor, so the kernel never hands the same
    // number out from under us — and clear of the band the sandbox's own loopback listener derives.
    it("lands in its own quiet band", () => {
        for (const id of ["sandbox-0738cd6b5027", "sandbox-bce57bb9fe3b", "ffffff", "000000"]) {
            expect(syncSshPort(id)).toBeGreaterThanOrEqual(24000);
            expect(syncSshPort(id)).toBeLessThan(28000);
        }
    });
});

describe("sshSocketUrl", () => {
    it("is the sandbox's own address, ws-scheme, at the transport route", () => {
        expect(sshSocketUrl("https://sandbox-abc.intentic.dev")).toBe("wss://sandbox-abc.intentic.dev/system/sync/ssh");
        expect(sshSocketUrl("https://sandbox-abc.intentic.dev/")).toBe("wss://sandbox-abc.intentic.dev/system/sync/ssh");
        expect(sshSocketUrl("http://127.0.0.1:8787")).toBe("ws://127.0.0.1:8787/system/sync/ssh");
    });
});

describe("tunnelTargets", () => {
    // A listener that accepts ssh and then fails every connection is worse than no listener: ssh reports a
    // transport that died mid-handshake instead of a port that isn't there.
    it("skips a pairing with no credential to present", () => {
        expect(
            tunnelTargets([
                { sandboxId: "a", sandboxUrl: "https://a.dev", syncToken: "tok" },
                { sandboxId: "b", sandboxUrl: "https://b.dev" },
            ]),
        ).toEqual([{ sandboxId: "a", sandboxUrl: "https://a.dev", syncToken: "tok" }]);
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

        // ssh speaks first, before the socket is open — its version banner must be held, not dropped.
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
    // the URL — a query string is the half of a request that gets logged.
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
    // TCP connection — leaving ssh hanging on a socket nothing will answer is what looks like a wedged sync.
    it("closes ssh's connection when the socket fails", async () => {
        vi.stubGlobal("WebSocket", FakeSocket);
        const { ssh, accepted, server } = await socketPair();
        open.push(server, ssh, accepted);
        const ended = new Promise<void>((resolve) => ssh.once("close", () => resolve()));

        bridgeConnection(accepted, target, () => {});
        FakeSocket.last?.fail();

        await expect(ended).resolves.toBeUndefined();
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
});
