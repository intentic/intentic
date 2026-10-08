import { randomBytes } from "node:crypto";
import { createServer, type Server, type Socket } from "node:net";
import { errorMessage } from "@intentic/base/errors";
import { type Pump, pumpTcpWebSocket } from "@intentic/base/ws-tcp-pump";
import { upgradeWebSocket, type WebSocketLike } from "@hono/node-server";
import { DEVICE_FEATURE_PROGRAMS, deviceSupports, type DeviceTunnel } from "@intentic/sandbox-contract";
import type { MiddlewareHandler } from "hono";
import type { WSContext } from "hono/ws";
import type { WebSocket } from "ws";
import type { Logger } from "pino";
import type { HostHub } from "./host-peer.js";

// A DEVICE'S OWN LOOPBACK PORT, REACHABLE FROM THE SANDBOX (`devices reach`). The reverse of the desktop's port mirror:
// a program running on the owner's computer (a Windows app's local API, a dev server only the PC can run) answers on
// 127.0.0.1 there, and a test in the sandbox needs to talk to it. The sandbox listens on its own 127.0.0.1:<port>; each
// connection it accepts asks the device, over the link it already holds, to dial its loopback port and open a
// WebSocket back here with a one-time ticket; the two sockets are then pumped together by the same byte pump desktop
// sync's ssh transport runs (@intentic/base/ws-tcp-pump). Nothing new is listening on the device, and the device decides
// whether it may (its "Run commands" or "Run programs" switch: either already lets the sandbox reach its loopback).
//
// Held in memory: a daemon restart drops them, and `devices reach` opens one again.

// How long a ticket waits for the device to dial back: a device that does not in this long is not going to.
const TICKET_MS = 15_000;
// Connections open at once through one tunnel; a test opening more is a test with a leak.
const MAX_STREAMS = 64;

interface Pending {
    readonly socket: Socket;
    readonly tunnel: string;
    readonly timer: NodeJS.Timeout;
}

interface Held {
    readonly tunnel: DeviceTunnel;
    readonly server: Server;
    streams: number;
}

export interface DeviceTunnels {
    // Opens one; a port already listening (another tunnel, or anything in the sandbox) is refused with what holds it.
    readonly open: (device: string, devicePort: number, localPort?: number) => Promise<DeviceTunnel>;
    readonly close: (device: string, devicePort: number) => Promise<boolean>;
    readonly list: () => DeviceTunnel[];
    // The sandbox ports these tunnels listen on, which the desktop's port mirror must never carry back to the device.
    readonly ports: () => ReadonlySet<number>;
    // GET /system/hosts/tunnel: where the device dials back with its ticket.
    readonly route: MiddlewareHandler;
    readonly closeAll: () => void;
}

const keyOf = (device: string, devicePort: number): string => `${device}:${devicePort}`;

export const createDeviceTunnels = (deps: { readonly hub: () => HostHub; readonly logger: Logger }): DeviceTunnels => {
    const held = new Map<string, Held>();
    const pending = new Map<string, Pending>();

    const accept = (entry: Held, socket: Socket): void => {
        const { device, devicePort } = entry.tunnel;
        if (entry.streams >= MAX_STREAMS) {
            socket.destroy();
            return;
        }
        socket.pause();
        const client = deps.hub().client(device);
        if (client === undefined) {
            deps.logger.info({ device, devicePort }, "device tunnel: a connection arrived while the device is offline; refused");
            socket.destroy();
            return;
        }
        const ticket = randomBytes(24).toString("hex");
        const timer = setTimeout(() => {
            pending.delete(ticket);
            socket.destroy();
        }, TICKET_MS);
        timer.unref?.();
        pending.set(ticket, { socket, tunnel: keyOf(device, devicePort), timer });
        socket.on("close", () => {
            if (pending.get(ticket)?.socket === socket) {
                clearTimeout(timer);
                pending.delete(ticket);
            }
        });
        client.dialLoopback({ ticket, port: devicePort }).catch((error: unknown) => {
            deps.logger.info({ device, devicePort, err: errorMessage(error) }, "device tunnel: the device did not dial its port");
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
        open: async (device, devicePort, localPort = devicePort) => {
            const key = keyOf(device, devicePort);
            const known = held.get(key);
            if (known !== undefined) {
                return known.tunnel;
            }
            if (deps.hub().client(device) === undefined) {
                throw new Error(`"${device}" is not connected right now: the computer is asleep, offline, or its agent isn't running`);
            }
            if (!deviceSupports(deps.hub().state(device).facts, DEVICE_FEATURE_PROGRAMS)) {
                throw new Error(`the agent on "${device}" is too old to be reached this way: update it there and try again`);
            }
            const tunnel: DeviceTunnel = { device, devicePort, localPort, url: `http://127.0.0.1:${localPort}`, openedAt: new Date().toISOString() };
            const entry: Held = { tunnel, server: createServer(), streams: 0 };
            entry.server.on("connection", (socket) => accept(entry, socket));
            await new Promise<void>((done, fail) => {
                entry.server.once("error", (error: NodeJS.ErrnoException) =>
                    fail(
                        new Error(
                            error.code === "EADDRINUSE"
                                ? `port ${localPort} is already in use in the sandbox: pass another with --as`
                                : `could not listen on 127.0.0.1:${localPort}: ${error.message}`,
                        ),
                    ),
                );
                entry.server.listen(localPort, "127.0.0.1", () => done());
            });
            held.set(key, entry);
            deps.logger.info({ device, devicePort, localPort }, "device tunnel opened");
            return tunnel;
        },
        close: async (device, devicePort) => {
            const entry = held.get(keyOf(device, devicePort));
            if (entry === undefined) {
                return false;
            }
            held.delete(keyOf(device, devicePort));
            await new Promise<void>((done) => entry.server.close(() => done()));
            return true;
        },
        list: () => [...held.values()].map((entry) => entry.tunnel),
        ports: () => new Set([...held.values()].map((entry) => entry.tunnel.localPort)),
        route,
        closeAll: () => {
            for (const entry of held.values()) {
                entry.server.close();
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
