import { access, readdir, readlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readText } from "./cgroup.js";
import { listPids, procUnits } from "./process-scan.js";
import { parseProcStat } from "./proc-stat.js";

// Holders are read off fd 9, which queue-run keeps open on its slot; /proc/locks omits this namespace's own flocks.
const QUEUE_SLOT_FD = 9;

const SLOT_FILE = /^slot\.\d+$/u;
const WAIT_FILE = /^wait\.(\d+)$/u;

// How many holders and waiters one pool lists: enough to name who is in the way, not a census of a pile-up.
const LISTED = 4;
// What one wait file or state.json may weigh before it is read as garbage rather than parsed.
const QUEUE_FILE_BYTES = 64_000;

// A holder's command line is kept to this many characters: enough to name it, not a pasted script.
const HOLDER_COMMAND_CHARS = 120;

export interface HeldSlot {
    readonly pool: string;
    readonly slot: string;
    readonly pid: number;
    // The holder process's age, not the lock's, which the kernel does not timestamp.
    readonly holderAgeSeconds: number;
    // Its argv joined by spaces, capped; undefined once the process is gone or unreadable.
    readonly command: string | undefined;
    // Where it runs, as this namespace resolves /proc/<pid>/cwd.
    readonly cwd: string | undefined;
    // How long its own rule lets it hold the slot (queue-run's INTENTIC_QUEUE_MAX_HOLD); 0 is forever, undefined unknown.
    readonly maxHoldSeconds?: number | undefined;
    // The conversation that ran it (INTENTIC_TURN_OWNER) and the heavy rule that queued it (INTENTIC_HEAVY_HELD).
    readonly conversation?: string | undefined;
    readonly rule?: string | undefined;
}

// Who holds a pool's longest-held slot, so a stuck pool names its command.
export type QueueHolder = Pick<HeldSlot, "pid" | "command" | "cwd" | "maxHoldSeconds">;

// One holder as a pool lists it: who, for which conversation, under which rule, for how long.
export interface QueueHolderRow {
    readonly slot: string;
    readonly pid: number;
    readonly holdSeconds: number;
    readonly conversation: string | undefined;
    readonly rule: string | undefined;
    readonly command: string | undefined;
}

// One command waiting for a slot, as its `wait.<pid>` file (bin/queue-run) names it.
export interface QueueWaiter {
    readonly pid: number;
    readonly label: string | undefined;
    readonly conversation: string | undefined;
    readonly waitSeconds: number;
    readonly command: string | undefined;
}

interface HolderEnv {
    readonly maxHoldSeconds: number | undefined;
    readonly conversation: string | undefined;
    readonly rule: string | undefined;
}

const nonEmpty = (value: string | undefined): string | undefined => (value === undefined || value === "" ? undefined : value);

// What queue-run and the heavy-turn hook stamped into the holder's environment, fixed at exec like every stamp.
const holderEnv = async (pid: number): Promise<HolderEnv> => {
    const entries = (await readText(`/proc/${pid}/environ`))?.split("\0") ?? [];
    const read = (name: string): string | undefined => entries.find((entry) => entry.startsWith(`${name}=`))?.slice(name.length + 1);
    const stamped = read("INTENTIC_QUEUE_MAX_HOLD");
    const value = Number(stamped);
    return {
        maxHoldSeconds: stamped !== undefined && stamped !== "" && Number.isInteger(value) && value >= 0 ? value : undefined,
        conversation: nonEmpty(read("INTENTIC_TURN_OWNER")),
        rule: nonEmpty(read("INTENTIC_HEAVY_HELD")),
    };
};

export interface QueuePoolSummary {
    // Slot files that exist, not the pool's configured limit; the wrapper creates them lazily.
    readonly slots: number;
    readonly held: number;
    readonly longestHoldSeconds: number;
    // Absent exactly when nothing is held.
    readonly longestHolder?: QueueHolder;
    // Every holder, oldest first, at most LISTED of them; absent when nothing is held.
    readonly holders?: readonly QueueHolderRow[];
    // Commands queued behind the held slots. Always present, so 0 reads as measured.
    readonly waiting: number;
    readonly longestWaitSeconds: number;
    // The longest waiters first, at most LISTED; absent when nothing waits.
    readonly waiters?: readonly QueueWaiter[];
}

