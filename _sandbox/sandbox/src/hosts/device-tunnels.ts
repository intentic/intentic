import { randomBytes } from "node:crypto";
import { type AddressInfo, createServer, type Server, type Socket } from "node:net";
import { errorMessage } from "@intentic/base/errors";
import { type Pump, pumpTcpWebSocket } from "@intentic/base/ws-tcp-pump";
import { upgradeWebSocket, type WebSocketLike } from "@hono/node-server";
import { DEVICE_FEATURE_PROGRAMS, DEVICE_FEATURE_REACH_NETWORK, deviceSupports } from "@intentic/sandbox-contract/schemas/hosts";
import type { DeviceTunnel } from "@intentic/sandbox-contract/schemas/device-artifacts";
import type { MiddlewareHandler } from "hono";
import type { WSContext } from "hono/ws";
import type { WebSocket } from "ws";
import type { Logger } from "pino";
import { opt } from "../opt.js";
import type { HostHub } from "./host-peer.js";

// A DEVICE'S OWN LOOPBACK PORT, REACHABLE FROM THE SANDBOX (`devices reach`). The reverse of the desktop's port mirror:
// a program running on the owner's computer (a Windows app's local API, a dev server only the PC can run) answers on
// 127.0.0.1 there, and a test in the sandbox needs to talk to it. The sandbox listens on its own 127.0.0.1:<port>; each
// connection it accepts asks the device, over the link it already holds, to dial its loopback port and open a
// WebSocket back here with a one-time ticket; the two sockets are then pumped together by the same byte pump desktop
// sync's ssh transport runs (@intentic/base/ws-tcp-pump). Nothing new is listening on the device, and the device decides
// whether it may (its "Run commands" or "Run programs" switch: either already lets the sandbox reach its loopback).
//
// OR A HOST THAT DEVICE REACHES (2026-11-10, `devices reach <device> <host>:<port>`, a network disk's `via`). The
// sandbox's own packets leave through Docker's NAT and its names resolve on public DNS, so a NAS the PC opens through its
// VPN client, or by a name only its resolvers know, is out of its reach. Named with a host, the device dials that host
// itself, so its routes, VPN and DNS decide. Only an agent advertising `reach-network` is asked: an older one's strict
// input refuses the field.
//
// Held in memory: a daemon restart drops them, and `devices reach` opens one again. A STANDING tunnel (a network disk's,
// reopened at boot before its computer has reconnected) listens while the device is away and refuses each connection
// until it is back, so a kernel mount that reconnects by itself finds its port again.

// How long a ticket waits for the device to dial back: a device that does not in this long is not going to.
const TICKET_MS = 15_000;
// Connections open at once through one tunnel; a test opening more is a test with a leak.
const MAX_STREAMS = 64;

interface Pending {
    readonly socket: Socket;
    readonly tunnel: string;
    readonly timer: NodeJS.Timeout;
}

// What a tunnel dials on the device's side: its own loopback, or a host on its network. `standing` opens it while the
// device is away, its connections refused until the device is back.
export interface TunnelReach {
    readonly host?: string | undefined;
    readonly standing?: boolean | undefined;
}

interface Held {
    readonly tunnel: DeviceTunnel;
    readonly server: Server;
    // Every connection it accepted and has not yet seen close: a server's close() only stops new ones and waits for
    // these, so a close that should end the tunnel ends them itself.
    readonly sockets: Set<Socket>;
    streams: number;
    // What the device last said when it could not dial, cleared by a connection that went through.
    failure?: string | undefined;
}

// Ends a tunnel now: no new connections, and every one already through it cut, which tears down its pump.
const shut = (entry: Held): Promise<void> => {
    const closed = new Promise<void>((done) => entry.server.close(() => done()));
    for (const socket of entry.sockets) {
        socket.destroy();
    }
    entry.sockets.clear();
    return closed;
};

