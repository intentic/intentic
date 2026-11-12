import { startPeriodic } from "@intentic/base/async";
import type { DiskPressure, DiskPressureLevel, StorageScan } from "@intentic/sandbox-contract/schemas/metrics";
import type { Logger } from "pino";
import type { HistorySpace } from "./checkout-space.js";

// THE DISK-PRESSURE WATCH (2026-11-03). On 11-02 shinobi's history volume went from 4% free to nothing in seventeen
// minutes; five conversations' rebases died half-written, and the only word anywhere was Claude Code's own "Disk full"
// banner. Nothing in the sandbox looked at the disk between hourly sweeps. This looks once a minute, and:
// - under REAP_BELOW free (the settings' threshold), removes build output from settled checkouts (landed first, then
//   the longest idle) until the volume is back over it: the one thing on a full disk that is large, regenerable and
//   nobody's work;
// - under LOW_BELOW and CRITICAL_BELOW, tells the owner once per level (a push, and the attention row the editor
//   draws while the level stands), and again only after the disk has been back over REAP_BELOW, so a volume that
//   hovers at 9% is said once, not every minute.
// Fractions of the volume rather than bytes: the same 50 GB is a crisis on a 200 GB disk and a margin on 4 TB.
// (2026-11-03) REAP_BELOW is the default of the settings' `diskReapBelowPercent`: on a disk the sandbox shares with other
// sandboxes and the owner's own containers (a local engine), the owner may want room kept sooner.
const REAP_BELOW = 0.15;
const LOW_BELOW = 0.1;
const CRITICAL_BELOW = 0.05;

const RANK = { ok: 0, reaping: 1, low: 2, critical: 3 } as const satisfies Record<DiskPressureLevel, number>;

export const pressureLevel = (space: HistorySpace, reapBelow: number = REAP_BELOW): DiskPressureLevel => {
    if (space.totalBytes <= 0) {
        return "ok";
    }
    const free = space.freeBytes / space.totalBytes;
    if (free < CRITICAL_BELOW) {
        return "critical";
    }
    if (free < LOW_BELOW) {
        return "low";
    }
    return free < reapBelow ? "reaping" : "ok";
};

// The categories a warning names as what is using the disk.
const USING_SHOWN = 3;

const usingOf = (scan: StorageScan | undefined): DiskPressure["using"] =>
    (scan?.categories ?? [])
        .toSorted((left, right) => right.bytes - left.bytes)
        .slice(0, USING_SHOWN)
        .map(({ id, bytes }) => ({ id, bytes }));

// LAST RESORTS, AFTER THE CHECKOUTS (2026-11-12). On shinobi the checkouts' build output was a fraction of what filled
// the disk: the main checkout's own Cargo `incremental/` held 68 GB and artifacts 56 GB, and nothing the watch could
// reach freed either. Each relief here is regenerable or the turn's leftovers, taken only while the disk stays short.
export interface PressureRelief {
    readonly name: string;
    readonly free: (enough: () => Promise<boolean>) => Promise<number>;
}

export interface DiskPressureDeps {
    readonly read: () => Promise<HistorySpace>;
    // The reaping threshold as a fraction of the volume, read each tick; REAP_BELOW where nothing sets it.
    readonly reapBelow?: () => Promise<number>;
    // Removes settled checkouts' build output until `enough`; resolves how many checkouts it took some from.
    readonly reap: (enough: () => Promise<boolean>) => Promise<number>;
    // What else may go, in order, while the disk is still short once checkouts' build output is gone; each resolves how
    // many things it removed and stops by itself once `enough` says there is room.
    readonly reliefs?: readonly PressureRelief[];
    readonly lastScan: () => Promise<StorageScan | undefined>;
    // The owner told, once per level crossed.
    readonly tell: (level: "low" | "critical", state: DiskPressure) => Promise<void>;
    // The level or the last reap moved: the editor's row reads it again.
    readonly changed: () => void;
    readonly logger: Pick<Logger, "info" | "warn">;
    readonly now: () => number;
}

export interface DiskPressureWatch {
    readonly tick: () => Promise<void>;
    readonly state: () => DiskPressure;
}