// bin/queue-run's own default, from the daemon's side: the one directory every turn's heavy commands lock in, and the
// one a fenced turn is told to lock in (turn-sandbox.ts).
export const queueRoot = (env: NodeJS.ProcessEnv = process.env): string =>
    env["INTENTIC_QUEUE_DIR"] ?? join(env["TMPDIR"] ?? tmpdir(), "intentic-queue");

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

// /proc/<pid>/cmdline separates argv with NULs and ends with one.
const holderCommand = async (pid: number): Promise<string | undefined> => {
    const argv = (await readText(`/proc/${pid}/cmdline`))?.split("\0").filter((arg) => arg !== "");
    return argv === undefined || argv.length === 0 ? undefined : argv.join(" ").slice(0, HOLDER_COMMAND_CHARS);
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
export const heldSlots = async (root = queueRoot(), stateHolders: ReadonlyMap<number, StateHolder> = new Map()): Promise<HeldSlot[]> => {
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
            // A waiter opens a slot for the instant it tries its lock, and is no holder (queue-run reads it the same way).
            if (await exists(join(root, slot.pool, `wait.${pid}`))) {
                return undefined;
            }
            const [age, command, cwd, env] = await Promise.all([
                holderAgeSeconds(pid, uptimeSeconds, ticksPerSecond),
                holderCommand(pid),
                readlink(`/proc/${pid}/cwd`).catch(() => undefined),
                holderEnv(pid),
            ]);
            // An environment this namespace cannot read still has the identity the latest waiter wrote down.
            const written = stateHolders.get(pid);
            return age === undefined
                ? undefined
                : {
                      ...slot,
                      pid,
                      holderAgeSeconds: age,
                      command,
                      cwd,
                      maxHoldSeconds: env.maxHoldSeconds,
                      conversation: env.conversation ?? written?.conversation,
                      rule: env.rule ?? written?.rule,
                  };
        }),
    );
    return oldestPerSlot(found.filter((slot) => slot !== undefined));
};

const exists = (path: string): Promise<boolean> =>
    access(path).then(
        () => true,
        () => false,
    );

const readJson = async (path: string): Promise<unknown> => {
    const raw = await readText(path);
    if (raw === undefined || raw.length > QUEUE_FILE_BYTES) {
        return undefined;
    }
    try {
        return JSON.parse(raw) as unknown;
    } catch {
        // allow(silent-catch): a half-written or planted queue file says nothing, which is what the caller asks
        return undefined;
    }
};

const field = (value: unknown, key: string): unknown =>
    typeof value === "object" && value !== null ? (value as Record<string, unknown>)[key] : undefined;
const text = (value: unknown, key: string): string | undefined => {
    const found = field(value, key);
    return typeof found === "string" ? nonEmpty(found.trim()) : undefined;
};
const wholeNumber = (value: unknown, key: string): number | undefined => {
    const found = field(value, key);
    return typeof found === "number" && Number.isInteger(found) && found >= 0 ? found : undefined;
};

// A waiter as queue-run writes it: {pid, label, conversation, since (epoch seconds), command}. Anything else is dropped.
export const parseWaiter = (value: unknown, nowSeconds: number): QueueWaiter | undefined => {
    const pid = wholeNumber(value, "pid");
    const since = wholeNumber(value, "since");
    if (pid === undefined || pid === 0 || since === undefined) {
        return undefined;
    }
    return {
        pid,
        label: text(value, "label"),
        conversation: text(value, "conversation"),
        waitSeconds: Math.max(0, nowSeconds - since),
        command: text(value, "command")?.slice(0, HOLDER_COMMAND_CHARS),
    };
};

export interface StateHolder {
    readonly conversation: string | undefined;
    readonly rule: string | undefined;
}

export interface PoolQueueFiles {
    readonly waiters: readonly QueueWaiter[];
    // Holder identities by pid, as the latest waiter wrote them into state.json.
    readonly holders: ReadonlyMap<number, StateHolder>;
}

// A waiter's file outlives a waiter killed with SIGKILL, and state.json is only as fresh as its last writer, so every
// waiter is kept only while its pid is still alive.
const alive = (pid: number): Promise<boolean> => exists(`/proc/${pid}`);