export interface DeviceTunnels {
    // Opens one; a port already listening (another tunnel, or anything in the sandbox) is refused with what holds it.
    // `localPort` 0 takes any free port, which the tunnel then names; left out, it is the device's port.
    readonly open: (device: string, devicePort: number, localPort?: number, reach?: TunnelReach) => Promise<DeviceTunnel>;
    readonly close: (device: string, devicePort: number, host?: string) => Promise<boolean>;
    readonly list: () => DeviceTunnel[];
    // Whether the device is connected within that long: what a standing tunnel's user waits on before using it.
    readonly whenOnline: (device: string, timeoutMs: number) => Promise<boolean>;
    // The sandbox ports these tunnels listen on, which the desktop's port mirror must never carry back to the device.
    readonly ports: () => ReadonlySet<number>;
    // GET /system/hosts/tunnel: where the device dials back with its ticket.
    readonly route: MiddlewareHandler;
    readonly closeAll: () => void;
}

// One tunnel per device, host and port: a host is never mistaken for the device's own loopback.
const keyOf = (device: string, devicePort: number, host?: string): string => JSON.stringify([device, host ?? null, devicePort]);

// Why the device cannot take a tunnel right now, or nothing when it can.
const unreachable = (hub: HostHub, device: string, host: string | undefined): string | undefined => {
    if (hub.client(device) === undefined) {
        return `"${device}" is not connected right now: the computer is asleep, offline, or its agent isn't running`;
    }
    const { facts } = hub.state(device);
    if (!deviceSupports(facts, DEVICE_FEATURE_PROGRAMS)) {
        return `the agent on "${device}" is too old to be reached this way: update it there and try again`;
    }
    if (host !== undefined && !deviceSupports(facts, DEVICE_FEATURE_REACH_NETWORK)) {
        return `the agent on "${device}" is too old to reach a host on its network: update it there and try again`;
    }
    return undefined;
};

// A server on the sandbox's 127.0.0.1:<localPort> (0: any free one), and the port it got; a taken port is said in words.
const listenLocal = async (localPort: number): Promise<{ readonly server: Server; readonly port: number }> => {
    const server = createServer();
    await new Promise<void>((done, fail) => {
        server.once("error", (error: NodeJS.ErrnoException) =>
            fail(
                new Error(
                    error.code === "EADDRINUSE"
                        ? `port ${localPort} is already in use in the sandbox: pass another with --as`
                        : `could not listen on 127.0.0.1:${localPort}: ${error.message}`,
                ),
            ),
        );
        server.listen(localPort, "127.0.0.1", () => done());
    });
    // SAFETY: a server listening on a TCP host and port answers address() with an AddressInfo, never a pipe name or null.
    return { server, port: (server.address() as AddressInfo).port };
};

