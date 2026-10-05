import { readFile } from "node:fs/promises";
import { connect, type Socket } from "node:net";
import { join } from "node:path";
import { undefinedIfMissing } from "@intentic/base/errors";
import { upgradeWebSocket, type WebSocketLike } from "@hono/node-server";
import { SshHostKeySchema } from "@intentic/sandbox-contract";
import type { WSContext } from "hono/ws";
import type { WebSocket } from "ws";
import type { Services } from "../composition.js";

// Desktop sync's SSH transport: a WebSocket on this daemon's own HTTPS surface, not a separate tunnel, carrying the
// byte stream to the container's sshd. Guarded by the sync token (a grant, checked before this handler) and by sshd
// itself (public-key only); the socket is fixed to 127.0.0.1:22 and takes no host or port from the caller.

// The container's own sshd, and the only address this route ever connects to.
const SSHD_HOST = "127.0.0.1";
const SSHD_PORT = 22;

// The public half of the sshd host key docker-entrypoint.sh generates once onto the history volume (the sandbox's SSH
// identity, stable across rebuilds), which its HostKey drop-in points sshd at.
export const sshdHostKeyPath = (historyRoot: string): string => join(historyRoot, "ssh-host-keys", "ssh_host_ed25519_key.pub");

// The key that sshd presents, as `<type> <base64>` with the comment dropped, for enrollment to hand to the machine, which
// pins it rather than trusting whichever key answers first. Undefined where there is none (a daemon outside the image)
// or it is not a key line; the machine then records the key it is first shown, as it always did.
export const sshdHostKey = async (historyRoot: string): Promise<string | undefined> => {
    const line = await readFile(sshdHostKeyPath(historyRoot), "utf8").catch(undefinedIfMissing);
    const [type, body] = line?.trim().split(/\s+/) ?? [];
    return type === undefined || body === undefined ? undefined : SshHostKeySchema.safeParse(`${type} ${body}`).data;
};

// Backpressure on the outbound side, which floods first: pause the TCP read above HIGH, resume below LOW.
const BUFFER_HIGH = 1_048_576;
const BUFFER_LOW = 262_144;
const DRAIN_POLL_MS = 50;

// Ceiling on concurrent SSH streams; 1013 tells a client to retry, which its reconnect already does.
const MAX_STREAMS = 32;
let active = 0;

// A STREAM WHOSE FAR END IS GONE IS CLOSED HERE (2026-10-05). A machine that sleeps, loses its network or is killed
// mid-session leaves its WebSocket open on this side, with nothing ever arriving and no close frame coming: half open.
// Each such stream held one of the 32 slots above and an sshd connection for good, until the cap refused every new one
// (1013) and file sync to this sandbox stopped for every machine. Every stream is pinged; one that has answered neither
// that ping nor anything else by the next is dropped, so a dead stream lasts two intervals at most. A live client
// answers pings by itself (every WebSocket implementation pongs, the machine agent's included), so an idle Mutagen
// session that is merely quiet is never dropped. Kept on this route rather than in sshd's `ClientAliveInterval`, which
// would also need the image changed and would see the stream only through the socket this route holds open.
export const STREAM_PING_MS = 30_000;

// Whether a stream is dead at its next ping: it has been pinged, and nothing (a frame or a pong) came after that ping.
export const streamSilent = (heardAt: number, lastPingAt: number | undefined): boolean => lastPingAt !== undefined && heardAt < lastPingAt;

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
export const createSyncSshRoute = (services: Pick<Services, "logger">) =>
    upgradeWebSocket(() => {
        let socket: Socket | undefined;
        let drain: NodeJS.Timeout | undefined;
        let pinger: NodeJS.Timeout | undefined;
        let counted = false;
        // When the far end last said anything (a frame or a pong), and when it was last pinged.
        let heardAt = Date.now();
        let pingedAt: number | undefined;

        // Idempotent: onClose and onError can both fire, and destroying the socket re-enters this handler.
        const cleanup = (): void => {
            clearInterval(pinger);
            pinger = undefined;
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
                raw.on("pong", () => {
                    heardAt = Date.now();
                });
                pinger = setInterval(() => {
                    if (streamSilent(heardAt, pingedAt)) {
                        services.logger.info("sync ssh stream: its far end answered nothing since the last ping; closing it");
                        // Not a close handshake: an end that is gone would never answer one.
                        raw.terminate();
                        cleanup();
                        return;
                    }
                    pingedAt = Date.now();
                    raw.ping();
                }, STREAM_PING_MS);
                pinger.unref?.();
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
                heardAt = Date.now();
                const bytes = bytesOf(event.data);
                if (bytes !== undefined) {
                    socket?.write(bytes);
                }
            },
            onClose: cleanup,
            onError: cleanup,
        };
    });
