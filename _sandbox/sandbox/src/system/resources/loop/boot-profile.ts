import { mkdir, readdir, rm, writeFile } from "node:fs/promises";
import { Session } from "node:inspector/promises";
import { join } from "node:path";
import { monitorEventLoopDelay } from "node:perf_hooks";
import type { Logger } from "pino";

// The daemon's first two minutes, sampled from the start: a boot stall (the editor's whole reconnect burst waits on it)
// is over before anyone could attach a profiler, so this one is already running, and its profile is kept only when the
// loop stalled. `fileq` reads the file as functions ranked by cost.

// Covers the reconnect burst that follows a restart; every boot stall measured began within 5 s and lasted under 25.
const WINDOW_MS = 120_000;
// The watchdog's own threshold (loop-watchdog.ts): a shorter pause is not one anybody felt.
const STALL_MS = 1_500;
// Microseconds between samples; a 10 s stall leaves 5,000 of them.
const SAMPLE_US = 2_000;
// Boot profiles held in the logs directory, newest first; each is a few MB.
const KEEP = 3;
const PREFIX = "boot-";
const SUFFIX = ".cpuprofile";

export interface BootProfile {
    readonly stop: () => void;
}

export interface BootProfileOptions {
    readonly windowMs?: number;
    readonly stallMs?: number;
}

const prune = async (dir: string): Promise<void> => {
    const kept = (await readdir(dir)).filter((name) => name.startsWith(PREFIX) && name.endsWith(SUFFIX));
    // ISO stamps sort as text in time order.
    await Promise.all(
        kept
            .toSorted((a, b) => b.localeCompare(a))
            .slice(KEEP)
            .map((name) => rm(join(dir, name), { force: true })),
    );
};

export const startBootProfile = (logger: Logger, dir: string, options: BootProfileOptions = {}): BootProfile => {
    const windowMs = options.windowMs ?? WINDOW_MS;
    const stallMs = options.stallMs ?? STALL_MS;
    const startedAt = new Date();
    const session = new Session();
    const delay = monitorEventLoopDelay({ resolution: 20 });
    let over = false;
    const started = (async (): Promise<void> => {
        session.connect();
        delay.enable();
        await session.post("Profiler.enable");
        await session.post("Profiler.setSamplingInterval", { interval: SAMPLE_US });
        await session.post("Profiler.start");
    })();
    const end = async (keep: boolean): Promise<void> => {
        await started;
        const { profile } = await session.post("Profiler.stop");
        session.disconnect();
        delay.disable();
        const worstStallMs = Math.round(delay.max / 1e6);
        if (!keep || worstStallMs < stallMs) {
            return;
        }
        const file = join(dir, `${PREFIX}${startedAt.toISOString().replaceAll(":", "-")}${SUFFIX}`);
        await mkdir(dir, { recursive: true });
        await writeFile(file, JSON.stringify(profile));
        await prune(dir);
        logger.warn({ file, worstStallMs }, "boot: the event loop stalled while starting; the CPU profile of those minutes is kept");
    };
    const settle = (keep: boolean): void => {
        if (over) {
            return;
        }
        over = true;
        void end(keep).catch((error: unknown) => logger.warn({ err: error }, "boot: the start-up profile could not be taken"));
    };
    const timer = setTimeout(() => settle(true), windowMs);
    // The profile must never be what keeps the daemon alive.
    timer.unref();
    return {
        stop: () => {
            clearTimeout(timer);
            settle(false);
        },
    };
};