export const createDeviceTunnels = (deps: { readonly hub: () => HostHub; readonly logger: Logger }): DeviceTunnels => {
    const held = new Map<string, Held>();
    const pending = new Map<string, Pending>();

    const accept = (entry: Held, socket: Socket): void => {
        const { device, devicePort, host } = entry.tunnel;
        if (entry.streams >= MAX_STREAMS) {
            socket.destroy();
            return;
        }
        entry.sockets.add(socket);
        socket.once("close", () => entry.sockets.delete(socket));
        socket.pause();
        const client = deps.hub().client(device);
        // Asked again for each connection: a standing tunnel was opened before the device was back to say what it can.
        const refused = unreachable(deps.hub(), device, host);
        if (client === undefined || refused !== undefined) {
            deps.logger.info({ device, devicePort, host, refused }, "device tunnel: a connection arrived that the device cannot take; refused");
            socket.destroy();
            return;
        }
        const ticket = randomBytes(24).toString("hex");
        const timer = setTimeout(() => {
            pending.delete(ticket);
            socket.destroy();
        }, TICKET_MS);
        timer.unref?.();
        pending.set(ticket, { socket, tunnel: keyOf(device, devicePort, host), timer });
        socket.on("close", () => {
            if (pending.get(ticket)?.socket === socket) {
                clearTimeout(timer);
                pending.delete(ticket);
            }
        });
        client.dialLoopback({ ticket, port: devicePort, ...opt("host", host) }).catch((error: unknown) => {
            deps.logger.info({ device, devicePort, host, err: errorMessage(error) }, "device tunnel: the device did not dial its port");
            entry.failure = errorMessage(error);
            clearTimeout(timer);
            pending.delete(ticket);
            socket.destroy();
        });
    };

    const route: MiddlewareHandler = upgradeWebSocket((c) => {
        const ticket = c.req.header("x-intentic-tunnel") ?? "";
        const claimed = pending.get(ticket);
        if (claimed !== undefined) {
            pending.delete(ticket);
            clearTimeout(claimed.timer);
        }
        let pump: Pump | undefined;
        let entry: Held | undefined;
        const finish = (): void => {
            pump?.stop();
            pump = undefined;
            claimed?.socket.destroy();
            if (entry !== undefined) {
                entry.streams -= 1;
                entry = undefined;
            }
        };
        return {
            onOpen: (_event, ws: WSContext<WebSocketLike>) => {
                if (claimed === undefined || claimed.socket.destroyed) {
                    ws.close(1008, "no such tunnel ticket");
                    return;
                }
                entry = held.get(claimed.tunnel);
                if (entry !== undefined) {
                    entry.streams += 1;
                    entry.failure = undefined;
                }
                const raw = ws.raw as unknown as WebSocket;
                const tcp = claimed.socket;
                pump = pumpTcpWebSocket(
                    tcp,
                    {
                        send: (frame) => ws.send(frame),
                        bufferedAmount: () => raw.bufferedAmount,
                        pause: () => raw.pause(),
                        resume: () => raw.resume(),
                    },
                    { onOverflow: () => ws.close(1011, "tunnel overflowed") },
                );
                tcp.resume();
                tcp.on("close", () => ws.close(1000, "closed"));
                tcp.on("error", () => ws.close(1011, "sandbox side failed"));
            },
            onMessage: (event) => pump?.inbound(event.data),
            onClose: finish,
            onError: finish,
        };
    });

    return {
        open: async (device, devicePort, localPort = devicePort, reach = {}) => {
            const { host, standing = false } = reach;
            const key = keyOf(device, devicePort, host);
            const known = held.get(key);
            if (known !== undefined) {
                return known.tunnel;
            }
            const refused = standing ? undefined : unreachable(deps.hub(), device, host);
            if (refused !== undefined) {
                throw new Error(refused);
            }
            const { server, port } = await listenLocal(localPort);
            const tunnel: DeviceTunnel = { device, ...opt("host", host), devicePort, localPort: port, url: `http://127.0.0.1:${port}`, openedAt: new Date().toISOString() };
            const entry: Held = { tunnel, server, sockets: new Set(), streams: 0 };
            server.on("connection", (socket) => accept(entry, socket));
            held.set(key, entry);
            deps.logger.info({ device, host, devicePort, localPort: port, standing }, "device tunnel opened");
            return tunnel;
        },
        close: async (device, devicePort, host) => {
            const key = keyOf(device, devicePort, host);
            const entry = held.get(key);
            if (entry === undefined) {
                return false;
            }
            held.delete(key);
            await shut(entry);
            return true;
        },
        list: () => [...held.values()].map((entry) => ({ ...entry.tunnel, ...opt("failure", entry.failure) })),
        whenOnline: (device, timeoutMs) => deps.hub().whenOnline(device, timeoutMs),
        ports: () => new Set([...held.values()].map((entry) => entry.tunnel.localPort)),
        route,
        closeAll: () => {
            for (const entry of held.values()) {
                void shut(entry);
            }
            held.clear();
            for (const waiting of pending.values()) {
                clearTimeout(waiting.timer);
                waiting.socket.destroy();
            }
            pending.clear();
        },
    };
};
