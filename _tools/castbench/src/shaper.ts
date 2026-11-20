import { type AddressInfo, connect, createServer, type Server, type Socket } from "node:net";
import { performance } from "node:perf_hooks";
import { bottleneck, bytesInMs, type Link, slices } from "./link.js";

// The hop every run's viewer connects through: a byte relay in front of the pipeline, as netd is in front of the daemon
// and of castd in a sandbox, shaped to the run's link. Over TCP on one machine, so what it can emulate is rate and
// delay, and nothing else: a lost packet on a TCP link is a retransmit the kernel hides, so packet loss is not a thing
// this proxy (or any userspace TCP proxy) can show.
//
// Server to viewer: serialized at the link's rate, then delayed by half the round trip. Viewer to server: delayed by
// half the round trip, never capped, since input and acks are a few hundred bytes. The downstream queue is bounded
// (`queueMs` of the link's rate): past it the proxy stops reading, the kernel buffers behind it fill, and the pipeline
// feels a slow link the way it feels one in production, as a socket that will not drain. An unbounded queue (voxl's
// shaper.py) is the bufferbloated path instead: `queueMs: Infinity`.

// A slice small enough that a frame trickles out as on a real link: 4 KiB is 3.3 ms at 10 Mbit/s.
const SLICE_BYTES = 4096;

export interface RelayTarget {
    // A Unix socket (castd's), or a TCP port on loopback (the legacy pipeline's server).
    readonly path?: string;
    readonly port?: number;
}

export interface Relay {
    readonly port: number;
    // Bytes carried to viewers so far, after shaping.
    readonly downBytes: () => number;
    readonly close: () => Promise<void>;
}

interface Direction {
    readonly onData: (chunk: Buffer) => void;
    readonly onEnd: () => void;
}

// One direction of one connection through the link.
const throttledDirection = (from: Socket, to: Socket, mbps: number | null, delayMs: number, queueMs: number, counted: (bytes: number) => void): Direction => {
    const link = bottleneck(mbps, delayMs);
    const queueBytes = bytesInMs(queueMs, mbps);
    const pending: { at: number; data: Buffer }[] = [];
    let timer: NodeJS.Timeout | undefined;
    let ended = false;
    let paused = false;

    const flush = (): void => {
        timer = undefined;
        const now = performance.now();
        while (pending.length > 0 && pending[0]!.at <= now) {
            const { data } = pending.shift()!;
            counted(data.byteLength);
            to.write(data);
        }
        if (pending.length > 0) {
            timer = setTimeout(flush, Math.max(0, pending[0]!.at - now));
        } else if (ended) {
            to.end();
        }
    };

    // Resumes reading once the serializer has drained to the queue's size again.
    const resumeWhenDrained = (): void => {
        const wait = link.msUntilBacklog(queueBytes, performance.now());
        if (wait <= 0) {
            paused = false;
            from.resume();
            return;
        }
        setTimeout(resumeWhenDrained, Math.max(1, wait));
    };

    return {
        onData: (chunk) => {
            const now = performance.now();
            for (const [start, end] of slices(chunk.byteLength, SLICE_BYTES)) {
                pending.push({ at: link.arrival(end - start, now), data: chunk.subarray(start, end) });
            }
            timer ??= setTimeout(flush, Math.max(0, pending[0]!.at - now));
            if (!paused && link.backlogBytes(now) > queueBytes) {
                paused = true;
                from.pause();
                resumeWhenDrained();
            }
        },
        onEnd: () => {
            ended = true;
            if (pending.length === 0 && timer === undefined) {
                to.end();
            }
        },
    };
};

export const startRelay = async (target: RelayTarget, link: Link, options: { readonly queueMs?: number } = {}): Promise<Relay> => {
    const queueMs = options.queueMs ?? 200;
    let carried = 0;
    const sockets = new Set<Socket>();
    const throttled = link.mbps !== null || link.rttMs > 0;

    const server: Server = createServer((viewer) => {
        viewer.setNoDelay(true);
        const upstream = target.path === undefined ? connect({ host: "127.0.0.1", port: target.port ?? 0 }) : connect({ path: target.path });
        upstream.setNoDelay?.(true);
        sockets.add(viewer).add(upstream);
        const drop = (): void => {
            viewer.destroy();
            upstream.destroy();
            sockets.delete(viewer);
            sockets.delete(upstream);
        };
        viewer.on("error", drop).on("close", drop);
        upstream.on("error", drop).on("close", drop);
        if (!throttled) {
            // The direct link: a relay hop and nothing else, the way netd carries a socket inside one machine.
            upstream.on("data", (chunk: Buffer) => {
                carried += chunk.byteLength;
            });
            viewer.pipe(upstream);
            upstream.pipe(viewer);
            return;
        }
        const down = throttledDirection(upstream, viewer, link.mbps, link.rttMs / 2, queueMs, (bytes) => {
            carried += bytes;
        });
        const up = throttledDirection(viewer, upstream, null, link.rttMs / 2, Infinity, () => undefined);
        upstream.on("data", down.onData).on("end", down.onEnd);
        viewer.on("data", up.onData).on("end", up.onEnd);
    });
    await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(0, "127.0.0.1", () => resolve());
    });
    // SAFETY: listen() was given a TCP port and has resolved, so the address is an AddressInfo, never a pipe name or null.
    const address = server.address() as AddressInfo;
    return {
        port: address.port,
        downBytes: () => carried,
        close: async () => {
            for (const socket of sockets) {
                socket.destroy();
            }
            await new Promise<void>((resolve) => server.close(() => resolve()));
        },
    };
};
