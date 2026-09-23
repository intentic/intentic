import { readdir, readlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readText } from "./cgroup.js";
import { listPids, procUnits } from "./process-scan.js";
import { parseProcStat } from "./proc-stat.js";

// Holders are read off fd 9, which queue-run keeps open on its slot; /proc/locks omits this namespace's own flocks.
const QUEUE_SLOT_FD = 9;

const SLOT_FILE = /^slot\.\d+$/u;

export interface HeldSlot {
    readonly pool: string;
    readonly slot: string;
    readonly pid: number;
    // The holder process's age, not the lock's, which the kernel does not timestamp.
    readonly holderAgeSeconds: number;
}

export interface QueuePoolSummary {
    // Slot files that exist, not the pool's configured limit; the wrapper creates them lazily.
    readonly slots: number;
    readonly held: number;
    readonly longestHoldSeconds: number;
}

export const queueRoot = (): string => process.env["INTENTIC_QUEUE_DIR"] ?? join(process.env["TMPDIR"] ?? tmpdir(), "intentic-queue");

// Rejects a path that merely starts with the root's characters, and procfs's ` (deleted)` suffix, whose lock guards nothing.
export const slotFromFdTarget = (root: string, target: string): { readonly pool: string; readonly slot: string } | undefined => {
    if (!target.startsWith(`${root}/`) || target.endsWith(" (deleted)")) {
        return undefined;
    }
    const parts = target.slice(root.length + 1).split("/");
    const [pool, slot] = parts;
    if (parts.length !== 2 || pool === undefined || slot === undefined || pool === "" || !SLOT_FILE.test(slot)) {
        return undefined;
    }
    return { pool, slot };
};

const holderAgeSeconds = async (pid: number, uptimeSeconds: number, ticksPerSecond: number): Promise<number | undefined> => {
    const stat = await readText(`/proc/${pid}/stat`);
    const started = stat === undefined ? undefined : parseProcStat(stat)?.startTimeTicks;
    return started === undefined ? undefined : Math.max(0, Math.round(uptimeSeconds - started / ticksPerSecond));
};

// One row per slot: a pipeline inherits fd 9 to every member, and the oldest of them took it.
export const oldestPerSlot = (holders: readonly HeldSlot[]): HeldSlot[] => {
    const best = new Map<string, HeldSlot>();
    for (const holder of holders) {
        const key = `${holder.pool}/${holder.slot}`;
        const current = best.get(key);
        if (current === undefined || holder.holderAgeSeconds > current.holderAgeSeconds) {
            best.set(key, holder);
        }
    }
    return [...best.values()];
};

// Never throws: a missing queue directory is a sandbox that has not run a heavy command yet.
export const heldSlots = async (root = queueRoot()): Promise<HeldSlot[]> => {
    const [uptimeText, pids, { ticksPerSecond }] = await Promise.all([readText("/proc/uptime"), listPids(), procUnits()]);
    const uptimeSeconds = Number((uptimeText ?? "").trim().split(/\s+/u)[0]);
    if (!Number.isFinite(uptimeSeconds)) {
        return [];
    }
    const found = await Promise.all(
        pids.map(async (pid): Promise<HeldSlot | undefined> => {
            const target = await readlink(`/proc/${pid}/fd/${QUEUE_SLOT_FD}`).catch(() => undefined);
            const slot = target === undefined ? undefined : slotFromFdTarget(root, target);
            if (slot === undefined) {
                return undefined;
            }
            const age = await holderAgeSeconds(pid, uptimeSeconds, ticksPerSecond);
            return age === undefined ? undefined : { ...slot, pid, holderAgeSeconds: age };
        }),
    );
    return oldestPerSlot(found.filter((slot) => slot !== undefined));
};

export const poolSlotCounts = async (root = queueRoot()): Promise<ReadonlyMap<string, number>> => {
    const pools = await readdir(root, { withFileTypes: true }).catch(() => []);
    const counts = new Map<string, number>();
    await Promise.all(
        pools
            .filter((entry) => entry.isDirectory())
            .map(async (pool) => {
                const names = await readdir(join(root, pool.name)).catch(() => [] as string[]);
                counts.set(pool.name, names.filter((name) => SLOT_FILE.test(name)).length);
            }),
    );
    return counts;
};

// The oldest holder's age is the number that tells a stuck command from a busy pool.
export const summarisePools = (slotCounts: ReadonlyMap<string, number>, held: readonly HeldSlot[]): Record<string, QueuePoolSummary> => {
    const summary: Record<string, QueuePoolSummary> = {};
    for (const [pool, slots] of slotCounts) {
        const mine = held.filter((slot) => slot.pool === pool);
        summary[pool] = {
            slots,
            held: mine.length,
            longestHoldSeconds: mine.reduce((longest, slot) => Math.max(longest, slot.holderAgeSeconds), 0),
        };
    }
    return summary;
};

export const queueSnapshot = async (root = queueRoot()): Promise<Record<string, QueuePoolSummary>> => {
    const [held, counts] = await Promise.all([heldSlots(root), poolSlotCounts(root)]);
    return summarisePools(counts, held);
};
