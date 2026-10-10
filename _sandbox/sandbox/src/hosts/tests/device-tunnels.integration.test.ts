import { once } from "node:events";
import { type AddressInfo, connect, createServer, type Server, type Socket } from "node:net";
import { createAdaptorServer, type WebSocketServerLike } from "@hono/node-server";
import type { DialLoopback } from "@intentic/sandbox-contract";
import { Hono } from "hono";
import type { Logger } from "pino";
import { WebSocket, WebSocketServer } from "ws";
import type { HostHub } from "../host-peer.js";
import { createDeviceTunnels, type DeviceTunnels } from "../device-tunnels.js";

/* A `devices reach` tunnel over real sockets: a program in the sandbox connects to the tunnel's port, the daemon asks the
   (fake) device to dial back, the device connects its own "local" server and opens the WebSocket with its ticket, and
   bytes flow both ways. The device here does what the machine's tunnel.ts does, with the `ws` client. */

const logger = { info: () => {}, warn: () => {}, error: () => {} } as unknown as Logger;

const listen = async (server: Server): Promise<number> => {
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    return (server.address() as AddressInfo).port;
};

// The device's own program: an echo server that answers each line upper-cased.
const deviceProgram = createServer((socket) => socket.on("data", (chunk) => socket.write(chunk.toString().toUpperCase())));
let deviceProgramPort = 0;

interface Stood {
    readonly tunnels: DeviceTunnels;
    readonly dialled: DialLoopback[];
    readonly daemonPort: number;
    readonly close: () => Promise<void>;
}

// A port nothing listens on: bound once to find it, then let go.
const freePort = async (): Promise<number> => {
    const probe = createServer();
    const port = await listen(probe);
    await new Promise<void>((done) => probe.close(() => done()));
    return port;
};

const stand = async (device: { online?: boolean; features?: string[]; refuse?: string } = {}): Promise<Stood> => {
    const dialled: DialLoopback[] = [];
    let daemonPort = 0;
    const client = {
        // What the machine does: dial its own port, then the daemon's tunnel route with the ticket, and pump.
        dialLoopback: async (input: DialLoopback): Promise<{ ok: true }> => {
            dialled.push(input);
            if (device.refuse !== undefined) {
                throw new Error(device.refuse);
            }
            const local: Socket = connect(input.port, "127.0.0.1");
            await once(local, "connect");
            const ws = new WebSocket(`ws://127.0.0.1:${daemonPort}/system/hosts/tunnel`, { headers: { "x-intentic-tunnel": input.ticket } });
            await once(ws, "open");
            local.on("data", (chunk) => ws.send(chunk));
            ws.on("message", (data) => local.write(data as Buffer));
            local.on("close", () => ws.close());
            ws.on("close", () => local.destroy());
            return { ok: true };
        },
    };
    const hub = {
        client: (id: string) => (id === "pc" && device.online !== false ? client : undefined),
        state: () => ({ online: device.online !== false, facts: { features: device.features ?? ["programs"] } }),
    } as unknown as HostHub;
    const tunnels = createDeviceTunnels({ hub: () => hub, logger });
    const app = new Hono();
    app.get("/system/hosts/tunnel", tunnels.route);
    const sockets = new WebSocketServer({ noServer: true }) as unknown as WebSocketServerLike;
    const server = createAdaptorServer({ fetch: app.fetch, websocket: { server: sockets } });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    daemonPort = (server.address() as AddressInfo).port;
    return {
        tunnels,
        dialled,
        daemonPort,
        close: async () => {
            tunnels.closeAll();
            (sockets as unknown as WebSocketServer).close();
            await new Promise<void>((done) => server.close(() => done()));
        },
    };
};

// One exchange through the sandbox end of a tunnel.
const ask = async (port: number, text: string): Promise<string> => {
    const socket = connect(port, "127.0.0.1");
    await once(socket, "connect");
    socket.write(text);
    const [answer] = (await once(socket, "data")) as [Buffer];
    socket.destroy();
    return answer.toString();
};

