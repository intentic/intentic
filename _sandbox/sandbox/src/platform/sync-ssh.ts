import { connect, type Socket } from "node:net";
import { upgradeWebSocket, type WebSocketLike } from "@hono/node-server";
import type { WSContext } from "hono/ws";
import type { WebSocket } from "ws";
import type { Services } from "../composition.js";

// Desktop sync's SSH transport: a WebSocket on this daemon's own HTTPS surface, not a separate tunnel, carrying the
// byte stream to the container's sshd. Guarded by the sync token (a grant, checked before this handler) and by sshd
// itself (public-key only); the socket is fixed to 127.0.0.1:22 and takes no host or port from the caller.

// The container's own sshd, and the only address this route ever connects to.
const SSHD_HOST = "127.0.0.1";
const SSHD_PORT = 22;

// Backpressure on the outbound side, which floods first: pause the TCP read above HIGH, resume below LOW.
const BUFFER_HIGH = 1_048_576;
const BUFFER_LOW = 262_144;
const DRAIN_POLL_MS = 50;

// Ceiling on concurrent SSH streams; 1013 tells a client to retry, which its reconnect already does.
const MAX_STREAMS = 32;
let active = 0;

// Reads a frame as exactly its own bytes: a view's whole backing buffer would feed sshd neighbouring memory. Text
// frames are dropped; this protocol is binary only.
export const bytesOf = (data: unknown): Buffer | undefined => {
    if (Buffer.isBuffer(data)) {
        return data;
    }
    if (data instanceof ArrayBuffer) {
        return Buffer.from(data);
    }
    if (ArrayBuffer.isView(data)) {
        return Buffer.from(data.buffer, data.byteOffset, data.byteLength);
    }
    return undefined;
};

// Copies the chunk, since a Buffer is a slice of a shared pool and `send` is async; passing it through risks it being
// overwritten before it sends.
const frameOf = (chunk: Buffer): Uint8Array<ArrayBuffer> => {
    const frame = new Uint8Array(chunk.byteLength);
    frame.set(chunk);
    return frame;
};

// The sync token rides the x-intentic-sync header (a Node client can set one), so this route skips the query-ticket
// machinery the terminal socket needs for a browser's header-less upgrade.
export const createSyncSshRoute = (services: Services) =>
    upgradeWebSocket(() => {
        let socket: Socket | undefined;
        let drain: NodeJS.Timeout | undefined;
        let counted = false;

        // Idempotent: onClose and onError can both fire, and destroying the socket re-enters this handler.
        const cleanup = (): void => {
            clearInterval(drain);
            drain = undefined;
            if (counted) {
                counted = false;
                active -= 1;
            }
            socket?.destroy();
            socket = undefined;
        };

        return {
            onOpen: (_event, ws: WSContext<WebSocketLike>) => {
                if (active >= MAX_STREAMS) {
                    ws.close(1013, "too many sync streams");
                    return;
                }
                active += 1;
                counted = true;

                // `.raw` is the real `ws` socket; WebSocketLike only types a subset, needed here for bufferedAmount.
                const raw = ws.raw as unknown as WebSocket;
                const tcp = connect(SSHD_PORT, SSHD_HOST);
                socket = tcp;
                tcp.on("data", (chunk: Buffer) => {
                    ws.send(frameOf(chunk));
                    if (drain === undefined && raw.bufferedAmount > BUFFER_HIGH) {
                        tcp.pause();
                        drain = setInterval(() => {
                            if (raw.bufferedAmount < BUFFER_LOW) {
                                clearInterval(drain);
                                drain = undefined;
                                tcp.resume();
                            }
                        }, DRAIN_POLL_MS);
                    }
                });
                // sshd hanging up must close the WebSocket too, or the laptop's ssh hangs on a socket nothing will
                // answer.
                tcp.on("close", () => ws.close(1000, "ssh stream closed"));
                tcp.on("error", (err: unknown) => {
                    services.logger.warn({ err }, "sync ssh stream failed");
                    ws.close(1011, "ssh unavailable");
                });
            },
            onMessage: (event) => {
                const bytes = bytesOf(event.data);
                if (bytes !== undefined) {
                    socket?.write(bytes);
                }
            },
            onClose: cleanup,
            onError: cleanup,
        };
    });
