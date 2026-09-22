import { readdir, readFile, readlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseProcStat } from "./proc-stat.js";

// Holders are read off fd 9, which queue-run keeps open on its slot; /proc/locks omits this namespace's own flocks.
const QUEUE_SLOT_FD = 9;

// USER_HZ, the unit /proc/<pid>/stat counts start time in; node cannot ask `getconf CLK_TCK`.
const CLOCK_TICKS_PER_SECOND = 100;

const SLOT_FILE = /^slot\.\d+$/u;
const NUMERIC = /^\d+$/u;

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

const holderAgeSeconds = async (pid: number, uptimeSeconds: number): Promise<number | undefined> => {
    const started = await readFile(`/proc/${pid}/stat`, "utf8")
        .then(parseProcStat)
        .catch(() => undefined);
    if (started?.startTimeTicks === undefined) {
        return undefined;
    }
    return Math.max(0, Math.round(uptimeSeconds - started.startTimeTicks / CLOCK_TICKS_PER_SECOND));
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
    const [uptimeText, entries] = await Promise.all([readFile("/proc/uptime", "utf8").catch(() => ""), readdir("/proc").catch(() => [] as string[])]);
    const uptimeSeconds = Number(uptimeText.trim().split(/\s+/u)[0]);
    if (!Number.isFinite(uptimeSeconds)) {
        return [];
    }
    const found = await Promise.all(
        entries
            .filter((entry) => NUMERIC.test(entry))
            .map(async (entry): Promise<HeldSlot | undefined> => {
                const pid = Number(entry);
                const target = await readlink(`/proc/${pid}/fd/${QUEUE_SLOT_FD}`).catch(() => undefined);
                const slot = target === undefined ? undefined : slotFromFdTarget(root, target);
                if (slot === undefined) {
                    return undefined;
                }
                const age = await holderAgeSeconds(pid, uptimeSeconds);
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
