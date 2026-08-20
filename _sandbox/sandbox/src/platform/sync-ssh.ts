import { connect, type Socket } from "node:net";
import { upgradeWebSocket, type WebSocketLike } from "@hono/node-server";
import type { WSContext } from "hono/ws";
import type { WebSocket } from "ws";
import type { Services } from "../composition.js";

/* DESKTOP SYNC'S TRANSPORT, the sandbox's own sshd, carried over this daemon's HTTPS surface.
 *
 * Mutagen syncs over SSH, so the laptop needs a byte pipe to `sshd` in this container. It used to get one from
 * the reachability fabric itself: a Cloudflare tunnel routes arbitrary TCP, so `ssh-<id>.<zone>` was a real
 * hostname the laptop dialled through `cloudflared access ssh`. The fabric moved to a hub that shares HTTP and
 * nothing else, and desktop sync went with it, every enrollment answered 409, "this sandbox has no SSH tunnel
 * for desktop sync to ride", on the ONE path the setup wizard offers by default.
 *
 * The fix is to stop asking the fabric for a second kind of route. Every sandbox already has exactly one way in
 * that is known to work, because it is the way the workspace itself is served: this daemon, over HTTPS, at the
 * sandbox's public URL. A WebSocket on it carries the SSH stream, and the transport stops being a property of
 * how the sandbox happens to be reachable:
 *
 *   Mutagen ─ssh→ 127.0.0.1:<port> on the laptop ─wss→ /system/sync/ssh ─tcp→ 127.0.0.1:22 in here
 *
 * So a sandbox on the platform's hub, one behind its owner's own domain, and one reached at a plain loopback
 * address all sync the same way, through the same code, with nothing to provision. The laptop needs no tunnel
 * client of its own and no account on anybody's fabric, which is also why it is per-computer and revocable for
 * free: the credential on this socket is the enrolled machine's sync token, and revoking that enrollment
 * (uninstall, or the owner's "Disable desktop sync") closes the door on that machine alone.
 *
 * WHAT GUARDS IT. Two independent things, and the outer one is not this file's: the sync token is a grant
 * (auth/grants.ts) minted per enrolled machine, so an unauthenticated socket never reaches this handler. Behind
 * it, sshd is unchanged, public-key only, against the key that same enrollment installed, so a leaked token
 * still gets nothing but a connection refused by the SSH layer. The socket is deliberately fixed to the local
 * sshd: it takes no host and no port from the caller, so it can never be pointed at anything else.
 */

// The container's own sshd, and the only address this route will ever connect to.
const SSHD_HOST = "127.0.0.1";
const SSHD_PORT = 22;

/* Backpressure, in the direction that can actually flood. A file sync pushes far more at the laptop than the
 * laptop pushes back, so a slow uplink lets the outbound socket buffer grow without limit unless the reading
 * side stops. Past HIGH the TCP stream is paused (sshd's own writes then block in the kernel, which is exactly
 * the signal we want to propagate); it resumes under LOW. Matches the terminal socket's shape beside it. */
const BUFFER_HIGH = 1_048_576;
const BUFFER_LOW = 262_144;
const DRAIN_POLL_MS = 50;

// Concurrent SSH streams. Mutagen holds one per session plus short-lived ones for the git bridge, so this is a
// ceiling on a handful of machines' worth of normal use rather than a quota anyone should meet. 1013 tells a
// client to come back later, which its own reconnect already does.
const MAX_STREAMS = 32;
let active = 0;

/* What arrives on a binary frame, as bytes sshd can take. `ws` hands over a Buffer for binary messages; a
 * browser-shaped client would send an ArrayBuffer, and a fragmented message can arrive as a view over a larger
 * buffer. Each shape has to be read as EXACTLY its own bytes: taking a view's whole backing buffer would feed
 * sshd neighbouring memory, which on an encrypted stream is not a visible glitch but a handshake that fails for
 * no stated reason. A text frame is not part of this protocol and is dropped rather than guessed at. */
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

/* One TCP read, as a frame the socket can own. A Buffer is a slice of a shared pool and `send` is asynchronous,
 * so handing over the pool's memory lets the next read overwrite bytes that have not gone out yet, on an SSH
 * stream that is not a glitch, it is a corrupted transport with no error to point at. */
const frameOf = (chunk: Buffer): Uint8Array<ArrayBuffer> => {
    const frame = new Uint8Array(chunk.byteLength);
    frame.set(chunk);
    return frame;
};

/* The /system/sync/ssh route. The sync token rides the `x-intentic-sync` header, this is a Node client, not a
 * browser, so it can set one, and that is why this route needs none of the query-string ticket machinery the
 * terminal socket carries for the browser's header-less upgrade. */
export const createSyncSshRoute = (services: Services) =>
    upgradeWebSocket(() => {
        let socket: Socket | undefined;
        let drain: NodeJS.Timeout | undefined;
        let counted = false;

        // Idempotent: onClose and onError can both fire, and destroying the socket re-enters through its own
        // "close" handler.
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

                // node-server hands the real `ws` socket on .raw; WebSocketLike types only a subset of it
                // (main.ts makes the mirror assertion for the server). Needed for bufferedAmount, as in the
                // terminal socket beside this one.
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
                // sshd hung up (a normal disconnect, or a refused connection): the laptop's ssh must see its
                // transport end rather than hang on a socket nothing will ever answer.
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
