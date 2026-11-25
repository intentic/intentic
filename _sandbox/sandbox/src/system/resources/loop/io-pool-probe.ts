import { stat } from "node:fs";
import type { Logger } from "pino";
import { opt } from "../../../opt.js";

/* WHETHER LIBUV'S THREAD POOL STILL ANSWERS (2026-11-24). Every fs, dns.lookup and zlib call the daemon makes runs on one
   pool (UV_THREADPOOL_SIZE=32, docker-entrypoint.sh), and the sandbox mounts SMB shares (netdisk). A mount that stops
   answering parks each thread that touches it in the kernel; once every thread is parked, every read, write and lookup
   in the daemon queues behind them, while the event loop itself turns freely, so netd's ping is answered and the loop
   watchdog sees no stall. This probe times one fs.stat of the node binary through the pool every PROBE_EVERY_MS, with at
   most one in flight: a stat that never returns is waited on, never joined by another, so a stuck pool is never handed
   more work by the thing watching it. Past STALLED_AFTER_MS it is a stall, logged once with how long, and again when the
   stat finally returns. Its state rides /health (`ioPool`) and every event-loop stall line (loop-watchdog.ts).
   After Orca's daemon-async-io-probe.ts. */

const PROBE_EVERY_MS = 10_000;
// A local stat takes microseconds; even 32 threads busy hashing files clear one in well under a second.
const STALLED_AFTER_MS = 5_000;

export interface IoPoolState {
    readonly state: "answering" | "stalled";
    // How long the stat in flight has waited, while stalled.
    readonly pendingMs?: number;
    // How long the last stat that returned took.
    readonly lastMs?: number;
    // Stalls since the daemon started.
    readonly stalls: number;
}

export interface IoPoolProbe {
    readonly state: () => IoPoolState;
    readonly stop: () => void;
}

export interface IoPoolProbeOptions {
    // The call timed through the pool; fs.stat of the running binary unless a test hands its own.
    readonly probe?: (done: () => void) => void;
    readonly now?: () => number;
    readonly everyMs?: number;
    readonly stalledAfterMs?: number;
}

let current: IoPoolProbe | undefined;

/** The probe's state, for /health; undefined before the daemon started one. */
export const ioPoolState = (): IoPoolState | undefined => current?.state();

const statBinary = (done: () => void): void => {
    // Any answer, an error included, is the pool doing work.
    stat(process.execPath, () => done());
};

export const startIoPoolProbe = (logger: Pick<Logger, "warn" | "info">, options: IoPoolProbeOptions = {}): IoPoolProbe => {
    const probe = options.probe ?? statBinary;
    const now = options.now ?? (() => performance.now());
    const stalledAfter = options.stalledAfterMs ?? STALLED_AFTER_MS;
    let startedAt: number | undefined;
    let lastMs: number | undefined;
    let stalls = 0;
    let stalled = false;

    const send = (): void => {
        const began = now();
        startedAt = began;
        probe(() => {
            const took = Math.round(now() - began);
            startedAt = undefined;
            lastMs = took;
            if (stalled) {
                stalled = false;
                logger.info({ ioPool: { tookMs: took, stalls } }, "libuv thread pool answering again: a stat waited this long for a pool thread");
            }
        });
    };
    const tick = (): void => {
        if (startedAt === undefined) {
            send();
            return;
        }
        const pendingMs = Math.round(now() - startedAt);
        if (!stalled && pendingMs >= stalledAfter) {
            stalled = true;
            stalls += 1;
            logger.warn(
                { ioPool: { pendingMs, threads: process.env["UV_THREADPOOL_SIZE"] ?? "4", stalls } },
                "libuv thread pool stalled: a stat has had no pool thread for this long, so every fs, dns and zlib call in the daemon is queued; the event loop may still turn. Likeliest a network mount (netdisk) no longer answering, holding every thread",
            );
        }
    };
    const timer = setInterval(tick, options.everyMs ?? PROBE_EVERY_MS);
    // The probe must never be what keeps the daemon alive.
    timer.unref();
    send();
    const made: IoPoolProbe = {
        state: () => {
            const pendingMs = startedAt === undefined ? undefined : Math.round(now() - startedAt);
            const isStalled = pendingMs !== undefined && pendingMs >= stalledAfter;
            return {
                state: isStalled ? "stalled" : "answering",
                ...opt("pendingMs", isStalled ? pendingMs : undefined),
                ...opt("lastMs", lastMs),
                stalls,
            };
        },
        stop: () => {
            clearInterval(timer);
            if (current === made) {
                current = undefined;
            }
        },
    };
    current = made;
    return made;
};
