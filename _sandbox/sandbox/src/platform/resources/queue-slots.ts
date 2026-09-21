import { readdir, readFile, readlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseProcStat } from "./proc-stat.js";

// Who is holding bin/queue-run's slots. A slot held by a command that hangs is otherwise invisible: the wrapper
// execs and says nothing more, the command produces no output, and the only evidence is a lock nobody reads.
// Measured: a stalled `npx` held half the pool for 26 minutes and was found by a person running `ps`.
//
// NOT /proc/locks, which is the obvious way and does not work here. Measured inside this container: a flock taken
// on a tmpfs file one line earlier never appears there, while the table still lists rows owned by pids outside the
// namespace — so a reader sees other namespaces' locks and not its own. Parsing it produces a confident empty
// answer, which is worse than no answer at all.
//
// NOR by trying to take a slot: a probe that can win one is a probe that sometimes takes a slot from a command.
//
// What is left is the descriptor. queue-run holds its slot open on fd 9 SPECIFICALLY, deliberately and for its
// own reasons (a literal low fd survives exec, an auto-allocated one would not), so one readlink per process
// answers the question with no directory walk and nothing taken.
const QUEUE_SLOT_FD = 9;

// USER_HZ, the unit /proc/<pid>/stat counts start time in. 100 on every mainstream Linux; `getconf CLK_TCK` is the
// authority and node cannot ask.
const CLOCK_TICKS_PER_SECOND = 100;

const SLOT_FILE = /^slot\.\d+$/u;
const NUMERIC = /^\d+$/u;

export interface HeldSlot {
    readonly pool: string;
    readonly slot: string;
    readonly pid: number;
    // The HOLDER's age, not the lock's, which the kernel does not timestamp. queue-run execs the command in its own
    // process, so the two differ by however long it waited for the slot before taking it.
    readonly holderAgeSeconds: number;
}

export interface QueuePoolSummary {
    // Slot FILES that exist, not the pool's configured limit: the wrapper creates one lazily as it first takes it,
    // so a pool of two that has only ever run one command at a time reports one.
    readonly slots: number;
    readonly held: number;
    readonly longestHoldSeconds: number;
}

export const queueRoot = (): string => process.env["INTENTIC_QUEUE_DIR"] ?? join(process.env["TMPDIR"] ?? tmpdir(), "intentic-queue");

// The pool and slot a descriptor points at, or nothing if it points anywhere else. Rejects a path that merely starts
// with the root's characters (`/tmp/intentic-queue-other/...`) and procfs's ` (deleted)` suffix, which names a slot
// file that has been replaced and whose lock therefore guards nothing.
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

// One row per slot, not per process: a pipeline inherits fd 9 to every member, so the command, its shell and its
// reader all point at the same slot. The oldest of them is the one that took it.
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

// Every slot currently held, across every pool. Never throws: a missing queue directory is a sandbox that has not
// run a heavy command yet, which is not a condition worth an error in a once-a-minute sample.
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

// Per pool: how many slots exist, how many are taken, and the age of the oldest holder — the one number that tells a
// stuck command apart from a busy pool.
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
