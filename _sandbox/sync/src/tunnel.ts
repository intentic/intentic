import { connect, createServer, type Server, type Socket } from "node:net";
import type { Log } from "@intentic/local-agent";

/* THE TRANSPORT, THIS SIDE, a loopback port on this machine that IS the sandbox's sshd.
 *
 * Mutagen speaks SSH and nothing else, so something has to put a TCP endpoint in front of it. That used to be
 * the reachability fabric: `ssh-<id>.<zone>` was a real hostname and `cloudflared access ssh` dialled it. The
 * fabric now carries HTTP, so the sandbox exposes its sshd on its own HTTPS surface instead
 * (sandbox: platform/sync-ssh.ts) and this listener is the other end of that pipe:
 *
 *   ssh ─→ 127.0.0.1:<port> [here] ─wss→ <sandbox>/system/sync/ssh ─→ 127.0.0.1:22 [in the sandbox]
 *
 * One socket per SSH connection, opened on demand and closed with it, no session, no reconnect logic, nothing
 * to keep in step. Mutagen already treats a dropped transport as a reconnect and retries forever, so the
 * honest thing for a failed socket to do is fail the TCP connection and let Mutagen decide when to try again.
 *
 * A WebSocket rather than a bare HTTP upgrade of our own invention, because this stream crosses whatever sits
 * in front of the sandbox, the platform's hub, a reverse proxy, possibly a CDN, and a WebSocket is the one
 * upgrade every one of them is guaranteed to pass through. The daemon's terminal already proves this exact
 * path end to end.
 */

/* The loopback port a sandbox's SSH endpoint lands on, derived from its id so it is the same on every run and
 * different for every sandbox this machine pairs. Its own band, deliberately clear of the one the sandbox
 * daemon's loopback listener derives from the same digest (28000–31999 in @intentic/sandbox-run): two ports
 * derived from one id must not be able to collide with each other. Below Linux's ephemeral floor, so the kernel
 * never hands the same number to something else first. */
const SSH_PORT_BASE = 24000;
const SSH_PORT_SPAN = 4000;

export const syncSshPort = (sandboxId: string): number => {
    // The id as the daemon knows it is 12 hex; a sanitized alias (`sandbox-<hex>-<zone>`) is not, so the digits
    // are taken from wherever they are rather than from a fixed offset, the point is only that one id maps to
    // one port, stably.
    const hex = (/[0-9a-f]{6}/i.exec(sandboxId)?.[0] ?? "000000").toLowerCase();
    return SSH_PORT_BASE + (Number.parseInt(hex, 16) % SSH_PORT_SPAN);
};

// The socket URL for a paired sandbox: its own public URL, ws-scheme, at the daemon's transport route.
export const sshSocketUrl = (sandboxUrl: string): string => `${sandboxUrl.replace(/\/$/, "").replace(/^http/, "ws")}/system/sync/ssh`;

/* Backpressure, laptop side. A sync push fills this direction, and a WebSocket send never blocks, it buffers,
 * so without this a big upload grows the send buffer until the process dies. Past HIGH the TCP socket is paused
 * (ssh then blocks on its own write, which is the signal we want to reach Mutagen); it resumes under LOW. */
const BUFFER_HIGH = 1_048_576;
const BUFFER_LOW = 262_144;
const DRAIN_POLL_MS = 50;

/* HOW LONG A CONNECTION MAY SIT IN THE HANDSHAKE before this end gives up on it.
 *
 * The listener accepts TCP instantly, it is a local socket, so from ssh's point of view the connection always
 * SUCCEEDS, and everything that can actually fail (the sandbox being asleep, its tunnel 502-ing, its zone
 * retired) fails silently afterwards, inside a WebSocket that may never resolve either way. ssh then waits in
 * banner exchange, and every caller waits on ssh: Mutagen's create, and the git bridge, whose own cap is 120
 * SECONDS. One unreachable sandbox therefore added two minutes to every watcher pass, serially, ahead of every
 * healthy pairing's ports and commits, for as long as it stayed unreachable. Measured on this exact bug.
 *
 * So the timeout lives HERE, at the one place that knows the stream never opened, and it is short: a WebSocket to
 * a healthy sandbox settles in well under a second, and anything slower is going to be retried anyway. Mutagen
 * redials a dropped transport every 15s and the watcher's next pass is seconds away. Failing fast is what keeps a
 * dead pairing costing one line in the log instead of every other pairing's freshness. */
const OPEN_TIMEOUT_MS = 10_000;

/* One TCP read, as a frame the socket can own. A Buffer is a slice of a shared pool and `send` is asynchronous,
 * so handing over the pool's memory lets the next read overwrite bytes that have not gone out yet, on an SSH
 * stream that is not a glitch, it is a corrupted transport with no error to point at. */
const frameOf = (chunk: Buffer): Uint8Array<ArrayBuffer> => {
    const frame = new Uint8Array(chunk.byteLength);
    frame.set(chunk);
    return frame;
};

export interface TunnelTarget {
    readonly sandboxId: string;
    readonly sandboxUrl: string;
    readonly syncToken: string;
}

/* Which pairings get a transport: the ones holding a sync token, which is the credential the socket presents.
 * A pairing without one cannot open the stream, so binding a port for it would produce a listener that accepts
 * ssh and then fails every connection, a worse answer than no listener, which at least fails at connect with
 * the port in the message. */
export const tunnelTargets = (
    pairings: readonly { readonly sandboxId: string; readonly sandboxUrl: string; readonly syncToken?: string }[],
): readonly TunnelTarget[] =>
    pairings
        .filter((pairing): pairing is TunnelTarget => pairing.syncToken !== undefined)
        .map(({ sandboxId, sandboxUrl, syncToken }) => ({ sandboxId, sandboxUrl, syncToken }));