// One pool's `wait.<pid>` files and `state.json` (bin/queue-run). Never throws: either may be absent, half-written or
// planted, and each is then read as saying nothing.
export const poolQueueFiles = async (poolDir: string, nowSeconds = Math.floor(Date.now() / 1000)): Promise<PoolQueueFiles> => {
    const names = await readdir(poolDir).catch(() => [] as string[]);
    const state = await readJson(join(poolDir, "state.json"));
    const fromFiles = await Promise.all(
        names.filter((name) => WAIT_FILE.test(name)).map(async (name) => parseWaiter(await readJson(join(poolDir, name)), nowSeconds)),
    );
    const fromState = (Array.isArray(field(state, "waiters")) ? (field(state, "waiters") as unknown[]) : []).map((entry) =>
        parseWaiter(entry, nowSeconds),
    );
    // A wait file is the waiter's own word and current; state.json only fills in one whose file could not be read.
    const byPid = new Map<number, QueueWaiter>();
    for (const waiter of [...fromFiles, ...fromState]) {
        if (waiter !== undefined && !byPid.has(waiter.pid)) {
            byPid.set(waiter.pid, waiter);
        }
    }
    const living = await Promise.all([...byPid.values()].map(async (waiter) => ((await alive(waiter.pid)) ? waiter : undefined)));
    const holders = new Map<number, StateHolder>();
    for (const entry of Array.isArray(field(state, "holders")) ? (field(state, "holders") as unknown[]) : []) {
        const pid = wholeNumber(entry, "pid");
        if (pid !== undefined) {
            holders.set(pid, { conversation: text(entry, "conversation"), rule: text(entry, "rule") });
        }
    }
    return { waiters: living.filter((waiter) => waiter !== undefined), holders };
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

// The oldest holder's age is the number that tells a stuck command from a busy pool, and its command says which; the
// waiters say what the hold is costing.
export const summarisePools = (
    slotCounts: ReadonlyMap<string, number>,
    held: readonly HeldSlot[],
    waitersByPool: ReadonlyMap<string, readonly QueueWaiter[]> = new Map(),
): Record<string, QueuePoolSummary> => {
    const summary: Record<string, QueuePoolSummary> = {};
    for (const [pool, slots] of slotCounts) {
        const mine = held.filter((slot) => slot.pool === pool);
        const oldestFirst = [...mine].sort((a, b) => b.holderAgeSeconds - a.holderAgeSeconds);
        const waiters = [...(waitersByPool.get(pool) ?? [])].sort((a, b) => b.waitSeconds - a.waitSeconds);
        const longest = mine.reduce<HeldSlot | undefined>(
            (oldest, slot) => (oldest === undefined || slot.holderAgeSeconds > oldest.holderAgeSeconds ? slot : oldest),
            undefined,
        );
        summary[pool] = {
            slots,
            held: mine.length,
            longestHoldSeconds: longest?.holderAgeSeconds ?? 0,
            ...(longest === undefined
                ? {}
                : { longestHolder: { pid: longest.pid, command: longest.command, cwd: longest.cwd, maxHoldSeconds: longest.maxHoldSeconds } }),
            ...(oldestFirst.length === 0
                ? {}
                : {
                      holders: oldestFirst.slice(0, LISTED).map((slot) => ({
                          slot: slot.slot,
                          pid: slot.pid,
                          holdSeconds: slot.holderAgeSeconds,
                          conversation: slot.conversation,
                          rule: slot.rule,
                          command: slot.command,
                      })),
                  }),
            waiting: waiters.length,
            longestWaitSeconds: waiters[0]?.waitSeconds ?? 0,
            ...(waiters.length === 0 ? {} : { waiters: waiters.slice(0, LISTED) }),
        };
    }
    return summary;
};

export const queueSnapshot = async (root = queueRoot()): Promise<Record<string, QueuePoolSummary>> => {
    const counts = await poolSlotCounts(root);
    const files = new Map(await Promise.all([...counts.keys()].map(async (pool) => [pool, await poolQueueFiles(join(root, pool))] as const)));
    const stateHolders = new Map([...files.values()].flatMap((pool) => [...pool.holders]));
    const held = await heldSlots(root, stateHolders);
    return summarisePools(counts, held, new Map([...files].map(([pool, read]) => [pool, read.waiters])));
};