// Each relief in order until the disk has room; the reading after the last one that removed anything.
const relieve = async (
    deps: DiskPressureDeps,
    from: HistorySpace,
    reapBelow: number,
    enough: () => Promise<boolean>,
): Promise<{ space: HistorySpace; level: DiskPressureLevel }> => {
    let space = from;
    let level = pressureLevel(space, reapBelow);
    for (const relief of deps.reliefs ?? []) {
        if (level === "ok") {
            break;
        }
        const ahead = space.freeBytes;
        const removed = await relief.free(enough).catch((error: Error) => {
            deps.logger.warn({ err: error, relief: relief.name }, "storage: a disk-pressure relief failed");
            return 0;
        });
        if (removed > 0) {
            space = await deps.read();
            level = pressureLevel(space, reapBelow);
            deps.logger.info({ relief: relief.name, removed, bytes: Math.max(0, space.freeBytes - ahead), level }, "storage: the disk was still short; removed more");
        }
    }
    return { space, level };
};

const UNMEASURED: DiskPressure = { level: "ok", freeBytes: 0, totalBytes: 0, measuredAt: 0, using: [] };

export const createDiskPressureWatch = (deps: DiskPressureDeps): DiskPressureWatch => {
    let state: DiskPressure = UNMEASURED;
    // The worst level the owner was told of since the disk last had room.
    let told: DiskPressureLevel = "ok";
    const tick = async (): Promise<void> => {
        const before = await deps.read();
        const reapBelow = (await deps.reapBelow?.()) ?? REAP_BELOW;
        let space = before;
        let level = pressureLevel(before, reapBelow);
        let reaped = state.reaped;
        if (level !== "ok") {
            const enough = async (): Promise<boolean> => pressureLevel(await deps.read(), reapBelow) === "ok";
            const checkouts = await deps.reap(enough);
            if (checkouts > 0) {
                space = await deps.read();
                level = pressureLevel(space, reapBelow);
                reaped = { bytes: Math.max(0, space.freeBytes - before.freeBytes), checkouts, at: deps.now() };
                deps.logger.info({ ...reaped, level }, "storage: the disk was short; removed build output from settled checkouts");
            }
            if (level !== "ok") {
                ({ space, level } = await relieve(deps, space, reapBelow, enough));
            }
        }
        const moved = level !== state.level || reaped !== state.reaped;
        const next: DiskPressure = {
            level,
            freeBytes: space.freeBytes,
            totalBytes: space.totalBytes,
            measuredAt: deps.now(),
            using: usingOf(
                await deps.lastScan().catch((error: Error) => {
                    deps.logger.warn({ err: error }, "storage: could not read the last scan for the disk warning");
                    return undefined;
                }),
            ),
        };
        if (reaped !== undefined) {
            next.reaped = reaped;
        }
        state = next;
        if (level === "ok") {
            told = "ok";
        } else if ((level === "low" || level === "critical") && RANK[level] > RANK[told]) {
            told = level;
            deps.logger.warn({ level, freeBytes: space.freeBytes, totalBytes: space.totalBytes }, "storage: the history volume is nearly full");
            await deps.tell(level, state).catch((error: Error) => deps.logger.warn({ err: error }, "storage: could not tell the owner the disk is nearly full"));
        }
        if (moved) {
            deps.changed();
        }
    };
    return { tick, state: () => state };
};

// The one watch this daemon runs, for the route to read; undefined where no watch runs (a guest sharing the volume).
let active: DiskPressureWatch | undefined;
export const activeDiskPressure = (): DiskPressure => active?.state() ?? UNMEASURED;

const EVERY_MS = 60_000;
const WARMUP_MS = 30_000;

export const startDiskPressureWatch = (deps: DiskPressureDeps): (() => void) => {
    const watch = createDiskPressureWatch(deps);
    active = watch;
    const periodic = startPeriodic({
        warmupMs: WARMUP_MS,
        everyMs: EVERY_MS,
        run: watch.tick,
        onError: (error) => deps.logger.warn({ err: error }, "storage: the disk-pressure watch could not read the disk"),
    });
    return () => {
        periodic.dispose();
        if (active === watch) {
            active = undefined;
        }
    };
};