// Bridge ONE accepted TCP connection to one WebSocket. Exported for the test that drives it against a real
// socket server without binding a listener.
export const bridgeConnection = (socket: Socket, target: TunnelTarget, onError: (message: string) => void): void => {
    /* The credential goes on the REQUEST, not in the URL, a query string is the half of a request that ends up
     * in logs, and this token is what a machine's whole enrollment rests on. The cast is because the second
     * argument is typed as WebSocket subprotocols by the DOM lib; both runtimes this agent runs on (Node's
     * undici and Bun) accept an options object with headers there, which is checked by the tests. */
    const ws = new WebSocket(sshSocketUrl(target.sandboxUrl), { headers: { "x-intentic-sync": target.syncToken } } as never);
    ws.binaryType = "arraybuffer";
    // ssh sends its version banner immediately, before the socket is open, so bytes that arrive early are held
    // rather than dropped. Cleared on open; the socket stays paused until then so the queue is bounded by one
    // read rather than by how long the handshake takes.
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

    // A handshake that never resolves is the failure mode ssh cannot see (see OPEN_TIMEOUT_MS). Ending the TCP
    // connection is the only answer that reaches it: the caller then fails in seconds with a real error, instead
    // of holding the watcher's pass open for as long as its own timeout allows.
    const handshake = setTimeout(() => {
        onError(`the sync transport to ${target.sandboxId} did not open within ${OPEN_TIMEOUT_MS / 1000}s — the sandbox is not answering`);
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
        // The message on a WebSocket error event says nothing useful in any runtime; what a user needs is which
        // sandbox failed, which the caller's line already carries.
        onError(`the sync transport to ${target.sandboxId} could not be opened`);
        close();
    });
    ws.addEventListener("close", close);
};

/* NO SEPARATE "DIAGNOSIS" REQUEST LIVES HERE, and the attempt is worth recording. A WebSocket error event carries
 * no status by specification, so the obvious idea is to ask the same URL over plain HTTP and report what comes
 * back. It does not work: this route exists only as an upgrade, so a plain GET answers 404 on a perfectly healthy
 * sandbox, and the "diagnosis" then states, in a confident sentence, that the user's sandbox is too old, when
 * the real cause is on this side. A wrong explanation is worse than the plain fact that the stream did not open;
 * it sends the reader to the wrong machine. If this is ever worth explaining, it has to be explained by something
 * that performs the real upgrade. */

/* Start listening for this pairing. Resolves once the port is bound, a caller that goes on to hand the port to
 * ssh must not race the bind, and answers a stop function that closes the listener and every live stream.
 *
 * EADDRINUSE is reported rather than thrown: on a machine that pairs several sandboxes, one port taken by
 * something else must not take down the other pairings' tunnels with it. */
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

/* EVERY PAIRING'S TRANSPORT, held by one process, the mirror watcher, which is already the resident half of
 * this agent: it runs at every login, it re-reads the pairing list on every tick, and it is what `setup`
 * restarts. Putting the listeners anywhere else would mean a second thing to keep alive and a second thing to
 * restart, for the same lifetime.
 *
 * Reconciled rather than started once, for the reason the watcher re-reads state at all: a `setup` in another
 * terminal adds a pairing and an `uninstall` removes one, and neither should need this process restarted. */
export const createTunnelPool = (log: Log) => {
    const running = new Map<string, () => Promise<void>>();
    return {
        reconcile: async (targets: readonly TunnelTarget[]): Promise<void> => {
            const wanted = new Set(targets.map((target) => target.sandboxId));
            for (const [sandboxId, stop] of running) {
                if (!wanted.has(sandboxId)) {
                    running.delete(sandboxId);
                    // oxlint-disable-next-line eslint/no-await-in-loop -- one listener at a time; the set is tiny and ordering keeps the log readable
                    await stop();
                    log(`  sync transport for ${sandboxId} stopped — it is no longer paired`);
                }
            }
            for (const target of targets) {
                if (running.has(target.sandboxId)) {
                    continue;
                }
                // oxlint-disable-next-line eslint/no-await-in-loop -- ditto: a bind per pairing, serialized on purpose
                const stop = await startSshTunnel(target, log);
                if (stop !== undefined) {
                    running.set(target.sandboxId, stop);
                    log(`  sync transport for ${target.sandboxId} listening on 127.0.0.1:${syncSshPort(target.sandboxId)}`);
                }
            }
        },
        stopAll: async (): Promise<void> => {
            const stops = [...running.values()];
            running.clear();
            await Promise.all(stops.map(async (stop) => await stop()));
        },
    };
};

/* Wait until a transport accepts a connection, or give up. `setup` needs this: it hands the port to ssh the
 * moment it has written the config, but the process that BINDS the port is the watcher it just restarted, so
 * without a wait the first probe races a listener that is still coming up and reports a failure that is really
 * a few hundred milliseconds of startup. */
const READY_POLL_MS = 100;

export const tunnelReady = async (port: number, timeoutMs: number): Promise<boolean> => {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
        // oxlint-disable-next-line eslint/no-await-in-loop -- a bounded poll on one port, serial by definition
        const open = await new Promise<boolean>((resolve) => {
            const probe = connect(port, "127.0.0.1");
            const settle = (value: boolean): void => {
                probe.destroy();
                resolve(value);
            };
            probe.once("connect", () => settle(true));
            probe.once("error", () => settle(false));
        });
        if (open || Date.now() >= deadline) {
            return open;
        }
        // oxlint-disable-next-line eslint/no-await-in-loop -- same
        await new Promise((resolve) => setTimeout(resolve, READY_POLL_MS));
    }
};
