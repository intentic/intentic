import { readFile } from "node:fs/promises";
import { sleep } from "@intentic/base/async";
import { parsePressure } from "./loop-watchdog.js";

// Decides whether the sandbox has enough memory to admit a turn: reads live cgroup files instead of the periodic
// sampler snapshot, and returns a refusal as a value rather than throwing.

// cgroup v2's own files; /proc/meminfo and /proc/pressure/memory read the host, not this container.
const MEMORY_CURRENT = "/sys/fs/cgroup/memory.current";
const MEMORY_MAX = "/sys/fs/cgroup/memory.max";
const MEMORY_PRESSURE = "/sys/fs/cgroup/memory.pressure";

export interface MemoryHeadroom {
    // Undefined when uncapped or cgroup v2 is unavailable; the gate treats both as no opinion.
    readonly limitBytes: number | undefined;
    readonly usedBytes: number | undefined;
    readonly freeBytes: number | undefined;
    // Memory PSI `full avg10`: percent of the last 10s every task was stalled on memory; 0 when healthy.
    readonly stalledPercent: number;
}

// `max` means no limit; an unreadable file becomes undefined too, so unknown never reads as a small number.
const numericFile = async (path: string): Promise<number | undefined> => {
    const text = await readFile(path, "utf8").catch(() => undefined);
    if (text === undefined || text.trim() === "max") {
        return undefined;
    }
    const parsed = Number(text.trim());
    return Number.isFinite(parsed) ? parsed : undefined;
};

export const readMemoryHeadroom = async (): Promise<MemoryHeadroom> => {
    const [usedBytes, limitBytes, pressureText] = await Promise.all([
        numericFile(MEMORY_CURRENT),
        numericFile(MEMORY_MAX),
        readFile(MEMORY_PRESSURE, "utf8").catch(() => ""),
    ]);
    return {
        limitBytes,
        usedBytes,
        freeBytes: limitBytes === undefined || usedBytes === undefined ? undefined : Math.max(0, limitBytes - usedBytes),
        stalledPercent: parsePressure(pressureText)?.full ?? 0,
    };
};

const GIB = 1024 ** 3;

// Free bytes required to admit a turn; unattended turns need double, losing ties to interactive ones.
const TURN_RESERVE_BYTES = GIB;
const UNATTENDED_RESERVE_BYTES = 2 * GIB;

// Percent of full avg10 PSI at which a box counts as grinding, regardless of freeBytes.
const STALL_REFUSAL_PERCENT = 20;

const gib = (bytes: number): string => `${(bytes / GIB).toFixed(1)} GiB`;

export type TurnAdmission = { readonly admit: true } | { readonly admit: false; readonly message: string };

// Pure function of a reading, so the policy is testable without a cgroup. An unknown ceiling admits: only a measured
// box can be refused.
export const admitTurn = (headroom: MemoryHeadroom, unattended: boolean = false): TurnAdmission => {
    const { freeBytes, limitBytes, usedBytes } = headroom;
    if (freeBytes === undefined || limitBytes === undefined || usedBytes === undefined) {
        return { admit: true };
    }
    // Kept inside the measured branch: at the root cgroup, PSI belongs to the whole machine, not this sandbox.
    if (headroom.stalledPercent >= STALL_REFUSAL_PERCENT) {
        return {
            admit: false,
            message: `The sandbox is out of memory and is spending ${Math.round(headroom.stalledPercent)}% of its time waiting for it. Let a running task finish, or close some agent sessions, then send again.`,
        };
    }
    const reserve = unattended ? UNATTENDED_RESERVE_BYTES : TURN_RESERVE_BYTES;
    if (freeBytes >= reserve) {
        return { admit: true };
    }
    const used = `${gib(usedBytes)} of ${gib(limitBytes)} used`;
    return {
        admit: false,
        message: unattended
            ? `Not enough sandbox memory to start a background turn (${used}). It will run once the box has room; nothing is lost.`
            : `Not enough sandbox memory to start this turn (${used}). Close some agent sessions or let a running task finish, then send again. Raise the ceiling with SANDBOX_MEMORY if this machine has room to spare.`,
    };
};

// Holds queued work until the box has room instead of refusing it outright; on an exhausted deadline it runs anyway.
// `read` is injectable for testing without a cgroup.
export interface HeadroomWait {
    readonly admitted: boolean;
    readonly waitedMs: number;
    // Wording of the last refusal, for the log line when a run starts on an exhausted deadline.
    readonly message?: string;
}

const WAIT_INTERVAL_MS = 5_000;
const WAIT_DEADLINE_MS = 5 * 60_000;

export const waitForMemoryHeadroom = async (
    options: {
        readonly signal?: AbortSignal;
        readonly intervalMs?: number;
        readonly deadlineMs?: number;
        readonly read?: () => Promise<MemoryHeadroom>;
    } = {},
): Promise<HeadroomWait> => {
    const { signal, intervalMs = WAIT_INTERVAL_MS, deadlineMs = WAIT_DEADLINE_MS, read = readMemoryHeadroom } = options;
    const startedAt = Date.now();
    // Held to the unattended reserve: queued work loses ties to whoever is typing.
    let verdict = admitTurn(await read(), true);
    if (verdict.admit) {
        // First reading admits without touching the interval.
        return { admitted: true, waitedMs: 0 };
    }
    // oxlint-disable-next-line no-unmodified-loop-condition -- `signal.aborted` is flipped by the AbortController, not by this loop; the rule cannot see the external writer.
    while (!verdict.admit && Date.now() - startedAt < deadlineMs && signal?.aborted !== true) {
        await sleep(intervalMs, { signal });
        verdict = admitTurn(await read(), true);
    }
    const waitedMs = Date.now() - startedAt;
    return verdict.admit ? { admitted: true, waitedMs } : { admitted: false, waitedMs, message: verdict.message };
};
