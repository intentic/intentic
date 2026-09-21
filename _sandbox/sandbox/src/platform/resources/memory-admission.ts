import { readFile } from "node:fs/promises";
import { sleep } from "@intentic/base/async";
import { parsePressure } from "./loop-watchdog.js";

// Decides whether the sandbox has enough memory to admit a turn: reads live cgroup files instead of the periodic
// sampler snapshot, and returns a refusal as a value rather than throwing.

// cgroup v2's own files; /proc/meminfo and /proc/pressure/memory read the host, not this container.
const MEMORY_CURRENT = "/sys/fs/cgroup/memory.current";
const MEMORY_MAX = "/sys/fs/cgroup/memory.max";
const MEMORY_PRESSURE = "/sys/fs/cgroup/memory.pressure";
// Anon this cgroup has pushed to swap. Charged HERE and not to memory.current, which is the whole reason this file
// reads it: see the `usedBytes` note below.
const MEMORY_SWAP_CURRENT = "/sys/fs/cgroup/memory.swap.current";

export interface MemoryHeadroom {
    // Undefined when uncapped or cgroup v2 is unavailable; the gate treats both as no opinion.
    readonly limitBytes: number | undefined;
    // Resident + swapped, not memory.current alone, so paging cannot read as relief. A sandbox runs with
    // `--memory-swap -1` (sandbox-run/src/index.ts), so a page pushed to swap leaves memory.current and lands in
    // memory.swap.current: measuring only the first makes freeBytes RISE as the box begins to thrash, which is the
    // one moment this gate exists to catch. Measured on a 16 GiB cap: 12.4 resident + 6.8 swapped reported 3.6 GiB
    // free and admitted every turn while the machine had 350 MB and was paging at 230 MB/s.
    readonly usedBytes: number | undefined;
    // The swapped half of `usedBytes`, kept apart only so a refusal can name it; 0 when swap is off or unaccounted.
    readonly swapBytes: number;
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

export interface MemoryReading {
    // memory.current: the cgroup's RESIDENT charge, which excludes everything it has paged out.
    readonly residentBytes: number | undefined;
    readonly limitBytes: number | undefined;
    // memory.swap.current; `undefined` is an unaccounted swap, read as none.
    readonly swapBytes: number | undefined;
    readonly pressureText: string;
}

// Pure function of a reading, for the same reason `admitTurn` below is one: the arithmetic swap broke is the part
// worth testing, and a cgroup is not something a unit test can stage.
export const headroomFrom = ({ residentBytes, limitBytes, swapBytes, pressureText }: MemoryReading): MemoryHeadroom => {
    // An unreadable swap file is 0, never `undefined`: swap being unaccounted (cgroup v1, swapaccount off) must not
    // turn a box with a measurable ceiling into one with no opinion — that would widen the hole instead of closing it.
    const swapped = swapBytes ?? 0;
    const usedBytes = residentBytes === undefined ? undefined : residentBytes + swapped;
    return {
        limitBytes,
        usedBytes,
        swapBytes: swapped,
        freeBytes: limitBytes === undefined || usedBytes === undefined ? undefined : Math.max(0, limitBytes - usedBytes),
        stalledPercent: parsePressure(pressureText)?.full ?? 0,
    };
};

export const readMemoryHeadroom = async (): Promise<MemoryHeadroom> => {
    const [residentBytes, limitBytes, swapBytes, pressureText] = await Promise.all([
        numericFile(MEMORY_CURRENT),
        numericFile(MEMORY_MAX),
        numericFile(MEMORY_SWAP_CURRENT),
        readFile(MEMORY_PRESSURE, "utf8").catch(() => ""),
    ]);
    return headroomFrom({ residentBytes, limitBytes, swapBytes, pressureText });
};

const GIB = 1024 ** 3;

// Free bytes required to admit a turn; unattended turns need double, losing ties to interactive ones.
const TURN_RESERVE_BYTES = GIB;
const UNATTENDED_RESERVE_BYTES = 2 * GIB;

// Percent of full avg10 PSI at which a box counts as grinding, regardless of freeBytes.
const STALL_REFUSAL_PERCENT = 20;

const gib = (bytes: number): string => `${(bytes / GIB).toFixed(1)} GiB`;

// The reading a refusal was decided on, carried so a client can offer to raise the cap instead of only restating the
// sentence. Absent on the stall refusal: PSI says the box is grinding, not that its ceiling is the thing to move.
export interface RefusedMemory {
    readonly limitBytes: number;
    readonly residentBytes: number;
    readonly swapBytes: number;
}

export type TurnAdmission = { readonly admit: true } | { readonly admit: false; readonly message: string; readonly memory?: RefusedMemory };

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
    // Named apart once paging has started, because the sum alone can exceed the cap — the cgroup's ceiling bounds
    // resident pages, not the anon it has pushed to swap — and "19.2 GiB of 16.0 GiB used" reads as a bug rather than
    // as the diagnosis it is.
    const used =
        headroom.swapBytes > 0
            ? `${gib(usedBytes - headroom.swapBytes)} resident + ${gib(headroom.swapBytes)} swapped, against ${gib(limitBytes)}`
            : `${gib(usedBytes)} of ${gib(limitBytes)} used`;
    return {
        admit: false,
        // The reading rides along so the client can offer the raise as a press. The sentence stops naming
        // SANDBOX_MEMORY: that is the headless spelling, and a reader at a composer has a control for this.
        memory: { limitBytes, residentBytes: usedBytes - headroom.swapBytes, swapBytes: headroom.swapBytes },
        message: unattended
            ? `Not enough sandbox memory to start a background turn (${used}). It will run once the box has room; nothing is lost.`
            : `Not enough sandbox memory to start this turn (${used}). Close some agent sessions or let a running task finish, then send again — or raise the sandbox's memory, if this machine has room to spare.`,
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
    // oxlint-disable-next-line no-unmodified-loop-condition -- AbortController changes signal.aborted.
    while (!verdict.admit && Date.now() - startedAt < deadlineMs && signal?.aborted !== true) {
        await sleep(intervalMs, { signal });
        verdict = admitTurn(await read(), true);
    }
    const waitedMs = Date.now() - startedAt;
    return verdict.admit ? { admitted: true, waitedMs } : { admitted: false, waitedMs, message: verdict.message };
};
