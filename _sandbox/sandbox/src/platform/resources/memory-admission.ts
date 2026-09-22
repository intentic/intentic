import { readFile } from "node:fs/promises";
import { sleep } from "@intentic/base/async";
import { parsePressure } from "./loop-watchdog.js";

// Decides what a turn meets on a sandbox short of memory: reads live cgroup files instead of the periodic sampler
// snapshot, and returns a hold as a value rather than throwing. A person is warned, never stopped; background work waits.

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
    // The swapped half of `usedBytes`, kept apart only so a hold can name it; 0 when swap is off or unaccounted.
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

// Free bytes a turn needs to start unasked; unattended turns need double, losing ties to interactive ones.
const TURN_RESERVE_BYTES = GIB;
const UNATTENDED_RESERVE_BYTES = 2 * GIB;

// Percent of full avg10 PSI at which a box counts as grinding, regardless of freeBytes.
const STALL_PERCENT = 20;

const gib = (bytes: number): string => `${(bytes / GIB).toFixed(1)} GiB`;

// The reading a hold was decided on, so a client can offer to raise the cap. Absent on a stall: PSI says the box is
// grinding, not that its ceiling is the thing to move.
export interface ShortMemory {
    readonly limitBytes: number;
    readonly residentBytes: number;
    readonly swapBytes: number;
}

// What is short about a box, in words and as the reading behind them; undefined when it has the reserve free.
interface Shortfall {
    readonly diagnosis: string;
    readonly memory?: ShortMemory;
}

// An unknown ceiling has no opinion: only a measured box can come up short.
const shortfallOf = (headroom: MemoryHeadroom, reserveBytes: number): Shortfall | undefined => {
    const { freeBytes, limitBytes, usedBytes, swapBytes } = headroom;
    if (freeBytes === undefined || limitBytes === undefined || usedBytes === undefined) {
        return undefined;
    }
    // Inside the measured branch: at the root cgroup, PSI belongs to the whole machine, not this sandbox.
    if (headroom.stalledPercent >= STALL_PERCENT) {
        return {
            diagnosis: `The sandbox is short of memory: for ${Math.round(headroom.stalledPercent)}% of the last ten seconds, everything in it was waiting on memory`,
        };
    }
    if (freeBytes >= reserveBytes) {
        return undefined;
    }
    // Resident and swapped are named apart once paging starts: the cap bounds resident pages only, so their sum can
    // exceed it, and "19.2 GiB of 16.0 GiB used" reads as a bug.
    const used =
        swapBytes > 0
            ? `${gib(usedBytes - swapBytes)} resident + ${gib(swapBytes)} swapped, against ${gib(limitBytes)}`
            : `${gib(usedBytes)} of ${gib(limitBytes)} used`;
    return {
        diagnosis: `Sandbox memory is low: ${used}`,
        memory: { limitBytes, residentBytes: usedBytes - swapBytes, swapBytes },
    };
};

export type TurnAdmission = { readonly admit: true } | { readonly admit: false; readonly message: string; readonly memory?: ShortMemory };

// What the person deciding whether to go ahead is risking; the sentence states the stakes and leaves the choice to them.
const STAKES = "Starting another agent now can slow the running ones down, and if memory runs out, the system kills processes to free it.";

// The box's own verdict for one audience, pure so the policy is testable without a cgroup. Whether a person is asked
// at all is MemoryWarnings' call, not this one's.
export const admitTurn = (headroom: MemoryHeadroom, unattended: boolean = false): TurnAdmission => {
    const short = shortfallOf(headroom, unattended ? UNATTENDED_RESERVE_BYTES : TURN_RESERVE_BYTES);
    if (short === undefined) {
        return { admit: true };
    }
    return {
        admit: false,
        message: unattended
            ? `${short.diagnosis}. This background turn did not start: turns people send get the room first.`
            : `${short.diagnosis}. ${STAKES}`,
        ...(short.memory === undefined ? {} : { memory: short.memory }),
    };
};

// A person's turn on a short box is held once per spell, so they can decide, and admitted from then on, because the
// decision is theirs. The spell ends at the first reading with room for a person's turn. Held in memory only: a restart
// is a fresh spell.
export interface MemoryWarnings {
    readonly admit: (headroom: MemoryHeadroom, turn: { readonly unattended: boolean; readonly actor: string | undefined }) => TurnAdmission;
}

export const createMemoryWarnings = (): MemoryWarnings => {
    // Who has been told this spell, by actor; "" is a caller the daemon could not name.
    const warned = new Set<string>();
    return {
        admit: (headroom, { unattended, actor }) => {
            const person = admitTurn(headroom);
            if (person.admit) {
                warned.clear();
            }
            // Nobody is there to be told, so background work is refused on every short reading, and never warns anyone.
            if (unattended) {
                return admitTurn(headroom, true);
            }
            // Keyed by person: one member's choice to go ahead does not answer for another who has not been told.
            const who = actor ?? "";
            if (person.admit || warned.has(who)) {
                return { admit: true };
            }
            warned.add(who);
            return person;
        },
    };
};

// Holds queued work until the box has room instead of refusing it outright; on an exhausted deadline it runs anyway.
// `read` is injectable for testing without a cgroup.
export interface HeadroomWait {
    readonly admitted: boolean;
    readonly waitedMs: number;
    // What was still short at the deadline, for the log line when the run starts anyway.
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
    let short = shortfallOf(await read(), UNATTENDED_RESERVE_BYTES);
    if (short === undefined) {
        // First reading admits without touching the interval.
        return { admitted: true, waitedMs: 0 };
    }
    // oxlint-disable-next-line no-unmodified-loop-condition -- AbortController changes signal.aborted.
    while (short !== undefined && Date.now() - startedAt < deadlineMs && signal?.aborted !== true) {
        await sleep(intervalMs, { signal });
        short = shortfallOf(await read(), UNATTENDED_RESERVE_BYTES);
    }
    const waitedMs = Date.now() - startedAt;
    return short === undefined ? { admitted: true, waitedMs } : { admitted: false, waitedMs, message: short.diagnosis };
};
