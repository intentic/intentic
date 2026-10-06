import { createHash } from "node:crypto";
import { connect, createServer, type Server, type Socket } from "node:net";
import { pollUntil } from "@intentic/base/async";
import { type Pump, pumpTcpWebSocket } from "@intentic/base/ws-tcp-pump";
import type { Log } from "@intentic/local-agent";
import type { Dialed } from "../daemon-base.js";
import { type Pairing, pairingTransport } from "./config.js";
import { type SyncEnvironment, syncEnvironment } from "./environment.js";

// A loopback port on this machine that is the sandbox's sshd: Mutagen speaks only SSH, so something must front it
// with TCP. One socket per SSH connection, opened on demand, closed with it; a failed socket just fails the TCP
// connection since Mutagen retries on its own.
// ssh ─→ 127.0.0.1:<port> [here] ─wss→ <sandbox>/system/sync/ssh ─→ 127.0.0.1:22 [in the sandbox]

// Loopback port for a sandbox's SSH endpoint, derived from its id: stable, and clear of the sandbox daemon's own
// loopback band (28000-31999 in @intentic/sandbox-run) derived from the same digest. Below Linux's ephemeral floor.
// Exported for the test that holds both to `portBands.syncSsh` in sandbox-run's names.fixture.json, the record the
// daemon band and the Rust readers are checked against too, so moving either band fails a test.
export const SSH_PORT_BASE = 24000;
export const SSH_PORT_SPAN = 4000;

// (2026-10-05) A WSL DISTRO DERIVES ITS PORTS IN A BAND OF ITS OWN. Under WSL's mirrored networking a distro's loopback
// IS the Windows side's, so a PC whose Windows side and a distro both paired one sandbox derived one port twice: the
// second listener failed with EADDRINUSE and that environment's file sync had no transport at all. A distro now hashes
// its own name in with the id and lands in 20000-23999, so it can never derive a port the Windows side (or a Mac, or a
// plain Linux box, all still in 24000-27999 exactly as before) derives; nothing outside WSL moves. A distro's ports move
// once, at the first start of this build, which costs nothing: the ssh config block is rewritten from the same rule at
// every start, and known_hosts keys an entry by its alias (HostKeyAlias), not its port.
const WSL_PORT_BASE = 20000;

// The pre-2026-10-05 derivation, still every native environment's: a sandbox id's first six hex digits.
const legacyOffset = (sandboxId: string): number => {
    // The id may be 12 hex or a sanitized alias; digits are taken from wherever they are, not a fixed offset, since
    // only a stable one-id-to-one-port mapping matters.
    const hex = (/[0-9a-f]{6}/i.exec(sandboxId)?.[0] ?? "000000").toLowerCase();
    return Number.parseInt(hex, 16) % SSH_PORT_SPAN;
};

export const syncSshPort = (sandboxId: string, environment: SyncEnvironment = syncEnvironment()): number => {
    if (!environment.wsl) {
        return SSH_PORT_BASE + legacyOffset(sandboxId);
    }
    const digest = createHash("sha256").update(`${environment.name}\0${sandboxId}`).digest();
    return WSL_PORT_BASE + (digest.readUInt32BE(0) % SSH_PORT_SPAN);
};

// Every port this environment's alias for a sandbox was ever bound to: today's, and the pre-2026-10-05 one a distro
// derived before its band moved. What a known_hosts cleanup strips (`[alias]:port` spellings).
export const syncSshPorts = (sandboxId: string, environment: SyncEnvironment = syncEnvironment()): readonly number[] => [
    ...new Set([syncSshPort(sandboxId, environment), SSH_PORT_BASE + legacyOffset(sandboxId)]),
];

// The socket URL for a resolved base, ws-scheme, at the transport route. One prefix swap covers both
// `https://`→`wss://` and the loopback shortcut's plain `http://`→`ws://`, since the trailing `s` (or lack of it)
// survives either way.
export const sshSocketUrl = (base: string): string => `${base.replace(/\/$/, "").replace(/^http/, "ws")}/system/sync/ssh`;

// TCP accept always succeeds locally, so an unreachable sandbox fails only inside a WebSocket that may never
// resolve, stalling ssh and everything waiting on it. Short, since a healthy sandbox settles under a second and
// Mutagen redials anyway.
const OPEN_TIMEOUT_MS = 10_000;

export interface TunnelTarget {
    readonly sandboxId: string;
    // Where this pairing's daemon is dialled this pass (daemon-base.ts), not necessarily its public address.
    readonly base: string;
    readonly syncToken: string;
}

// Only pairings with a sync token get a transport; otherwise a bound listener would accept ssh and fail every
// connection, worse than none. A pairing reached through Docker (endpoint.ts) needs none either: nothing of it rides
// ssh. Bases arrive pre-resolved, shared with the ports poll and report, avoiding a third probe.
// (2026-10-05) Nor does a sandbox the platform or this machine says is gone (gone.ts): a listener for it only answers
// ssh with a socket that fails, and the watcher no longer dials it. It comes back with the sandbox's first answer.
export const tunnelTargets = (dialed: readonly Dialed<Pairing>[]): readonly TunnelTarget[] =>
    dialed.flatMap(({ pairing, base }) =>
        pairing.syncToken === undefined || pairingTransport(pairing) === "docker" || pairing.goneSince !== undefined
            ? []
            : [{ sandboxId: pairing.sandboxId, base, syncToken: pairing.syncToken }],
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
    const early = (chunk: Buffer): void => {
        queued.push(chunk);
    };
    let pump: Pump | undefined;
    socket.pause();

    const close = (): void => {
        pump?.stop();
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

    socket.on("data", early);
    socket.on("close", close);
    socket.on("error", close);

    // Both directions through the pump the daemon's end runs too (@intentic/base/ws-tcp-pump). This WebSocket cannot
    // pause, so a Mutagen that stops reading costs this stream past the pump's ceiling rather than unbounded memory.
    ws.addEventListener("open", () => {
        clearTimeout(handshake); // the stream is up; from here a long-lived connection is the point, not a symptom
        socket.off("data", early);
        pump = pumpTcpWebSocket(
            socket,
            { send: (frame) => ws.send(frame), bufferedAmount: () => ws.bufferedAmount },
            {
                queued: queued.splice(0),
                onOverflow: () => {
                    onError(`the sync transport to ${target.sandboxId} was dropped: ssh stopped reading what the sandbox sent`);
                    close();
                },
            },
        );
    });
    ws.addEventListener("message", (event: MessageEvent) => {
        pump?.inbound(event.data);
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
                    // oxlint-disable-next-line eslint/no-await-in-loop -- Listeners are released in order.
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
                    // oxlint-disable-next-line eslint/no-await-in-loop -- The old listener must release the port first.
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