beforeAll(async () => {
    deviceProgramPort = await listen(deviceProgram);
});
afterAll(() => {
    deviceProgram.close();
});

test("a connection to the sandbox end reaches the device's own port, both ways, through a one-time ticket", async () => {
    const stood = await stand();
    try {
        const free = await freePort();
        const tunnel = await stood.tunnels.open("pc", deviceProgramPort, free);
        expect(tunnel).toMatchObject({ device: "pc", devicePort: deviceProgramPort, localPort: free, url: `http://127.0.0.1:${free}` });
        expect(await ask(free, "hello from the sandbox")).toBe("HELLO FROM THE SANDBOX");
        expect(await ask(free, "again")).toBe("AGAIN");
        // Each connection had its own ticket, and it named the device's port.
        expect(stood.dialled.map((call) => call.port)).toEqual([deviceProgramPort, deviceProgramPort]);
        expect(new Set(stood.dialled.map((call) => call.ticket)).size).toBe(2);
        expect(stood.tunnels.ports().has(free)).toBe(true);
        expect(await stood.tunnels.close("pc", deviceProgramPort)).toBe(true);
        expect(stood.tunnels.list()).toEqual([]);
    } finally {
        await stood.close();
    }
});

test("a WebSocket with no ticket, or one already spent, is turned away", async () => {
    const stood = await stand();
    try {
        const free = await freePort();
        await stood.tunnels.open("pc", deviceProgramPort, free);
        expect(await ask(free, "x")).toBe("X");
        for (const ticket of ["", "0".repeat(48), stood.dialled[0]?.ticket ?? ""]) {
            const ws = new WebSocket(`ws://127.0.0.1:${stood.daemonPort}/system/hosts/tunnel`, { headers: { "x-intentic-tunnel": ticket } });
            const [code] = (await once(ws, "close")) as [number];
            expect(code).toBe(1008);
        }
    } finally {
        await stood.close();
    }
});

test("an offline device, one too old, and a busy sandbox port are refused before anything listens", async () => {
    const offline = await stand({ online: false });
    await expect(offline.tunnels.open("pc", deviceProgramPort, 0)).rejects.toThrow("not connected");
    await offline.close();
    const old = await stand({ features: [] });
    await expect(old.tunnels.open("pc", deviceProgramPort, 0)).rejects.toThrow("too old");
    await old.close();
    const busy = createServer();
    const taken = await listen(busy);
    const stood = await stand();
    await expect(stood.tunnels.open("pc", deviceProgramPort, taken)).rejects.toThrow(`port ${taken} is already in use`);
    await stood.close();
    busy.close();
});

test("a device that refuses to dial costs that one connection, which is closed", async () => {
    const stood = await stand({ refuse: "Run commands is off" });
    try {
        const free = await freePort();
        await stood.tunnels.open("pc", 1, free);
        const socket = connect(free, "127.0.0.1");
        await once(socket, "connect");
        await once(socket, "close");
        expect(stood.dialled).toHaveLength(1);
    } finally {
        await stood.close();
    }
});

test("closing a tunnel with a connection still open returns at once and cuts that connection, rather than waiting on it", async () => {
    const stood = await stand();
    try {
        const free = await freePort();
        await stood.tunnels.open("pc", deviceProgramPort, free);
        // A connection left open, the way a test's keep-alive client or a held stream is.
        const socket = connect(free, "127.0.0.1");
        await once(socket, "connect");
        socket.write("still here");
        await once(socket, "data");
        const cut = once(socket, "close");
        const closing = stood.tunnels.close("pc", deviceProgramPort);
        const closed = await Promise.race([closing, new Promise<"still waiting">((done) => setTimeout(() => done("still waiting"), 2_000))]);
        expect(closed).toBe(true);
        await cut;
        expect(stood.tunnels.list()).toEqual([]);
    } finally {
        await stood.close();
    }
});
