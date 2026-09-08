import { connect, createServer, type Server, type Socket } from "node:net";
import { pollUntil } from "@intentic/base/async";
import type { Log } from "@intentic/local-agent";
import type { Dialed } from "../daemon-base.js";
import type { Pairing } from "./config.js";

// A loopback port on this machine that is the sandbox's sshd: Mutagen speaks only SSH, so something must front it
// with TCP. One socket per SSH connection, opened on demand, closed with it; a failed socket just fails the TCP
// connection since Mutagen retries on its own.
// ssh ─→ 127.0.0.1:<port> [here] ─wss→ <sandbox>/system/sync/ssh ─→ 127.0.0.1:22 [in the sandbox]

// Loopback port for a sandbox's SSH endpoint, derived from its id: stable, and clear of the sandbox daemon's own
// loopback band (28000-31999 in @intentic/sandbox-run) derived from the same digest. Below Linux's ephemeral floor.
const SSH_PORT_BASE = 24000;
const SSH_PORT_SPAN = 4000;

export const syncSshPort = (sandboxId: string): number => {
    // The id may be 12 hex or a sanitized alias; digits are taken from wherever they are, not a fixed offset, since
    // only a stable one-id-to-one-port mapping matters.
    const hex = (/[0-9a-f]{6}/i.exec(sandboxId)?.[0] ?? "000000").toLowerCase();
    return SSH_PORT_BASE + (Number.parseInt(hex, 16) % SSH_PORT_SPAN);
};

// The socket URL for a resolved base, ws-scheme, at the transport route. One prefix swap covers both
// `https://`→`wss://` and the loopback shortcut's plain `http://`→`ws://`, since the trailing `s` (or lack of it)
// survives either way.
export const sshSocketUrl = (base: string): string => `${base.replace(/\/$/, "").replace(/^http/, "ws")}/system/sync/ssh`;

// Backpressure: a WebSocket send never blocks, it buffers, so an unbounded upload would grow the send buffer
// until the process dies. Past HIGH the TCP socket pauses (so ssh blocks on its own write); resumes under LOW.
const BUFFER_HIGH = 1_048_576;
const BUFFER_LOW = 262_144;
const DRAIN_POLL_MS = 50;

// TCP accept always succeeds locally, so an unreachable sandbox fails only inside a WebSocket that may never
// resolve, stalling ssh and everything waiting on it. Short, since a healthy sandbox settles under a second and
// Mutagen redials anyway.
const OPEN_TIMEOUT_MS = 10_000;

// Copies a chunk out of Node's shared Buffer pool: `send` is async, so handing over the pool's memory directly
// risks the next read overwriting bytes not yet sent, a silent transport corruption.
const frameOf = (chunk: Buffer): Uint8Array<ArrayBuffer> => {
    const frame = new Uint8Array(chunk.byteLength);
    frame.set(chunk);
    return frame;
};

export interface TunnelTarget {
    readonly sandboxId: string;
    // Where this pairing's daemon is dialled this pass (daemon-base.ts), not necessarily its public address.
    readonly base: string;
    readonly syncToken: string;
}

// Only pairings with a sync token get a transport; otherwise a bound listener would accept ssh and fail every
// connection, worse than none. Bases arrive pre-resolved, shared with the ports poll and report, avoiding a third
// probe.
export const tunnelTargets = (dialed: readonly Dialed<Pairing>[]): readonly TunnelTarget[] =>
    dialed.flatMap(({ pairing, base }) =>
        pairing.syncToken === undefined ? [] : [{ sandboxId: pairing.sandboxId, base, syncToken: pairing.syncToken }],
    );

// Bridges one accepted TCP connection to one WebSocket. Exported so a test can drive it without binding a real
// listener.
export const bridgeConnection = (socket: Socket, target: TunnelTarget, onError: (message: string) => void): void => {
    // The credential goes on the request, not the URL, since a query string ends up in logs. The cast works around
    // the DOM lib typing this argument as subprotocols; both Node's undici and Bun accept a headers object there.
    const ws = new WebSocket(sshSocketUrl(target.base), { headers: { "x-intentic-sync": target.syncToken } } as never);
    ws.binaryType = "arraybuffer";
    // ssh's version banner can arrive before the socket opens, so early bytes are queued, not dropped; the socket
    // stays paused until open, bounding the queue to one read.
    const queued: Buffer[] = [];
    let open = false;
    let drain: NodeJS.Timeout | undefined;
    socket.pause();

    const close = (): void => {
        clearInterval(drain);
        drain = undefined;
        clearTimeout(handshake);
        socket.destroy();
        if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) {
            ws.close();
        }
    };

    // A handshake that never resolves is invisible to ssh; ending the TCP connection is the only way to surface it,
    // so the caller fails in seconds instead of hanging on its own timeout.
    const handshake = setTimeout(() => {
        onError(`the sync transport to ${target.sandboxId} did not open within ${OPEN_TIMEOUT_MS / 1000}s: the sandbox is not answering`);
        close();
    }, OPEN_TIMEOUT_MS);

    socket.on("data", (chunk: Buffer) => {
        if (!open) {
            queued.push(chunk);
            return;
        }
        ws.send(frameOf(chunk));
        if (drain === undefined && ws.bufferedAmount > BUFFER_HIGH) {
            socket.pause();
            drain = setInterval(() => {
                if (ws.bufferedAmount < BUFFER_LOW) {
                    clearInterval(drain);
                    drain = undefined;
                    socket.resume();
                }
            }, DRAIN_POLL_MS);
        }
    });
    socket.on("close", close);
    socket.on("error", close);

    ws.addEventListener("open", () => {
        open = true;
        clearTimeout(handshake); // the stream is up; from here a long-lived connection is the point, not a symptom
        for (const chunk of queued) {
            ws.send(frameOf(chunk));
        }
        queued.length = 0;
        socket.resume();
    });
    ws.addEventListener("message", (event: MessageEvent) => {
        const data: unknown = event.data;
        if (data instanceof ArrayBuffer) {
            socket.write(Buffer.from(data));
        } else if (typeof data === "string") {
            socket.write(Buffer.from(data, "binary"));
        }
    });
    ws.addEventListener("error", () => {
        // A WebSocket error event's message says nothing useful; a user needs which sandbox failed, which the log line
        // already carries.
        onError(`the sync transport to ${target.sandboxId} could not be opened`);
        close();
    });
    ws.addEventListener("close", close);
};

// Don't add an HTTP-GET diagnosis for a WebSocket error: this route exists only as an upgrade, so a plain GET
// 404s even on a healthy sandbox, producing a confident but wrong diagnosis.

// Starts listening for this pairing; resolves once bound, so a caller handing the port to ssh doesn't race it.
// EADDRINUSE is reported, not thrown, so one taken port doesn't take down other pairings' tunnels.
export const startSshTunnel = async (target: TunnelTarget, log: Log): Promise<(() => Promise<void>) | undefined> => {
    const port = syncSshPort(target.sandboxId);
    const sockets = new Set<Socket>();
    const server: Server = createServer((socket) => {
        sockets.add(socket);
        socket.on("close", () => sockets.delete(socket));
        bridgeConnection(socket, target, (message) => log(message));
    });
    const bound = await new Promise<boolean>((resolve) => {
        server.once("error", (error: NodeJS.ErrnoException) => {
            log(
                error.code === "EADDRINUSE"
                    ? `port ${port} is already taken, so ${target.sandboxId} has no sync transport on this machine. Free it and restart the mirror watcher.`
                    : `the sync transport for ${target.sandboxId} could not listen on ${port}: ${error.message}`,
            );
            resolve(false);
        });
        server.listen(port, "127.0.0.1", () => resolve(true));
    });
    if (!bound) {
        return undefined;
    }
    return async (): Promise<void> => {
        for (const socket of sockets) {
            socket.destroy();
        }
        await new Promise<void>((resolve) => server.close(() => resolve()));
    };
};

// Every pairing's transport, held by the mirror watcher process rather than a second thing to keep alive.
// Reconciled, not started once, so a concurrent setup/uninstall adds or drops a pairing's transport without
// restarting this process.
export const createTunnelPool = (log: Log) => {
    // The base each live listener was bound for, beside its stop: a listener closes over the address it dials, so
    // the pool must remember what it was told.
    const running = new Map<string, { readonly base: string; readonly stop: () => Promise<void> }>();
    return {
        reconcile: async (targets: readonly TunnelTarget[]): Promise<void> => {
            const wanted = new Set(targets.map((target) => target.sandboxId));
            for (const [sandboxId, held] of running) {
                if (!wanted.has(sandboxId)) {
                    running.delete(sandboxId);
                    // oxlint-disable-next-line eslint/no-await-in-loop -- one listener at a time; the set is tiny and ordering keeps the log readable
                    await held.stop();
                    log(`  sync transport for ${sandboxId} stopped: it is no longer paired`);
                }
            }
            for (const target of targets) {
                const held = running.get(target.sandboxId);
                if (held?.base === target.base) {
                    continue;
                }
                // A moved base needs a rebind: bridgeConnection captures the target, so a listener bound before a
                // promotion
                // would keep dialing the old address. Drops live connections, but Mutagen redials within seconds
                // regardless.
                if (held !== undefined) {
                    running.delete(target.sandboxId);
                    // oxlint-disable-next-line eslint/no-await-in-loop -- the old listener must release the port before the new one binds it
                    await held.stop();
                    log(`  sync transport for ${target.sandboxId} moving to ${target.base}`);
                }
                // oxlint-disable-next-line eslint/no-await-in-loop -- ditto: a bind per pairing, serialized on purpose
                const stop = await startSshTunnel(target, log);
                if (stop !== undefined) {
                    running.set(target.sandboxId, { base: target.base, stop });
                    log(`  sync transport for ${target.sandboxId} listening on 127.0.0.1:${syncSshPort(target.sandboxId)}`);
                }
            }
        },
        stopAll: async (): Promise<void> => {
            const held = [...running.values()];
            running.clear();
            await Promise.all(held.map(async ({ stop }) => await stop()));
        },
    };
};

// Waits until a transport accepts, or gives up. `setup` needs this since it hands the port to ssh right after
// writing the config, but the watcher it just restarted is what actually binds it.
const READY_POLL_MS = 100;

export const tunnelReady = (port: number, timeoutMs: number): Promise<boolean> =>
    pollUntil(
        () =>
            new Promise<boolean>((resolve) => {
                const probe = connect(port, "127.0.0.1");
                const settle = (value: boolean): void => {
                    probe.destroy();
                    resolve(value);
                };
                probe.once("connect", () => settle(true));
                probe.once("error", () => settle(false));
            }),
        { intervalMs: READY_POLL_MS, timeoutMs },
    );
